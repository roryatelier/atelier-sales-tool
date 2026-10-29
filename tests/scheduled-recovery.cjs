const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const Database = require('better-sqlite3')
const { NextRequest } = require('next/server')
const root = path.resolve(__dirname, '..')
function fixture() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE scheduled_emails (id INTEGER PRIMARY KEY, to_email TEXT, cc TEXT, bcc TEXT, subject TEXT, body TEXT, brand_name TEXT, contact_name TEXT, owner_google_sub TEXT, owner_email TEXT, credential_ciphertext TEXT, dossier_json TEXT, scheduled_at TEXT, delivery_status TEXT, claimed_at TEXT, attempt_count INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, sent_at TEXT, gmail_message_id TEXT, gmail_thread_id TEXT, last_error_code TEXT, claim_token TEXT, send_intent_at TEXT, next_attempt_at TEXT, timezone TEXT, sent_by TEXT); CREATE TABLE contact_history (brand_name TEXT, contact_role TEXT, contact_name TEXT, contact_email TEXT, method TEXT)`)
  let calls = 0
  const behavior = { refresh: { accessToken: 'synthetic' }, sendError: null, onSend: null }
  const cache = new Map()
  const load = relative => {
    const filename = path.resolve(root, relative)
    if (cache.has(filename)) return cache.get(filename)
    const exports = {}; cache.set(filename, exports)
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInNewContext(source, { exports, process: { env: { CRON_SECRET: 'synthetic', GMAIL_CLIENT_ID: 'synthetic', GMAIL_CLIENT_SECRET: 'synthetic' } }, crypto: globalThis.crypto, Date: class extends Date { static now() { return behavior.now ?? Date.now() } }, console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Buffer, URL, URLSearchParams, Intl, require: name => {
      if (name === '@/lib/api-auth') return { authorizeRequest: async () => ({ session: { googleSub: 'owner', email: 'owner@example.invalid' } }) }
      if (name === '@/lib/session') return { getGmailCredentials: async () => ({ refreshToken: 'synthetic' }) }
      if (name === '@/lib/db') return { initialiseDb: async () => {}, isVercel: false, getLocalDb: () => new Proxy(db, { get: (target, prop) => prop === 'close' ? () => {} : typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop] }) }
      if (name === '@/lib/auth-policy') return { sealGmailCredentials: async () => 'fresh-synthetic', openGmailCredentials: async () => ({ refreshToken: 'synthetic' }), isAuthorizedEmail: () => true }
      if (name === '@/lib/gmail') return { makeEmailRaw: () => 'synthetic', refreshGmailToken: async () => { if (behavior.refreshFails) return null; return 'synthetic' }, refreshScheduledGmailToken: async () => behavior.refresh, sendViaGmail: async () => { calls++; if (behavior.onSend) await behavior.onSend(); if (behavior.sendError) throw behavior.sendError; return { id: 'synthetic-message', threadId: 'synthetic-thread' } } }
      if (name === '@/lib/outreach-outbox') return { pipelineSnapshot: JSON.stringify, preparePipelineExport: async () => { if (behavior.prepareError) throw new Error('synthetic preparation failure') }, syncPipelineSource: async () => 'synced', processPipelineExports: async () => { if (behavior.exportDelay) behavior.now = Date.now() + behavior.exportDelay } }
      if (name === '@/lib/sheets') return { appendPipelineRow: async () => {} }
      if (name.startsWith('@/')) return load(name.slice(2) + '.ts')
      return require(name)
    } }, { filename })
    return exports
  }
  return { db, load, behavior, calls: () => calls, seed(status, claimed = null) {
    return db.prepare(`INSERT INTO scheduled_emails (to_email,subject,body,owner_google_sub,owner_email,credential_ciphertext,scheduled_at,delivery_status,claimed_at) VALUES ('recipient@example.invalid','Synthetic','Synthetic','owner','owner@example.invalid','sealed',?,?,?)`).run(new Date(Date.now() - 60000).toISOString(), status, claimed).lastInsertRowid
  }, run: () => load('app/api/cron/send-scheduled-emails/route.ts').GET(new NextRequest('https://example.invalid/api/cron/send-scheduled-emails', { headers: { authorization: 'Bearer synthetic' } })) }
}
test('interrupted Gmail attempts require review and never resend', async () => {
  const f = fixture(); try {
    const id = f.seed('sending', new Date(Date.now() - 600000).toISOString())
    await f.run()
    assert.equal(f.db.prepare('SELECT delivery_status FROM scheduled_emails WHERE id=?').get(id).delivery_status, 'needs_review')
    assert.equal(f.calls(), 0)
  } finally { f.db.close() }
})
test('SQLite claims ISO schedules due today', async () => {
  const f = fixture(); try { f.seed('pending'); await f.run(); assert.equal(f.calls(), 1) } finally { f.db.close() }
})
test('expired pre-intent claims recover, fence the old worker and send exactly once', async () => {
  const f = fixture(); try {
    const id = f.seed('pending'); const store = f.load('lib/scheduled-email-store.ts')
    const old = await store.claimNext()
    f.db.prepare("UPDATE scheduled_emails SET claimed_at=datetime('now','-10 minutes') WHERE id=?").run(id)
    assert.equal((await store.recoverScheduledEmails()).recovered, 1)
    assert.equal(await store.beginScheduledSend(old), false)
    await f.run(); await f.run(); assert.equal(f.calls(), 1)
  } finally { f.db.close() }
})
test('fresh claims are not recovered, and legacy quarantine is never claimed', async () => {
  const f = fixture(); try {
    f.seed('pending'); f.seed('legacy_quarantined'); const store = f.load('lib/scheduled-email-store.ts')
    const job = await store.claimNext(); await store.recoverScheduledEmails()
    assert.equal(await store.beginScheduledSend(job), true)
    assert.equal(await store.claimNext(), null)
  } finally { f.db.close() }
})
test('late acceptance resolves only its original uncertain attempt', async () => {
  const f = fixture(); try {
    f.seed('pending'); const store = f.load('lib/scheduled-email-store.ts'); const job = await store.claimNext()
    await store.beginScheduledSend(job)
    f.db.prepare("UPDATE scheduled_emails SET claimed_at=datetime('now','-10 minutes')").run()
    await store.recoverScheduledEmails(); await store.acceptScheduledSend(job, 'late-id')
    await store.acceptScheduledSend(job, 'late-id')
    await assert.rejects(store.acceptScheduledSend({ ...job, claim_token: 'wrong-token' }, 'other-id'))
    assert.equal(f.db.prepare('SELECT gmail_message_id FROM scheduled_emails').get().gmail_message_id, 'late-id')
    await f.run(); assert.equal(f.calls(), 0)
  } finally { f.db.close() }
})
test('cancellation is owner-scoped and fences a claimed worker before intent', async () => {
  const f = fixture(); try {
    const id = f.seed('pending'); const store = f.load('lib/scheduled-email-store.ts'); const job = await store.claimNext()
    assert.equal(await store.cancelScheduledEmail(id, 'other-owner'), false)
    assert.equal(await store.cancelScheduledEmail(id, 'owner'), true)
    assert.equal(await store.beginScheduledSend(job), false)
    await f.run(); assert.equal(f.calls(), 0)
  } finally { f.db.close() }
})
test('post-intent cancellation/resume are forbidden; uncertain jobs never retry', async () => {
  const f = fixture(); try {
    const id = f.seed('pending'); const store = f.load('lib/scheduled-email-store.ts'); const job = await store.claimNext()
    await store.beginScheduledSend(job)
    assert.equal(await store.cancelScheduledEmail(id, 'owner'), false)
    await store.failScheduledSend(job, 'needs_review', 'gmail_send_ambiguous')
    assert.equal(await store.resumeScheduledEmail(id, 'owner', 'fresh'), false)
    await f.run(); assert.equal(f.calls(), 0)
  } finally { f.db.close() }
})
test('token refresh outages safely back off without hammering Gmail', async () => {
  const f = fixture(); try {
    f.seed('pending'); f.behavior.refresh = {}; await f.run(); await f.run()
    const row = f.db.prepare('SELECT * FROM scheduled_emails').get()
    assert.equal(row.delivery_status, 'pending'); assert.equal(row.attempt_count, 1); assert.equal(f.calls(), 0)
  } finally { f.db.close() }
})
test('revoked grants pause before intent; only their owner can explicitly resume', async () => {
  const f = fixture(); try {
    const id = f.seed('pending'); f.behavior.refresh = { reauth: true }; await f.run()
    assert.equal(f.db.prepare('SELECT delivery_status FROM scheduled_emails').get().delivery_status, 'needs_reauth')
    const store = f.load('lib/scheduled-email-store.ts')
    assert.equal(await store.resumeScheduledEmail(id, 'other', 'fresh'), false)
    assert.equal(await store.resumeScheduledEmail(id, 'owner', 'fresh'), true)
    f.behavior.refresh = { accessToken: 'synthetic' }; await f.run(); assert.equal(f.calls(), 1)
  } finally { f.db.close() }
})
test('Gmail ambiguity is durable and never automatically resent', async () => {
  const f = fixture(); try {
    f.seed('pending'); f.behavior.sendError = new Error('network interrupted'); await f.run(); await f.run()
    assert.equal(f.calls(), 1); assert.equal(f.db.prepare('SELECT delivery_status FROM scheduled_emails').get().delivery_status, 'needs_review')
  } finally { f.db.close() }
})
test('recovery quarantines malformed claimed rows instead of guessing', async () => {
  const f = fixture(); try {
    f.seed('claimed', 'invalid'); f.db.prepare("UPDATE scheduled_emails SET claim_token='synthetic'").run()
    await f.run(); assert.equal(f.calls(), 0)
    assert.equal(f.db.prepare('SELECT delivery_status FROM scheduled_emails').get().delivery_status, 'needs_review')
  } finally { f.db.close() }
})

test('scheduled refresh distinguishes invalid grants from transient and configuration failures', async () => {
  const loadTypeScript = require('./load-ts.cjs')
  for (const [status, data, expected] of [
    [400, { error: 'invalid_grant' }, true], [503, {}, false],
    [429, {}, false], [401, { error: 'invalid_client' }, false], [200, { access_token: '' }, false],
  ]) {
    const gmail = loadTypeScript('../lib/gmail.ts', { process: { env: {} }, URLSearchParams, fetch: async () => ({ ok: status === 200, status, json: async () => data }) })
    const result = await gmail.refreshScheduledGmailToken('synthetic')
    assert.equal(result.reauth === true, expected)
    assert.equal(result.accessToken, undefined)
  }
})

test('schedule API binds cancellation and resume to the confirmed account and current state', async () => {
  const f = fixture(); try {
    const id = f.seed('needs_reauth'); const route = f.load('app/api/schedule-email/route.ts')
    const patch = owner => new NextRequest('https://example.invalid/api/schedule-email', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: Number(id), action: 'resume', expectedGoogleSub: owner }),
    })
    assert.equal((await route.PATCH(patch('other'))).status, 409)
    const responses = await Promise.all([route.PATCH(patch('owner')), route.PATCH(patch('owner'))])
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409])
    assert.equal(f.calls(), 0, 'resuming only queues; it does not call Gmail')
    assert.equal((await route.DELETE(new NextRequest(`https://example.invalid/api/schedule-email?id=${id}&expectedGoogleSub=other`))).status, 409)
    assert.equal((await route.DELETE(new NextRequest(`https://example.invalid/api/schedule-email?id=${id}&expectedGoogleSub=owner`))).status, 200)
    await f.run(); assert.equal(f.calls(), 0)
    const rows = await (await route.GET(new NextRequest('https://example.invalid/api/schedule-email'))).json()
    assert.equal(rows.owner_google_sub, 'owner'); assert.equal(rows.emails.length, 0)
  } finally { f.db.close() }
})

