const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const Database = require('better-sqlite3')
const root = path.resolve(__dirname, '..')
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-outbox-'))
  const cache = new Map()
  const behavior = { rows: [], appends: 0, appendError: null, readError: null, afterAppend: null }
  const dbModule = { isVercel: false, getLocalDb: () => new Database(path.join(dir, 'atelier.db')) }
  const load = relative => {
    const filename = path.resolve(root, relative)
    if (cache.has(filename)) return cache.get(filename)
    const exports = {}; cache.set(filename, exports)
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInNewContext(source, { exports, process: { env: { GOOGLE_SHEETS_ID: 'synthetic-sheet' }, cwd: () => dir }, crypto: globalThis.crypto, console, setTimeout, clearTimeout, require: name => {
      if (name === 'server-only') return {}
      if (name === '@/lib/api-auth') return { authorizeRequest: async () => ({session:{googleSub:behavior.owner ?? 'owner'}}) }
      if (name === '@/lib/db') return dbModule
      if (name === '@/lib/sheets') return {
        findOutreachRow: async id => { if (behavior.readError) throw behavior.readError; return behavior.rows.find(row => row.id === id)?.range ?? null },
        appendOutreachRow: async (payload, id, destination, acceptedAt, beforeWrite) => { if (!await beforeWrite()) return null; behavior.appends++; if (behavior.afterAppend) await behavior.afterAppend(id); if (behavior.appendError) throw behavior.appendError; behavior.rows.push({ id, range: 'Sheet1!A2:S2' }); return 'Sheet1!A2:S2' },
      }
      if (name.startsWith('@/')) return load(name.slice(2) + '.ts')
      if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), name)) + '.ts')
      return require(name)
    } }, { filename })
    return exports
  }
  const schema = load('lib/db.ts'); dbModule.initialiseDb=schema.initialiseDb; await schema.initialiseDb()
  return { load, behavior, db: dbModule.getLocalDb, close: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
test('Gmail acceptance and export enqueue commit together; repeats create one event', async () => {
  const f = await fixture(); const db = f.db()
  try {
    const columns = db.prepare('PRAGMA table_info(send_records)').all().map(row => row.name)
    assert.ok(columns.includes('pipeline_payload'), 'the frozen export must exist before sending')
    db.prepare(`INSERT INTO send_records(owner_google_sub,owner_email,request_id,payload_hash,status,pipeline_payload) VALUES ('owner','owner@example.invalid','synthetic-request','hash','sending',?)`).run(JSON.stringify({ brand_name: 'Synthetic' }))
    assert.equal(db.prepare('SELECT count(*) AS n FROM outreach_exports').get().n, 0)
    db.prepare("UPDATE send_records SET status='accepted',gmail_message_id='synthetic-message'").run()
    db.prepare("UPDATE send_records SET status='accepted'").run()
    const rows = db.prepare('SELECT * FROM outreach_exports').all()
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'pending'); assert.equal(rows[0].gmail_message_id, 'synthetic-message')
  } finally { db.close(); f.close() }
})

