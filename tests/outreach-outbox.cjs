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
    get:async()=>({data:{sheets:[{properties:{title:'Sheet1',sheetId:7,gridProperties:{rowCount:behavior.rowCount ?? 1000}}}]}}),
    developerMetadata:{search:async()=>({data:{matchedDeveloperMetadata:behavior.duplicate?[{developerMetadata:{metadataId:41}},{developerMetadata:{metadataId:42}}]:[{developerMetadata:{metadataId:41}}]}})},
    values:{
      get:async options=>({data:{values:options.range==='Sheet1!R:S'?(behavior.badHeaders?[['Occupied','Other']]:[['Outreach ID','Recipient Email']]):[headers,['Existing synthetic row']]}}),
      batchUpdateByDataFilter:async options=>{update=options;return {data:{totalUpdatedCells:1}}},
      update:async()=>{throw new Error('Unexpected positional update for an outreach ID')},
    },
    batchUpdate:async options=>{batches++;behavior.requests=options.requestBody.requests;return {data:{replies:options.requestBody.requests.map(request=>request.createDeveloperMetadata?{createDeveloperMetadata:{developerMetadata:{metadataId:41}}}:{})}}},
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
 assert.equal(behavior.requests.length,3)
 assert.equal(behavior.requests.some(request=>request.appendDimension),false)
 assert.equal(behavior.requests[0].insertDimension.range.startIndex,2)
 const row=behavior.requests[1].updateCells.rows[0].values
 assert.equal(row[12].userEnteredValue.stringValue,'=literal text')
 assert.equal(row[17].userEnteredValue.stringValue,'immediate:1')
 assert.equal(behavior.requests[2].createDeveloperMetadata.developerMetadata.location.dimensionRange.startIndex,2)
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

test('known Gmail IDs in review fallbacks enqueue, while unknown outcomes do not',async()=>{
 const f=await fixture();const db=f.db();try{
  db.prepare(`INSERT INTO send_records(owner_google_sub,owner_email,request_id,payload_hash,status,pipeline_payload) VALUES ('owner','owner@example.invalid','synthetic','hash','sending','{}')`).run()
  db.prepare("UPDATE send_records SET status='needs_review'").run()
  assert.equal(db.prepare('SELECT count(*) AS n FROM outreach_exports').get().n,0)
  db.prepare("UPDATE send_records SET status='needs_review',gmail_message_id='known-gmail-id'").run()
  assert.equal(db.prepare('SELECT gmail_message_id FROM outreach_exports').get().gmail_message_id,'known-gmail-id')
 }finally{db.close();f.close()}
})
test('SQLite upgrades the earlier accepted-only trigger without dropping events',async()=>{
 const f=await fixture();const db=f.db();try{
  const legacy=f.load('lib/db.ts').OUTREACH_EXPORTS_SQLITE_DDL.replace("NEW.status IN ('accepted','needs_review')","NEW.status = 'accepted'")
  db.transaction(()=>{db.exec('DROP TRIGGER enqueue_immediate_export');db.exec(legacy)})()
  await f.load('lib/db.ts').initialiseDb()
  db.prepare(`INSERT INTO send_records(owner_google_sub,owner_email,request_id,payload_hash,status,pipeline_payload) VALUES ('owner','owner@example.invalid','synthetic','hash','sending','{}')`).run()
  db.prepare("UPDATE send_records SET status='needs_review',gmail_message_id='known-id'").run()
  assert.equal(db.prepare('SELECT count(*) AS n FROM outreach_exports').get().n,1)
 }finally{db.close();f.close()}
})
test('old review-only jobs cannot consume the slot before new pending exports',async()=>{
 const f=await fixture();const db=f.db();try{
  const old=await accepted(f);const fresh=await accepted(f)
  db.prepare("UPDATE outreach_exports SET status='needs_review',write_intent_at=datetime('now','-1 day'),accepted_at='2000-01-01T00:00:00Z' WHERE outreach_id=?").run(old)
  await f.load('lib/outreach-outbox.ts').processPipelineExports(1)
  assert.equal(await f.load('lib/outreach-outbox.ts').exportStatus(fresh,'owner'),'synced')
  assert.equal(await f.load('lib/outreach-outbox.ts').exportStatus(old,'owner'),'needs_review')
  assert.equal(f.behavior.appends,1)
 }finally{db.close();f.close()}
})
test('a full grid adds capacity while a normal grid allocates only the inserted row',async()=>{
 const behavior={rowCount:2};const adapter=sheetsAdapter(behavior)
 await adapter.exports.appendOutreachRow({},'immediate:1','synthetic-sheet','2026-01-01T00:00:00Z',async()=>true)
 assert.equal(behavior.requests.length,4);assert.ok(behavior.requests[0].appendDimension)
 assert.equal(behavior.requests[1].insertDimension.range.startIndex,2)
})
test('SQLite naive acceptance timestamps are interpreted as UTC on a non-UTC host',async()=>{
 const previous=process.env.TZ;process.env.TZ='Asia/Tokyo'
 try{
  const behavior={};const adapter=sheetsAdapter(behavior)
  await adapter.exports.appendOutreachRow({},'immediate:1','synthetic-sheet','2026-01-01 16:00:00',async()=>true)
  const actual=behavior.requests.find(request=>request.updateCells).updateCells.rows[0].values[13].userEnteredValue.stringValue
  assert.equal(actual,new Date('2026-01-01T16:00:00Z').toLocaleDateString('en-AU',{timeZone:'Australia/Sydney'}))
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous}
})