test('pipeline preparation failures back off before any Gmail send',async()=>{
 const f=fixture();try{
  f.seed('pending');f.behavior.prepareError=true;await f.run()
  const row=f.db.prepare('SELECT * FROM scheduled_emails').get()
  assert.equal(row.delivery_status,'pending');assert.equal(row.last_error_code,'preparation_failed');assert.equal(row.attempt_count,1);assert.equal(f.calls(),0)
 }finally{f.db.close()}
})

test('slow Sheets work leaves scheduled sends pending when execution budget is low',async()=>{
 const f=fixture();try{
  f.seed('pending');f.behavior.exportDelay=45000;await f.run()
  const row=f.db.prepare('SELECT * FROM scheduled_emails').get()
  assert.equal(row.delivery_status,'pending');assert.equal(row.attempt_count,0);assert.equal(f.calls(),0)
 }finally{f.db.close()}
})

// ------------------------------------------------------------------
// Safe scheduling: idempotency, Gmail-id preservation, attachments
// ------------------------------------------------------------------
const SCHEDULE_SCHEMA = `CREATE TABLE IF NOT EXISTS scheduled_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT, to_email TEXT NOT NULL, cc TEXT, bcc TEXT,
  subject TEXT NOT NULL, body TEXT NOT NULL, brand_name TEXT, contact_name TEXT,
  scheduled_at TEXT NOT NULL, sent INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
  owner_google_sub TEXT, owner_email TEXT, credential_ciphertext TEXT, dossier_json TEXT DEFAULT '',
  pipeline_payload TEXT, timezone TEXT DEFAULT 'Australia/Sydney',
  delivery_status TEXT DEFAULT 'legacy_quarantined', attempt_count INTEGER DEFAULT 0,
  claimed_at TEXT, sent_at TEXT, gmail_message_id TEXT, gmail_thread_id TEXT, last_error_code TEXT,
  claim_token TEXT, send_intent_at TEXT, next_attempt_at TEXT,
  request_id TEXT, payload_hash TEXT,
  UNIQUE (request_id),
  CHECK (delivery_status != 'sent' OR (gmail_message_id IS NOT NULL AND gmail_message_id != ''))
)`
const SCHEDULE_REQUEST_BODY = { expectedGoogleSub: 'owner', request_id: 'aaaaaaa1-0000-4000-8000-000000000001', to: 'recipient@example.invalid', subject: 'Synthetic', body: 'Synthetic', contact_name: 'Contact', scheduled_at_local: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 16), timezone: 'UTC' }
const scheduleRequest = body => new NextRequest('https://example.invalid/api/schedule-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) })
let scheduleSeq = 0
const freshScheduleBody = () => ({ ...SCHEDULE_REQUEST_BODY, request_id: 'aaaaaaa1-0000-4000-8000-' + (++scheduleSeq).toString(16).padStart(12, '0') })
const freshScheduleRequest = () => scheduleRequest(freshScheduleBody())

function scheduleFixture() {
  const f = fixture()
  // fixture() creates scheduled_emails without the idempotency columns; add them
  // the same way lib/db.ts migrates existing databases.
  f.db.exec(`ALTER TABLE scheduled_emails ADD COLUMN request_id TEXT; ALTER TABLE scheduled_emails ADD COLUMN payload_hash TEXT; CREATE UNIQUE INDEX IF NOT EXISTS scheduled_emails_request_id ON scheduled_emails (request_id) WHERE request_id IS NOT NULL`)
  return f
}

test('a repeated schedule request replays the original job and never creates a second one', async () => {
  const f = scheduleFixture(); try {
    const route = f.load('app/api/schedule-email/route.ts').POST
    const first = await route(scheduleRequest(SCHEDULE_REQUEST_BODY))
    assert.equal(first.status, 200)
    const replay = await route(scheduleRequest(SCHEDULE_REQUEST_BODY))
    assert.equal(replay.status, 200)
    assert.equal(JSON.parse(await replay.text()).replayed, true)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scheduled_emails').get().n, 1)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scheduled_emails WHERE request_id=?').get(SCHEDULE_REQUEST_BODY.request_id).n, 1)
  } finally { f.db.close() }
})