async function accepted(f, owner = 'owner') {
  const db = f.db()
  try {
    const row = db.prepare(`INSERT INTO send_records(owner_google_sub,owner_email,request_id,payload_hash,status,pipeline_payload) VALUES (?,'owner@example.invalid',?,'hash','sending',?)`).run(owner, crypto.randomUUID(), JSON.stringify({ brand_name:'Synthetic',to_email:'recipient@example.invalid',email_subject:'Synthetic' }))
    db.prepare("UPDATE send_records SET status='accepted',gmail_message_id='synthetic-message' WHERE id=?").run(row.lastInsertRowid)
    return db.prepare('SELECT outreach_id FROM outreach_exports WHERE source_key=?').get(`immediate:${row.lastInsertRowid}`).outreach_id
  } finally { db.close() }
}
test('an enqueue failure rolls back Gmail acceptance persistence', async () => {
  const f=await fixture();const db=f.db();try {
    db.prepare(`INSERT INTO send_records(owner_google_sub,owner_email,request_id,payload_hash,status,pipeline_payload) VALUES ('owner','owner@example.invalid','synthetic','hash','sending','{}')`).run()
    db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON outreach_exports BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    assert.throws(()=>db.prepare("UPDATE send_records SET status='accepted',gmail_message_id='synthetic-id'").run())
    assert.equal(db.prepare('SELECT status FROM send_records').get().status,'sending')
  }finally{db.close();f.close()}
})
test('failed, uncertain and legacy scheduled rows never produce accepted exports',async()=>{
 const f=await fixture();const db=f.db();try{
  db.prepare(`INSERT INTO send_records(owner_google_sub,owner_email,request_id,payload_hash,status,pipeline_payload) VALUES ('owner','owner@example.invalid','synthetic','hash','sending','{}')`).run()
  for(const status of ['failed','failed_auth','needs_review']) db.prepare('UPDATE send_records SET status=?').run(status)
  db.prepare(`INSERT INTO scheduled_emails(to_email,subject,body,scheduled_at,delivery_status,pipeline_payload) VALUES ('recipient@example.invalid','Synthetic','Synthetic',datetime('now'),'legacy_quarantined','{}')`).run()
  assert.equal(db.prepare('SELECT count(*) AS n FROM outreach_exports').get().n,0)
 }finally{db.close();f.close()}
})
test('scheduled acceptance uses the same durable export queue',async()=>{
 const f=await fixture();const db=f.db();try{
  db.prepare(`INSERT INTO scheduled_emails(to_email,subject,body,scheduled_at,delivery_status,owner_google_sub,pipeline_payload) VALUES ('recipient@example.invalid','Synthetic','Synthetic',datetime('now'),'sending','owner','{}')`).run()
  db.prepare("UPDATE scheduled_emails SET delivery_status='sent',gmail_message_id='scheduled-id'").run()
  assert.equal(db.prepare('SELECT source_key FROM outreach_exports').get().source_key,'scheduled:1')
 }finally{db.close();f.close()}
})
test('concurrent export retries append exactly once and enforce owner scope',async()=>{
 const f=await fixture();try{
  const id=await accepted(f);const outbox=f.load('lib/outreach-outbox.ts')
  assert.equal(await outbox.syncPipelineExport(id,'other'),null)
  await Promise.all(Array.from({length:12},()=>outbox.syncPipelineExport(id,'owner')))
  assert.equal(f.behavior.appends,1);assert.equal(await outbox.exportStatus(id,'owner'),'synced')
  await outbox.syncPipelineExport(id,'owner');assert.equal(f.behavior.appends,1)
 }finally{f.close()}
})
test('lost append acknowledgement is reconciled by ID without another append',async()=>{
 const f=await fixture();try{
  const id=await accepted(f);const outbox=f.load('lib/outreach-outbox.ts')
  f.behavior.afterAppend=async id=>f.behavior.rows.push({id,range:'Sheet1!A2:S2'})
  f.behavior.appendError=new Error('lost response')
  assert.equal(await outbox.syncPipelineExport(id,'owner'),'needs_review')
  f.behavior.appendError=null
  assert.equal(await outbox.syncPipelineExport(id,'owner'),'synced');assert.equal(f.behavior.appends,1)
 }finally{f.close()}
})
test('absence after an uncertain append does not authorize a second append',async()=>{
 const f=await fixture();try{
  const id=await accepted(f);const outbox=f.load('lib/outreach-outbox.ts');f.behavior.appendError=new Error('unknown')
  await outbox.syncPipelineExport(id,'owner');f.behavior.appendError=null
  for(let i=0;i<3;i++)assert.equal(await outbox.syncPipelineExport(id,'owner'),'needs_review')
  assert.equal(f.behavior.appends,1)
 }finally{f.close()}
})
test('pre-append read failure safely retries after credentials or Sheets recover',async()=>{
 const f=await fixture();try{
  const id=await accepted(f);const outbox=f.load('lib/outreach-outbox.ts');f.behavior.readError=new Error('read unavailable')
  assert.equal(await outbox.syncPipelineExport(id,'owner'),'failed');assert.equal(f.behavior.appends,0)
  f.behavior.readError=null;assert.equal(await outbox.syncPipelineExport(id,'owner'),'synced');assert.equal(f.behavior.appends,1)
 }finally{f.close()}
})
test('interrupted preparation can retry; interrupted appends can only reconcile',async()=>{
 const f=await fixture();const db=f.db();try{
  const id=await accepted(f);const outbox=f.load('lib/outreach-outbox.ts')
  db.prepare("UPDATE outreach_exports SET status='claimed',claimed_at=datetime('now','-10 minutes'),claim_token='old'").run()
  await outbox.recoverPipelineExports();assert.equal(await outbox.exportStatus(id,'owner'),'failed')
  db.prepare("UPDATE outreach_exports SET status='writing',write_intent_at=datetime('now','-10 minutes'),claimed_at=datetime('now','-10 minutes'),claim_token='old',destination_id='synthetic-sheet'").run()
  await outbox.recoverPipelineExports();assert.equal(await outbox.exportStatus(id,'owner'),'needs_review')
  await outbox.syncPipelineExport(id,'owner');assert.equal(f.behavior.appends,0)
 }finally{db.close();f.close()}
})
test('snapshots exclude credentials, BCC, attachments and unneeded nested fields',async()=>{
 const f=await fixture();try{
  const outbox=f.load('lib/outreach-outbox.ts')
  const snapshot=JSON.parse(outbox.pipelineSnapshot({brand_name:'Synthetic',bcc:'private@example.invalid',attachments:['private'],credential_ciphertext:'private',retailers:[{name:'Synthetic retailer',private:'private'}],signals:[{type:'growth',private:'private'}]}))
  assert.equal(JSON.stringify(snapshot).includes('private'),false)
 }finally{f.close()}
})
test('repeated schema initialization preserves events and quarantined rows',async()=>{
 const f=await fixture();try{
  const id=await accepted(f);await f.load('lib/db.ts').initialiseDb();await f.load('lib/db.ts').initialiseDb()
  assert.equal(await f.load('lib/outreach-outbox.ts').exportStatus(id,'owner'),'pending')
 }finally{f.close()}
})
test('pipeline row selection uses outreach ID and rejects ambiguous legacy brands',()=>{
 const load=require('./load-ts.cjs');const {resolvePipelineRow}=load('../lib/pipeline-row.ts')
 const headers=Array(19).fill('');headers[17]='Outreach ID'
 const one=Array(19).fill('');one[0]='Synthetic';one[17]='immediate:1'
 const two=Array(19).fill('');two[0]='Synthetic';two[17]='immediate:2'
 assert.equal(resolvePipelineRow([headers,one,two],{outreach_id:'immediate:2'}),3)
 assert.throws(()=>resolvePipelineRow([headers,one,two],{brand_name:'Synthetic'}))
 assert.throws(()=>resolvePipelineRow([headers,one,one],{outreach_id:'immediate:1'}))
 assert.equal(resolvePipelineRow([headers,one],{brand_name:'Synthetic'}),2)
})

