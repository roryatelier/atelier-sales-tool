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
  db.exec(`CREATE TABLE scheduled_emails (id INTEGER PRIMARY KEY, to_email TEXT, cc TEXT, bcc TEXT, subject TEXT, body TEXT, brand_name TEXT, contact_name TEXT, owner_google_sub TEXT, owner_email TEXT, credential_ciphertext TEXT, dossier_json TEXT, scheduled_at TEXT, delivery_status TEXT, claimed_at TEXT, attempt_count INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, sent_at TEXT, gmail_message_id TEXT, last_error_code TEXT, claim_token TEXT, send_intent_at TEXT, next_attempt_at TEXT, timezone TEXT); CREATE TABLE contact_history (brand_name TEXT, contact_role TEXT, contact_name TEXT, contact_email TEXT, method TEXT)`)
  let calls = 0
  const behavior = { refresh: { accessToken: 'synthetic' }, sendError: null, onSend: null }
  const cache = new Map()
  const load = relative => {
    const filename = path.resolve(root, relative)
    if (cache.has(filename)) return cache.get(filename)
    const exports = {}; cache.set(filename, exports)
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInNewContext(source, { exports, process: { env: { CRON_SECRET: 'synthetic', GMAIL_CLIENT_ID: 'synthetic', GMAIL_CLIENT_SECRET: 'synthetic' } }, crypto: globalThis.crypto, console, setTimeout, clearTimeout, require: name => {
      if (name === '@/lib/api-auth') return { authorizeRequest: async () => ({ session: { googleSub: 'owner', email: 'owner@example.invalid' } }) }
      if (name === '@/lib/session') return { getGmailCredentials: async () => ({ refreshToken: 'synthetic' }) }
      if (name === '@/lib/db') return { initialiseDb: async () => {}, isVercel: false, getLocalDb: () => new Proxy(db, { get: (target, prop) => prop === 'close' ? () => {} : typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop] }) }
      if (name === '@/lib/auth-policy') return { sealGmailCredentials: async () => 'fresh-synthetic', openGmailCredentials: async () => ({ refreshToken: 'synthetic' }), isAuthorizedEmail: () => true }
      if (name === '@/lib/gmail') return { makeEmailRaw: () => 'synthetic', refreshGmailToken: async () => 'synthetic', refreshScheduledGmailToken: async () => behavior.refresh, sendViaGmail: async () => { calls++; if (behavior.onSend) await behavior.onSend(); if (behavior.sendError) throw behavior.sendError; return 'synthetic-message' } }
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