test('a schedule request id bound to different content is rejected', async () => {
  const f = scheduleFixture(); try {
    const route = f.load('app/api/schedule-email/route.ts').POST
    assert.equal((await route(scheduleRequest(SCHEDULE_REQUEST_BODY))).status, 200)
    const conflict = await route(scheduleRequest({ ...SCHEDULE_REQUEST_BODY, subject: 'Changed' }))
    assert.equal(conflict.status, 409)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scheduled_emails').get().n, 1)
  } finally { f.db.close() }
})

test('a replay succeeds even when the Gmail token refresh would fail', async () => {
  const f = scheduleFixture(); try {
    const route = f.load('app/api/schedule-email/route.ts').POST
    const first = await route(scheduleRequest(SCHEDULE_REQUEST_BODY))
    assert.equal(first.status, 200)
    // The recorded job exists, so a retry must replay without touching Gmail.
    f.behavior.refreshFails = true
    const replay = await route(scheduleRequest(SCHEDULE_REQUEST_BODY))
    assert.equal(replay.status, 200)
    assert.equal(JSON.parse(await replay.text()).replayed, true)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scheduled_emails').get().n, 1)
    // A brand-new request still needs Gmail and now reports the reauth error.
    const fresh = await route(scheduleRequest({ ...SCHEDULE_REQUEST_BODY, request_id: 'aaaaaaa1-0000-4000-8000-0000000000ff' }))
    assert.equal(fresh.status, 401)
    assert.equal(JSON.parse(await fresh.text()).reauth, true)
  } finally { f.db.close() }
})