function sheetsAdapter(behavior = {}) {
  let batches=0;let update
  const headers=[...Array(17).fill(''),'Outreach ID','Recipient Email']
  const google={auth:{GoogleAuth:class {}},sheets:()=>({spreadsheets:{
    get:async()=>({data:{sheets:[{properties:{title:'Sheet1',sheetId:7}}]}}),
    developerMetadata:{search:async()=>({data:{matchedDeveloperMetadata:behavior.duplicate?[{developerMetadata:{metadataId:41}},{developerMetadata:{metadataId:42}}]:[{developerMetadata:{metadataId:41}}]}})},
    values:{
      get:async options=>({data:{values:options.range==='Sheet1!R:S'?(behavior.badHeaders?[['Occupied','Other']]:[['Outreach ID','Recipient Email']]):[headers,['Existing synthetic row']]}}),
      batchUpdateByDataFilter:async options=>{update=options;return {data:{totalUpdatedCells:1}}},
      update:async()=>{throw new Error('Unexpected positional update for an outreach ID')},
    },
    batchUpdate:async options=>{batches++;behavior.requests=options.requestBody.requests;return {data:{replies:[{},{},{},{createDeveloperMetadata:{developerMetadata:{metadataId:41}}}]}}},
  }})}
  const exports={}
  const source=ts.transpileModule(fs.readFileSync(path.join(root,'lib/sheets.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  vm.runInNewContext(source,{exports,process:{env:{GOOGLE_SHEETS_ID:'synthetic-sheet',GOOGLE_SERVICE_ACCOUNT:'{}'}},require:name=>{
    if(name==='server-only')return {}
    if(name==='googleapis')return {google}
    if(name==='./pipeline-row')return require('./load-ts.cjs')('../lib/pipeline-row.ts')
    throw new Error('Unexpected module '+name)
  }})
  return {exports,batches:()=>batches,update:()=>update}
}
test('Sheets row creation and its identity metadata use one atomic batch',async()=>{
 const behavior={};const adapter=sheetsAdapter(behavior);let intents=0
 await adapter.exports.appendOutreachRow({brand_name:'Synthetic',to_email:'recipient@example.invalid',email_body:'=literal text'},'immediate:1','synthetic-sheet','2026-01-01T00:00:00Z',async()=>{intents++;return true})
 assert.equal(intents,1);assert.equal(adapter.batches(),1)
 assert.equal(behavior.requests.length,4)
 assert.equal(behavior.requests[1].insertDimension.range.startIndex,2)
 const row=behavior.requests[2].updateCells.rows[0].values
 assert.equal(row[12].userEnteredValue.stringValue,'=literal text')
 assert.equal(row[17].userEnteredValue.stringValue,'immediate:1')
 assert.equal(behavior.requests[3].createDeveloperMetadata.developerMetadata.location.dimensionRange.startIndex,2)
})
test('lost or revoked export claim prevents the actual Sheets write',async()=>{
 const adapter=sheetsAdapter()
 assert.equal(await adapter.exports.appendOutreachRow({},'immediate:1','synthetic-sheet','2026-01-01T00:00:00Z',async()=>false),null)
 assert.equal(adapter.batches(),0)
})
test('unreserved destination columns fail before a write intent',async()=>{
 const adapter=sheetsAdapter({badHeaders:true})
 await assert.rejects(adapter.exports.findOutreachRow('immediate:1','synthetic-sheet'))
 assert.equal(adapter.batches(),0)
})
test('outreach edits use metadata ID, independent of any old physical row number',async()=>{
 const adapter=sheetsAdapter()
 await adapter.exports.updatePipelineStatus({outreach_id:'immediate:1',status:'Replied'})
 const update=adapter.update().requestBody.data[0]
 assert.equal(update.dataFilter.developerMetadataLookup.metadataId,41)
 assert.equal(update.values[0].length,15);assert.equal(update.values[0][14],'Replied')
 assert.ok(update.values[0].slice(0,14).every(value=>value===null))
 await adapter.exports.updatePipelineNotes({outreach_id:'immediate:1',notes:'Synthetic note'})
 assert.equal(adapter.update().requestBody.data[0].values[0][15],'Synthetic note')
})
test('duplicate metadata fails closed instead of modifying several rows',async()=>{
 const adapter=sheetsAdapter({duplicate:true})
 await assert.rejects(adapter.exports.updatePipelineStatus({outreach_id:'immediate:1',status:'Replied'}))
 assert.equal(adapter.update(),undefined)
})