test('manual listing recovers only expired claims belonging to the signed-in owner',async()=>{
 const {NextRequest}=require('next/server');const f=await fixture();const db=f.db();try{
  const stale=await accepted(f);const uncertain=await accepted(f);const fresh=await accepted(f);const foreign=await accepted(f,'other')
  db.prepare("UPDATE outreach_exports SET status='claimed',claimed_at=datetime('now','-10 minutes'),claim_token='old'").run()
  db.prepare("UPDATE outreach_exports SET status='writing',write_intent_at=datetime('now','-10 minutes') WHERE outreach_id=?").run(uncertain)
  db.prepare("UPDATE outreach_exports SET claimed_at=? WHERE outreach_id=?").run(new Date().toISOString(),fresh)
  const api=f.load('app/api/pipeline-exports/route.ts')
  const response=await api.GET(new NextRequest('https://example.invalid/api/pipeline-exports'))
  assert.equal(response.status,200)
  const jobs=(await response.json()).exports
  assert.equal(jobs.find(job=>job.outreach_id===stale).status,'failed')
  assert.equal(jobs.find(job=>job.outreach_id===uncertain).status,'needs_review')
  assert.equal(jobs.find(job=>job.outreach_id===fresh).status,'claimed')
  assert.equal(db.prepare('SELECT status FROM outreach_exports WHERE outreach_id=?').get(foreign).status,'claimed')
  assert.equal(db.prepare('SELECT claim_token FROM outreach_exports WHERE outreach_id=?').get(stale).claim_token,null)
  assert.equal(f.behavior.appends,0)
 }finally{db.close();f.close()}
})
test('manual retry recovers expired preparation but only reconciles interrupted writes',async()=>{
 const {NextRequest}=require('next/server');const f=await fixture();const db=f.db();try{
  const stale=await accepted(f);const uncertain=await accepted(f)
  db.prepare("UPDATE outreach_exports SET status='claimed',claimed_at=datetime('now','-10 minutes'),claim_token='old'").run()
  db.prepare("UPDATE outreach_exports SET status='writing',write_intent_at=datetime('now','-10 minutes'),destination_id='synthetic-sheet' WHERE outreach_id=?").run(uncertain)
  const api=f.load('app/api/pipeline-exports/route.ts')
  const retry=id=>api.POST(new NextRequest('https://example.invalid/api/pipeline-exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({outreach_id:id,expectedGoogleSub:'owner'})}))
  assert.equal((await (await retry(stale)).json()).status,'synced');assert.equal(f.behavior.appends,1)
  assert.equal((await (await retry(uncertain)).json()).status,'needs_review');assert.equal(f.behavior.appends,1)
  f.behavior.rows.push({id:uncertain,range:'Sheet1!A3:S3'})
  assert.equal((await (await retry(uncertain)).json()).status,'synced');assert.equal(f.behavior.appends,1)
 }finally{db.close();f.close()}
})

test('queue alerts report counts and ages only, and never reset or append', async () => {
  const f = await fixture(); const db = f.db()
  const consoleErrors = []
  const originalError = console.error
  console.error = (...args) => consoleErrors.push(args)
  try {
    // An overdue pending job: scheduled in the past, still pending.
    db.prepare(`INSERT INTO scheduled_emails(to_email,subject,body,scheduled_at,delivery_status,owner_google_sub,pipeline_payload) VALUES ('recipient@example.invalid','Synthetic','Synthetic',datetime('now','-2 hours'),'pending','owner','{}')`).run()
    // Exports in each alerting state.
    db.prepare(`INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,status,accepted_at) VALUES ('immediate:a','owner','{}','id-a','needs_review',datetime('now'))`).run()
    db.prepare(`INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,status,accepted_at,next_attempt_at) VALUES ('immediate:b','owner','{}','id-b','failed',datetime('now'),datetime('now','-1 hour'))`).run()
    db.prepare(`INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,status,claimed_at,accepted_at) VALUES ('immediate:c','owner','{}','id-c','claimed',datetime('now','-1 hour'),datetime('now'))`).run()
    // Healthy rows that must not be counted.
    db.prepare(`INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,status,synced_at,accepted_at) VALUES ('immediate:d','owner','{}','id-d','synced',datetime('now'),datetime('now'))`).run()
    db.prepare(`INSERT INTO scheduled_emails(to_email,subject,body,scheduled_at,delivery_status,owner_google_sub,pipeline_payload) VALUES ('recipient@example.invalid','Synthetic','Synthetic',datetime('now','+2 hours'),'pending','owner','{}')`).run()
    // Due inside the last 30 minutes, in both stored shapes. A cutoff of "30
    // minutes ago" would miss these even though a retry is already allowed.
    db.prepare(`INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,status,accepted_at,next_attempt_at) VALUES ('immediate:e','owner','{}','id-e','failed',datetime('now'),datetime('now','-10 minutes'))`).run()
    db.prepare(`INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,status,accepted_at,next_attempt_at) VALUES ('immediate:f','owner','{}','id-f','failed',datetime('now'),?)`).run(new Date(Date.now() - 10 * 60_000).toISOString())
    db.prepare(`INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,status,accepted_at,next_attempt_at) VALUES ('immediate:g','owner','{}','id-g','failed',datetime('now'),datetime('now','+20 minutes'))`).run()
    db.prepare(`INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,status,claimed_at,accepted_at) VALUES ('immediate:h','owner','{}','id-h','claimed',datetime('now','-1 minutes'),datetime('now'))`).run()
    db.prepare(`INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,status,accepted_at) VALUES ('immediate:i','owner','{}','id-i','claimed',datetime('now'))`).run()
    const alerts = await f.load('lib/queue-alerts.ts').collectQueueAlerts()
    assert.equal(alerts.overduePendingJobs, 1)
    assert.ok(alerts.oldestOverdueJobSeconds >= 7000, 'the oldest overdue job age must be roughly two hours')
    assert.equal(alerts.exportsNeedsReview, 1)
    assert.equal(alerts.exportsFailedRetryable, 3)
    assert.equal(alerts.exportsStaleClaim, 2)
    // The report logs one safe line with counts only.
    await f.load('lib/queue-alerts.ts').reportQueueAlerts()
    assert.equal(consoleErrors.length, 1)
    const payload = consoleErrors[0][1]
    assert.deepEqual(Object.keys(payload).sort(), ['exports_failed_retryable', 'exports_needs_review', 'exports_stale_claim', 'oldest_overdue_job_seconds', 'overdue_pending_jobs'])
    assert.equal(JSON.stringify(consoleErrors).includes('recipient@'), false)
    assert.equal(JSON.stringify(consoleErrors).includes('id-a'), false)
    // A quiet queue logs nothing.
    consoleErrors.length = 0
    db.prepare(`DELETE FROM scheduled_emails WHERE delivery_status = 'pending'`).run()
    db.prepare(`DELETE FROM outreach_exports WHERE status != 'synced'`).run()
    const quiet = await f.load('lib/queue-alerts.ts').collectQueueAlerts()
    assert.equal(quiet.overduePendingJobs, 0)
    assert.equal(quiet.exportsNeedsReview, 0)
    await f.load('lib/queue-alerts.ts').reportQueueAlerts()
    assert.equal(consoleErrors.length, 0, 'a healthy queue must not alert')
    // The alert module never mutates queue rows.
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM outreach_exports WHERE status = 'synced'`).get().n, 1)
  } finally {
    console.error = originalError
    f.close()
  }
})

test('email_drafts schema is created idempotently by repeated initialiseDb', async () => {
  const f = await fixture()
  try {
    // The fixture already ran initialiseDb once; run it twice more on the same
    // temporary SQLite file to prove the drafts DDL is idempotent.
    await f.load('lib/db.ts').initialiseDb()
    await f.load('lib/db.ts').initialiseDb()
    const db = f.db()
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'email_drafts'`).all()
    assert.equal(tables.length, 1)
    const columns = db.prepare('PRAGMA table_info(email_drafts)').all().map(column => column.name)
    for (const required of ['id', 'owner_google_sub', 'owner_email', 'revision', 'payload', 'attachment_ids', 'created_at', 'updated_at']) {
      assert.ok(columns.includes(required), `email_drafts must have column ${required}`)
    }
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'email_drafts_owner'`).all()
    assert.equal(indexes.length, 1)
    db.close()
  } finally { f.close() }
})