test('schedule requests without a request id fail closed', async () => {
  const f = scheduleFixture(); try {
    const route = f.load('app/api/schedule-email/route.ts').POST
    const body = { ...SCHEDULE_REQUEST_BODY }; delete body.request_id
    assert.equal((await route(scheduleRequest(body))).status, 400)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scheduled_emails').get().n, 0)
  } finally { f.db.close() }
})

test('scheduling with attachments is blocked with a clear message and nothing is stored', async () => {
  const f = scheduleFixture(); try {
    const route = f.load('app/api/schedule-email/route.ts').POST
    const response = await route(scheduleRequest({ ...freshScheduleBody(), attachments: [{ name: 'deck.pdf', type: 'application/pdf', data: 'YWJj' }] }))
    assert.equal(response.status, 400)
    assert.match(JSON.parse(await response.text()).error, /attach/i)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scheduled_emails').get().n, 0)
  } finally { f.db.close() }
})

test('acceptance failure after Gmail intent preserves the Gmail message id and queues the export', async () => {
  const f = scheduleFixture(); try {
    f.db.exec(`CREATE TABLE IF NOT EXISTS outreach_exports (source_key TEXT PRIMARY KEY, owner_google_sub TEXT, payload TEXT, gmail_message_id TEXT, accepted_at TEXT)`)
    f.db.exec('ALTER TABLE scheduled_emails ADD COLUMN pipeline_payload TEXT')
    f.seed('pending')
    const store = f.load('lib/scheduled-email-store.ts')
    const originalAccept = store.acceptScheduledSend
    // Simulate the acceptance write being lost after Gmail returned an id: the
    // id is recorded by the preservation path, then the acceptance still fails.
    f.db.exec(`UPDATE scheduled_emails SET pipeline_payload = '{"synthetic":true}'`)
    store.acceptScheduledSend = async (job, id) => {
      await store.recordAcceptedMessageId(job, id, 'synthetic-thread')
      throw new Error('acceptance_not_recorded')
    }
    await f.run()
    const row = f.db.prepare('SELECT * FROM scheduled_emails').get()
    assert.equal(row.gmail_message_id, 'synthetic-message')
    assert.equal(row.delivery_status, 'needs_review')
    const exportRow = f.db.prepare('SELECT * FROM outreach_exports WHERE source_key = ?').get('scheduled:' + row.id)
    assert.ok(exportRow, 'the export event must be queued despite the lost acceptance write')
    assert.equal(exportRow.gmail_message_id, 'synthetic-message')
    assert.equal(exportRow.payload, '{"synthetic":true}', 'the queued export must carry the real pipeline payload read from the row')
    assert.equal(row.gmail_thread_id, 'synthetic-thread')
    // The recorded error code is the specific one, not the generic ambiguity code.
    assert.equal(row.last_error_code, 'acceptance_write_lost')
    // A late replay of the same request never resends: the acceptance is complete.
    store.acceptScheduledSend = originalAccept
    await store.acceptScheduledSend(row, row.gmail_message_id)
    assert.equal(f.db.prepare('SELECT delivery_status FROM scheduled_emails WHERE id=?').get(row.id).delivery_status, 'sent')
    // A second worker pass must not call Gmail again for this job.
    const callsBefore = f.calls()
    await f.run()
    assert.equal(f.calls(), callsBefore, 'a repeated worker run must never trigger another Gmail send')
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM outreach_exports').get().n, 1)
  } finally { f.db.close() }
})

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'