test('export snapshot is frozen before Gmail and not replaced by a retry',async()=>{
 const f=await fixture();const db=f.db();try{
  const row=db.prepare(`INSERT INTO send_records(owner_google_sub,owner_email,request_id,payload_hash,status) VALUES ('owner','owner@example.invalid','synthetic','hash','sending')`).run()
  const outbox=f.load('lib/outreach-outbox.ts')
  await outbox.preparePipelineExport('immediate',Number(row.lastInsertRowid),'owner',JSON.stringify({brand_name:'Original'}))
  await outbox.preparePipelineExport('immediate',Number(row.lastInsertRowid),'owner',JSON.stringify({brand_name:'Changed'}))
  db.prepare("UPDATE send_records SET status='accepted',gmail_message_id='synthetic'").run()
  assert.equal(JSON.parse(db.prepare('SELECT payload FROM outreach_exports').get().payload).brand_name,'Original')
 }finally{db.close();f.close()}
})
test('old accepted rows without a frozen export are not backfilled on initialization',async()=>{
 const f=await fixture();const db=f.db();try{
  db.prepare(`INSERT INTO send_records(owner_google_sub,owner_email,request_id,payload_hash,status,gmail_message_id) VALUES ('owner','owner@example.invalid','synthetic','hash','accepted','known-id')`).run()
  await f.load('lib/db.ts').initialiseDb()
  assert.equal(db.prepare('SELECT count(*) AS n FROM outreach_exports').get().n,0)
 }finally{db.close();f.close()}
})
test('export API binds retries to owner and omits body and provider IDs',async()=>{
 const {NextRequest}=require('next/server');const f=await fixture();try{
  const id=await accepted(f);const api=f.load('app/api/pipeline-exports/route.ts')
  const request=owner=>new NextRequest('https://example.invalid/api/pipeline-exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({outreach_id:id,expectedGoogleSub:owner})})
  assert.equal((await api.POST(request('other'))).status,409)
  f.behavior.owner='other';assert.equal((await api.POST(request('other'))).status,404);assert.equal(f.behavior.appends,0)
  f.behavior.owner='owner'
  const listing=await (await api.GET(new NextRequest('https://example.invalid/api/pipeline-exports'))).json()
  assert.equal(listing.exports.length,1);assert.equal(JSON.stringify(listing).includes('gmail_message_id'),false);assert.equal(JSON.stringify(listing).includes('email_body'),false)
  assert.equal((await api.POST(request('owner'))).status,200);assert.equal(f.behavior.appends,1)
 }finally{f.close()}
})

test('separate databases cannot collide on the same spreadsheet outreach ID',async()=>{
 const one=await fixture();const two=await fixture();try{
  const first=await accepted(one);const second=await accepted(two)
  assert.notEqual(first,second,'database row numbers are not globally unique export identities')
 }finally{one.close();two.close()}
})