function memoryStorage() {
  const values = new Map()
  return {
    get length() { return values.size },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

function loadScheduleRequestId() {
  const exported = {}
  const filename = path.join(root, 'lib/schedule-request-id.ts')
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(source, { exports: exported }, { filename })
  return exported
}

test('schedule request ids are shared across tabs for one draft and expire', () => {
  const store = loadScheduleRequestId()
  const owner = 'google-1'
  const fingerprint = 'draft1'
  const storage = memoryStorage()
  const now = 1_700_000_000_000
  const first = store.claimScheduleRequestId(storage, owner, fingerprint, '', () => ID_A, now)
  const secondTab = store.claimScheduleRequestId(storage, owner, fingerprint, '', () => ID_B, now)
  assert.equal(first, ID_A)
  assert.equal(secondTab, ID_A, 'a second tab with the same draft must reuse the stored id')
  const reloaded = store.claimScheduleRequestId(memoryStorage(), owner, fingerprint, '', () => ID_B, now)
  assert.equal(reloaded, ID_B, 'a separate store, as sessionStorage is per tab, must not see the other tab')
  const kept = store.claimScheduleRequestId(storage, owner, fingerprint, ID_A, () => ID_B, now + 1000)
  assert.equal(kept, ID_A, 'reauth, 5xx, and network retries keep the in-memory id')
  const refreshed = JSON.parse(storage.getItem(store.scheduleRequestStorageKey(owner, fingerprint)))
  assert.equal(refreshed.expiresAt, now + 1000 + store.SCHEDULE_REQUEST_TTL_MS)

  const otherDraft = store.claimScheduleRequestId(storage, owner, 'draft2', '', () => ID_B, now)
  assert.equal(otherDraft, ID_B)
  const otherAccount = store.claimScheduleRequestId(storage, 'google-2', fingerprint, '', () => ID_C, now)
  assert.equal(otherAccount, ID_C)
  assert.equal(store.claimScheduleRequestId(storage, 'ab', 'c', '', () => ID_A, now), ID_A)
  assert.equal(store.claimScheduleRequestId(storage, 'a', 'bc', '', () => ID_B, now), ID_B)

  store.forgetScheduleRequestId(storage, owner, fingerprint)
  assert.equal(storage.getItem(store.scheduleRequestStorageKey(owner, fingerprint)), null)
  assert.equal(storage.getItem(store.scheduleRequestStorageKey(owner, 'draft2')), JSON.stringify({ requestId: ID_B, expiresAt: now + store.SCHEDULE_REQUEST_TTL_MS }))
  assert.equal(store.claimScheduleRequestId(storage, owner, fingerprint, '', () => ID_C, now), ID_C, 'success and 4xx clear the id so the next confirmation is new')

  const expiring = memoryStorage()
  assert.equal(store.claimScheduleRequestId(expiring, owner, fingerprint, '', () => ID_A, now), ID_A)
  assert.equal(store.claimScheduleRequestId(expiring, owner, fingerprint, '', () => ID_B, now + store.SCHEDULE_REQUEST_TTL_MS - 1), ID_A)
  const expired = memoryStorage()
  assert.equal(store.claimScheduleRequestId(expired, owner, fingerprint, '', () => ID_A, now), ID_A)
  assert.equal(store.claimScheduleRequestId(expired, owner, 'stale', '', () => ID_C, now), ID_C)
  assert.equal(store.claimScheduleRequestId(expired, owner, fingerprint, '', () => ID_B, now + store.SCHEDULE_REQUEST_TTL_MS), ID_B)
  assert.equal(expired.getItem(store.scheduleRequestStorageKey(owner, 'stale')), null, 'claiming removes expired ids for other drafts')

  const malformed = memoryStorage()
  const key = store.scheduleRequestStorageKey(owner, fingerprint)
  malformed.setItem(key, '{')
  malformed.setItem('atelier_schedule_request_garbage', 'not-json')
  assert.equal(store.claimScheduleRequestId(malformed, owner, fingerprint, '', () => ID_A, now), ID_A)
  assert.equal(malformed.getItem('atelier_schedule_request_garbage'), null)
  assert.equal(JSON.parse(malformed.getItem(key)).requestId, ID_A)

  const denied = {
    length: 0,
    key() { throw new Error('denied') },
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
    removeItem() { throw new Error('denied') },
  }
  assert.equal(store.claimScheduleRequestId(denied, owner, fingerprint, '', () => ID_A, now), ID_A)
  assert.equal(store.claimScheduleRequestId(storage, '', fingerprint, '', () => ID_A, now), ID_A)
  assert.equal(store.claimScheduleRequestId(storage, owner, 'Bad Fingerprint', '', () => ID_B, now), ID_B)

  const occupied = memoryStorage()
  store.claimScheduleRequestId(occupied, owner, fingerprint, '', () => ID_A, now)
  assert.equal(store.claimScheduleRequestId(occupied, owner, fingerprint, ID_B, () => ID_C, now), ID_B)
  assert.equal(store.claimScheduleRequestId(occupied, owner, fingerprint, '', () => ID_C, now), ID_A, 'an in-memory retry must not replace the id another tab stored')

  const page = fs.readFileSync(path.join(root, 'app/email/page.tsx'), 'utf8')
  const schedule = page.slice(page.indexOf('async function handleSchedule'), page.indexOf('function handleFileSelect'))
  assert.equal(page.includes('sessionStorage'), false)
  assert.equal(page.includes('second tabs through sessionStorage'), false)
  assert.ok(schedule.includes('claimScheduleRequestId(localStorage'))
  assert.match(schedule, /localStorage for this account and draft fingerprint/)
  const reauth = schedule.indexOf('if (data.reauth)')
  const clearOn4xx = schedule.indexOf('res.status >= 400 && res.status < 500) clearScheduleRequest(owner, fingerprint)')
  const clearOnSuccess = schedule.lastIndexOf('clearScheduleRequest(owner, fingerprint)')
  assert.ok(reauth > 0 && reauth < clearOn4xx && clearOn4xx < clearOnSuccess)
  assert.equal(schedule.slice(reauth, schedule.indexOf('return', reauth)).includes('clearScheduleRequest'), false)
  const caught = schedule.slice(schedule.lastIndexOf('} catch {'))
  assert.equal(caught.includes('clearScheduleRequest'), false)
  assert.equal(caught.includes('forgetScheduleRequestId'), false)
})
