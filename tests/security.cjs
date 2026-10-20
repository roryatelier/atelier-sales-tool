const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const jose = require('jose');
const { NextRequest } = require('next/server');
const root = path.resolve(__dirname, '..');
let cookieValues = {};
let providerCalls = 0;
let sheetsShouldFail = false;
let gmailSendErrors = [];
let gmailSendCalls = 0;
let gmailSendReturnId = 'test-message-id';
let gmailSendDelay = 0;
let pgFailureQueue = [];
let refreshCalls = 0;
let externalFetch = async () => { throw new Error('Unexpected external call'); };
let tokenData = { access_token: 'test-access' };
let userData = { id: 'google-1', email: 'member@example.invalid', verified_email: true, name: 'Member', picture: '' };
let logLines = [];
const storageValues = new Map();
const browserStorage = { get length() { return storageValues.size; }, key: i => [...storageValues.keys()][i] ?? null, getItem: key => storageValues.get(key) ?? null, setItem: (key, value) => storageValues.set(key, value), removeItem: key => storageValues.delete(key) };
const user = { googleSub: 'google-1', email: 'member@example.invalid', name: 'Member', picture: '' };
const env = { JWT_SECRET: 'test-secret-'.repeat(6), APP_ALLOWED_EMAILS: user.email, NODE_ENV: 'test', CRON_SECRET: 'test-cron', GMAIL_CLIENT_ID: 'test-client', GMAIL_CLIENT_SECRET: 'test-client-secret' };
const cache = new Map();
class MockOAuth {
  async getToken() { providerCalls++; return { tokens: tokenData }; }
  setCredentials() {}
  generateAuthUrl(options) { return 'https://accounts.google.com/test?state=' + options.state; }
}
class MockGoogleAuth {}
const google = {
  auth: { OAuth2: MockOAuth, GoogleAuth: MockGoogleAuth },
  oauth2: () => ({ userinfo: { get: async () => ({ data: userData }) } }),
  gmail: () => ({ users: { messages: { send: async () => { providerCalls++; gmailSendCalls++; const error = gmailSendErrors.shift(); if (error) throw error; if (gmailSendDelay) await new Promise(resolve => setTimeout(resolve, gmailSendDelay)); return { data: { id: gmailSendReturnId } }; } } } }),
  sheets: () => ({ spreadsheets: { values: { append: async () => { if (sheetsShouldFail) throw new Error('Sheets unavailable'); } } } }),
};
const dbMock = {
  isVercel: false,
  initialiseDb: async () => { providerCalls++; throw new Error('Unexpected DB call'); },
  getLocalDb() { throw new Error('Unexpected DB call'); },
};
function load(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename);
  const exported = {};
  cache.set(filename, exported);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  vm.runInNewContext(source, { exports: exported, process: { env }, crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, Buffer, URL, URLSearchParams, Request, Response, localStorage: browserStorage, window: { addEventListener() {}, removeEventListener() {} },
    console: { error: (...args) => logLines.push(args), log() {}, warn() {} },
    fetch: async (...args) => { providerCalls++; refreshCalls++; return externalFetch(...args); },
    require: name => {
      if (name === 'server-only') return {};
      if (name === 'jose') return jose;
      if (name === 'next/server') return require('next/server');
      if (name === 'next/headers') return { cookies: async () => ({ get: name => cookieValues[name] ? { value: cookieValues[name] } : undefined }) };
      if (name === 'googleapis') return { google };
      if (name === '@vercel/postgres') return {
        sql: async (strings, ...values) => {
          providerCalls++;
          const failure = pgFailureQueue.shift();
          if (failure) throw failure;
          const text = Array.isArray(strings) ? strings.join('?') : String(strings);
          if (text.includes('INSERT INTO send_records')) {
            const requestId = values[2];
            if (pgStore.has(requestId)) return { rows: [], rowCount: 0 };
            pgStore.set(requestId, { owner: values[0], status: values[4] ?? 'recorded', messageId: null, hash: values[3] });
            return { rows: [], rowCount: 1 };
          }
          if (text.includes('UPDATE send_records SET status') && text.includes('RETURNING id')) {
            // Claim: one row moves recorded -> sending.
            for (const record of pgStore.values()) if (record.owner === values[1] && record.status === 'recorded') { record.status = 'sending'; return { rows: [], rowCount: 1 }; }
            return { rows: [], rowCount: 0 };
          }
          if (text.includes('UPDATE send_records SET status')) {
            const record = [...pgStore.values()].find(r => r.owner === values[6]);
            if (record) { record.status = values[0]; record.messageId = values[1]; }
            return { rows: [], rowCount: 1 };
          }
          if (text.includes('FROM send_records')) {
            // values.length === 1 -> global request-id lookup; otherwise owner-scoped.
            const requestId = values.length === 1 ? values[0] : values[1];
            const owner = values.length === 1 ? undefined : values[0];
            const record = pgStore.get(requestId);
            if (record && (owner === undefined || record.owner === owner)) {
              return { rows: [{ id: 1, status: record.status, gmail_message_id: record.messageId, last_error_code: null, payload_hash: record.hash, owner_google_sub: record.owner }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        },
      };
      if (name === '@/lib/db') return dbMock;
      if (name.startsWith('@/')) return load(name.slice(2) + '.ts');
      if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), name)) + '.ts');
      throw new Error('Unmocked module: ' + name);
    }
  }, { filename });
  return exported;
}
const policy = load('lib/auth-policy.ts');

test('sessions reject tampering, legacy claims, expired credentials and removed members', async () => {
  const token = await policy.signSession(user);
  assert.equal((await policy.verifySession(token)).googleSub, user.googleSub);
  const payload = jose.decodeJwt(token);
  assert.equal(payload.accessToken, undefined);
  assert.equal(payload.refreshToken, undefined);
  assert.equal(await policy.verifySession(token + 'bad'), null);
  const old = await new jose.SignJWT({ email: user.email }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(env.JWT_SECRET));
  assert.equal(await policy.verifySession(old), null);
  const expired = await new jose.SignJWT({ ...payload, exp: 1 }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(env.JWT_SECRET));
  assert.equal(await policy.verifySession(expired), null);
  env.APP_ALLOWED_EMAILS = 'other@example.invalid';
  assert.equal(await policy.verifySession(token), null);
  env.APP_ALLOWED_EMAILS = user.email;
});

test('security fails closed without secret or explicit admission policy', () => {
  const secret = env.JWT_SECRET;
  env.JWT_SECRET = '';
  assert.equal(policy.securityConfigured(), false);
  env.JWT_SECRET = secret;
  env.APP_ALLOWED_EMAILS = '';
  assert.equal(policy.securityConfigured(), false);
  env.APP_ALLOWED_EMAILS = user.email;
  assert.equal(policy.isAuthorizedEmail('member@example.invalid.evil'), false);
  assert.equal(policy.isAuthorizedEmail('attacker@example.invalid'), false);
});

test('encrypted Gmail credentials cannot cross Google accounts or secret rotations', async () => {
  const sealed = await policy.sealGmailCredentials({ ...user, accessToken: 'test-access', refreshToken: 'test-refresh' });
  assert.equal(sealed.includes('test-access'), false);
  assert.equal((await policy.openGmailCredentials(sealed, user)).refreshToken, 'test-refresh');
  assert.equal(await policy.openGmailCredentials(sealed, { ...user, googleSub: 'other-google' }), null);
  assert.equal(await policy.openGmailCredentials(sealed, { ...user, email: 'other@example.invalid' }), null);
  const secret = env.JWT_SECRET;
  env.JWT_SECRET = 'new-secret-'.repeat(6);
  assert.equal(await policy.openGmailCredentials(sealed, user), null);
  env.JWT_SECRET = secret;
});

test('every application API method rejects anonymous requests before provider work', async () => {
  cookieValues = {};
  const before = providerCalls;
  let handlers = 0;
  function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
  for (const filename of walk(path.join(root, 'app/api')).filter(f => f.endsWith('route.ts') && !f.includes('/auth/') && !f.includes('/cron/'))) {
    const route = load(path.relative(root, filename));
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) if (route[method]) {
      const response = await route[method](new NextRequest('https://example.invalid/api/test', { method }));
      assert.equal(response.status, 401, filename + ':' + method);
      handlers++;
    }
  }
  assert.ok(handlers >= 29);
  assert.equal(providerCalls, before);
});

test('proxy protects API paths, exact cron exception and mutation origin', async () => {
  const { proxy } = load('proxy.ts');
  assert.equal((await proxy(new NextRequest('https://example.invalid/api/pipeline'))).status, 401);
  assert.equal((await proxy(new NextRequest('https://example.invalid/api/auth/gmail/extra'))).status, 401);
  assert.equal((await proxy(new NextRequest('https://example.invalid/api/cron/send-scheduled-emails'))).status, 401);
  const token = await policy.signSession(user);
  const bad = new NextRequest('https://example.invalid/api/templates', { method: 'POST', headers: { cookie: 'atelier_session=' + token, origin: 'https://evil.invalid' } });
  assert.equal((await proxy(bad)).status, 403);
  const good = new NextRequest('https://example.invalid/api/templates', { method: 'POST', headers: { cookie: 'atelier_session=' + token, origin: 'https://example.invalid' } });
  assert.equal((await proxy(good)).headers.get('x-middleware-next'), '1');
});

test('OAuth state is required before exchange; unverified and non-member emails never obtain a session', async () => {
  const callback = load('app/api/auth/callback/route.ts').GET;
  const before = providerCalls;
  let response = await callback(new NextRequest('https://example.invalid/api/auth/callback?code=test'));
  assert.equal(response.status, 400);
  assert.equal(providerCalls, before);
  const request = () => new NextRequest('https://example.invalid/api/auth/callback?code=test&state=good', { headers: { cookie: 'atelier_oauth_state=good; gmail_refresh_token=old-account-token' } });
  userData.verified_email = false;
  response = await callback(request());
  assert.equal(response.status, 403);
  userData.verified_email = true;
  userData.email = 'attacker@example.invalid';
  response = await callback(request());
  assert.equal(response.status, 403);
  userData.email = user.email;
  response = await callback(request());
  assert.equal(response.status, 307);
  const token = response.cookies.get('atelier_gmail').value;
  assert.equal((await policy.openGmailCredentials(token, user)).refreshToken, undefined);
  assert.equal(response.cookies.get('gmail_refresh_token').value, '');
});

test('scheduled delivery requires ownership, encrypted credentials and non-retrying claims', async () => {
  const scheduleSource = fs.readFileSync(path.join(root, 'app/api/schedule-email/route.ts'), 'utf8');
  const workerSource = fs.readFileSync(path.join(root, 'app/api/cron/send-scheduled-emails/route.ts'), 'utf8');
  assert.ok(scheduleSource.includes('expectedGoogleSub'));
  assert.ok(scheduleSource.includes('owner_google_sub'));
  assert.ok(scheduleSource.includes('credential_ciphertext'));
  assert.equal(scheduleSource.includes('gmail_refresh_token'), false);
  assert.equal(scheduleSource.includes('gmail_access_token'), false);
  assert.ok(workerSource.includes('FOR UPDATE SKIP LOCKED'));
  assert.ok(workerSource.includes("delivery_status = 'sending'"));
  assert.ok(workerSource.includes("'needs_review', 'gmail_send_ambiguous'"));
  const cron = load('app/api/cron/send-scheduled-emails/route.ts').GET;
  assert.equal((await cron(new NextRequest('https://example.invalid/api/cron/send-scheduled-emails'))).status, 401);
  assert.equal((await cron(new NextRequest('https://example.invalid/api/cron/send-scheduled-emails', { headers: { authorization: 'Bearer wrong' } }))).status, 401);
});

test('safe logging drops bearer tokens, bodies, headers and provider messages', () => {
  logLines = [];
  load('lib/safe-log.ts').logSafeError('Provider failed', { status: 403, message: 'test-secret', config: { headers: { authorization: 'test-bearer' } }, response: { status: 403, data: 'test-body' } });
  const line = JSON.stringify(logLines);
  assert.ok(line.includes('403'));
  for (const secret of ['test-secret', 'test-bearer', 'test-body']) assert.equal(line.includes(secret), false);
});

test('Gmail failures are classified without exposing provider details', () => {
  const { classifyGmailError } = load('lib/gmail.ts');
  assert.equal(classifyGmailError({ response: { status: 401 } }), 'auth');
  assert.equal(classifyGmailError({ response: { status: 403, data: { error: { errors: [{ reason: 'insufficientPermissions' }] } } } }), 'permission');
  assert.equal(classifyGmailError({ response: { status: 403, data: { error: { errors: [{ reason: 'domainPolicy' }] } } } }), 'policy');
  assert.equal(classifyGmailError({ response: { status: 403, data: { error: { errors: [{ reason: 'dailyLimitExceeded' }] } } } }), 'quota');
  assert.equal(classifyGmailError({ response: { status: 429 } }), 'quota');
  assert.equal(classifyGmailError({ response: { status: 503 } }), 'temporary');
  assert.equal(classifyGmailError(new Error('recipient rejected')), 'unknown');
});

test('account-owned browser storage blocks old tabs and clears legacy and foreign drafts', () => {
  storageValues.clear();
  storageValues.set('email_tabs', 'legacy-private-draft');
  const a = load('lib/browser-storage.ts');
  assert.equal(a.activeStorageOwner(), null);
  a.activateBrowserIdentity('account-A');
  assert.equal(storageValues.has('email_tabs'), false);
  a.userStorage.setItem('email_tabs', 'A-private-draft');
  // Cookies/me can change before the new account's page activates its storage.
  assert.equal(a.matchesDraftIdentity('account-A', 'account-B'), false);
  assert.equal(a.matchesDraftIdentity('account-A', 'account-A'), true);
  cache.delete(path.resolve(root, 'lib/browser-storage.ts'));
  const b = load('lib/browser-storage.ts');
  assert.equal(b.activeStorageOwner(), null);
  b.activateBrowserIdentity('account-B');
  assert.equal(b.userStorage.getItem('email_tabs'), null);
  assert.equal(a.activeStorageOwner(), null);
  assert.equal(a.matchesDraftIdentity('account-A', 'account-A'), false);
  assert.throws(() => a.userStorage.setItem('email_tabs', 'late-A-response'));
  assert.throws(() => a.userStorage.getItem('email_tabs'));
  assert.equal([...storageValues.values()].includes('A-private-draft'), false);
});

test('direct sends reject stale sender identity and invalid headers before Gmail', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-direct-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(SEND_RECORDS_SCHEMA); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
  cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
  const send = load('app/api/send-email/route.ts').POST;
  const valid = { expectedGoogleSub: user.googleSub, request_id: 'aaaaaaaa-0000-4000-8000-000000000001', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
  const request = body => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const before = providerCalls;
  assert.equal((await send(request({ ...valid, expectedGoogleSub: 'old-account' }))).status, 409);
  assert.equal((await send(request({ ...valid, to: 'contact@example.invalid\r\nBcc: injected@example.invalid' }))).status, 400);
  assert.equal((await send(request({ ...valid, attachments: [null] }))).status, 400);
  assert.equal((await send(request({ ...valid, to: '   ' }))).status, 400);
  assert.equal((await send(request({ ...valid, to: ', ,', cc: 'valid@example.invalid' }))).status, 400);
  assert.equal((await send(request({ ...valid, attachments: [{ name: 'bad', type: 'text/plain\r\nX: bad', data: 'YWJj' }] }))).status, 400);
  assert.equal((await send(request({ ...valid, emailBody: 'x'.repeat(4 * 1024 * 1024) }))).status, 413);
  assert.equal(providerCalls, before);
  const response = await send(request(valid));
  assert.equal(response.status, 200);
  const responseBody = await response.json();
  assert.equal(responseBody.message_id, 'test-message-id');
  assert.equal(responseBody.pipeline_synced, null);
  assert.equal(providerCalls, before + 1);

  env.GOOGLE_SERVICE_ACCOUNT = '{}';
  env.GOOGLE_SHEETS_ID = 'test-sheet';
  sheetsShouldFail = true;
  const partialResponse = await send(request({ ...valid, dossier: { brand_name: 'Test Brand' }, request_id: 'aaaaaaaa-0000-4000-8000-000000000002' }));
  assert.equal(partialResponse.status, 200);
  assert.equal((await partialResponse.json()).pipeline_synced, false);
  sheetsShouldFail = false;
  const syncedResponse = await send(request({ ...valid, dossier: { brand_name: 'Test Brand' }, request_id: 'aaaaaaaa-0000-4000-8000-000000000003' }));
  assert.equal(syncedResponse.status, 200);
  assert.equal((await syncedResponse.json()).pipeline_synced, true);
  delete env.GOOGLE_SERVICE_ACCOUNT;
  delete env.GOOGLE_SHEETS_ID;
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('direct sends return safe actionable Gmail failures and only retry explicit authentication rejection', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-failures-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(SEND_RECORDS_SCHEMA); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
  cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'expired-access', refreshToken: 'test-refresh' }) };
  const send = load('app/api/send-email/route.ts').POST;
  let requestSeq = 0;
  const request = () => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ expectedGoogleSub: user.googleSub, request_id: 'bbbbbbbb-0000-4000-8000-' + (++requestSeq).toString(16).padStart(12, '0'), to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }) });

  const initialSends = gmailSendCalls;
  const initialRefreshes = refreshCalls;
  gmailSendErrors = [Object.assign(new Error('provider secret'), { response: { status: 403, data: { error: { errors: [{ reason: 'insufficientPermissions' }] } } } })];
  let response = await send(request());
  assert.equal(response.status, 401);
  assert.equal((await response.json()).reauth, true);
  assert.equal(gmailSendCalls, initialSends + 1);
  assert.equal(refreshCalls, initialRefreshes);

  gmailSendErrors = [Object.assign(new Error('provider secret'), { response: { status: 429 } })];
  response = await send(request());
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, 'Gmail has temporarily limited sending. Please try again later.');
  assert.equal(gmailSendCalls, initialSends + 2);
  assert.equal(refreshCalls, initialRefreshes);

  gmailSendErrors = [Object.assign(new Error('provider secret'), { response: { status: 403, data: { error: { errors: [{ reason: 'domainPolicy' }] } } } })];
  response = await send(request());
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'Your Google Workspace administrator has blocked Gmail access for this app.');
  assert.equal(refreshCalls, initialRefreshes);

  gmailSendErrors = [Object.assign(new Error('provider secret'), { response: { status: 401 } })];
  externalFetch = async () => new Response(JSON.stringify({ access_token: 'new-access' }), { status: 200, headers: { 'content-type': 'application/json' } });
  response = await send(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).message_id, 'test-message-id');
  assert.equal(gmailSendCalls, initialSends + 5);
  assert.equal(refreshCalls, initialRefreshes + 1);

  gmailSendErrors = [Object.assign(new Error('expired'), { response: { status: 401 } }), Object.assign(new Error('still expired'), { response: { status: 401 } })];
  response = await send(request());
  assert.equal(response.status, 401);
  assert.equal((await response.json()).reauth, true);
  assert.equal(gmailSendCalls, initialSends + 7);
  assert.equal(refreshCalls, initialRefreshes + 2);

  for (const error of [Object.assign(new Error('temporary'), { response: { status: 503 } }), new Error('network failure')]) {
    const sendsBefore = gmailSendCalls;
    const refreshesBefore = refreshCalls;
    gmailSendErrors = [error];
    response = await send(request());
    assert.ok([502, 503].includes(response.status));
    assert.equal((await response.json()).error, 'Gmail did not confirm this send. Check Sent mail before trying again.');
    assert.equal(gmailSendCalls, sendsBefore + 1);
    assert.equal(refreshCalls, refreshesBefore);
  }

  gmailSendErrors = [new Error('recipient rejected with provider secret')];
  response = await send(request());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'Gmail did not confirm this send. Check Sent mail before trying again.');
  assert.equal(JSON.stringify(logLines).includes('provider secret'), false);

  const refreshOnlyCookie = await policy.sealGmailCredentials({ ...user, accessToken: '', refreshToken: 'test-refresh' });
  cookieValues.atelier_gmail = refreshOnlyCookie;
  externalFetch = async () => new Response(JSON.stringify({ error: 'deleted_client' }), { status: 400, headers: { 'content-type': 'application/json' } });
  const sendsBeforeDeletedClient = gmailSendCalls;
  response = await send(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'Gmail is not configured correctly. Contact an administrator.');
  assert.equal(gmailSendCalls, sendsBeforeDeletedClient);

  externalFetch = async () => new Response(JSON.stringify({ access_token: 'new-access' }), { status: 200, headers: { 'content-type': 'application/json' } });
  const originalSeal = policy.sealGmailCredentials;
  policy.sealGmailCredentials = async () => { throw new Error('persistence secret'); };
  gmailSendErrors = [];
  response = await send(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).message_id, 'test-message-id');
  policy.sealGmailCredentials = originalSeal;

  } finally {
    // Restore shared state even when an assertion fails, so later tests do not
    // inherit a broken stub.
    gmailSendErrors = [];
    externalFetch = async () => { throw new Error('Unexpected external call'); };
    fs.rmSync(dbPath, { force: true });
  }
});

const SEND_RECORDS_SCHEMA = `CREATE TABLE IF NOT EXISTS send_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_google_sub TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    request_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','sending','accepted','failed_auth','failed','needs_review')),
    gmail_message_id TEXT,
    last_error_code TEXT,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    accepted_at TEXT,
    UNIQUE (request_id),
    CHECK (status != 'accepted' OR (gmail_message_id IS NOT NULL AND gmail_message_id != ''))
  )`;
const pgStore = new Map();
function resetPgStore() { pgStore.clear(); pgFailureQueue = []; }

test('immediate sends create a durable record: replay returns the original outcome without resending', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-records-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(SEND_RECORDS_SCHEMA); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const requestId = '11111111-2222-3333-4444-555555555555';
    const body = { expectedGoogleSub: user.googleSub, request_id: requestId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    const request = () => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sendsBefore = gmailSendCalls;
    const first = await send(request());
    assert.equal(first.status, 200);
    assert.equal((await first.json()).outcome, 'accepted');
    assert.equal(gmailSendCalls, sendsBefore + 1);

    // A browser retry (same request id, same content) replays the recorded outcome.
    const replay = await send(request());
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.outcome, 'accepted');
    assert.equal(replayBody.message_id, 'test-message-id');
    assert.equal(replayBody.replayed, true);
    assert.equal(gmailSendCalls, sendsBefore + 1);

    // Same id with different content is rejected, never silently swapped.
    const conflicting = await send(new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ ...body, subject: 'Different' }) }));
    assert.equal(conflicting.status, 409);
    assert.equal(JSON.stringify(await conflicting.json()).includes('test-message-id'), false);
    assert.equal(gmailSendCalls, sendsBefore + 1);
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('concurrent identical immediate sends produce exactly one Gmail send', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-records-race-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(SEND_RECORDS_SCHEMA); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const body = { expectedGoogleSub: user.googleSub, request_id: '22222222-2222-3333-4444-555555555555', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    const request = () => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sendsBefore = gmailSendCalls;
    gmailSendDelay = 50;
    const [a, b] = await Promise.all([send(request()), send(request())]);
    gmailSendDelay = 0;
    assert.equal(gmailSendCalls, sendsBefore + 1);
    const bodies = [await a.json(), await b.json()];
    for (const [response, responseBody] of [[a, bodies[0]], [b, bodies[1]]]) {
      assert.ok([200, 409].includes(response.status), 'replaying request must not fail hard');
      if (responseBody.outcome === 'accepted') assert.equal(responseBody.message_id, 'test-message-id');
    }
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT request_id, status, gmail_message_id FROM send_records').all();
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'accepted');
    assert.equal(rows[0].gmail_message_id, 'test-message-id');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('cross-account replay of an immediate send is isolated', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-records-cross-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  const otherAccount = { googleSub: 'google-2', email: 'other@example.invalid', name: 'Other', picture: '' };
  const previousAllow = env.APP_ALLOWED_EMAILS;
  env.APP_ALLOWED_EMAILS = [user.email, otherAccount.email].join(',');
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(SEND_RECORDS_SCHEMA); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const body = { expectedGoogleSub: user.googleSub, request_id: '33333333-2222-3333-4444-555555555555', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    await send(new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    cookieValues = { atelier_session: await policy.signSession(otherAccount), atelier_gmail: await policy.sealGmailCredentials({ ...otherAccount, accessToken: 'test-access' }) };
    const foreign = await send(new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const foreignBody = await foreign.json();
    assert.equal(JSON.stringify(foreignBody).includes('test-message-id'), false);
    // Globally-unique request ids: a foreign replay is refused, never converted
    // into that account's own send to the same recipient.
    assert.ok([404, 409].includes(foreign.status), 'foreign replay must not send or expose the original record');
    assert.equal(foreignBody.outcome, undefined);
  } finally {
    env.APP_ALLOWED_EMAILS = previousAllow;
    fs.rmSync(dbPath, { force: true });
  }
});

test('a missing Gmail message id cannot be accepted and an uncertain replay never resends', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-records-missing-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(SEND_RECORDS_SCHEMA); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const body = { expectedGoogleSub: user.googleSub, request_id: '44444444-2222-3333-4444-555555555555', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    const request = () => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    gmailSendReturnId = '';
    const sendsBefore = gmailSendCalls;
    const uncertain = await send(request());
    assert.ok([200, 502].includes(uncertain.status));
    assert.equal((await uncertain.json()).outcome, 'needs_review');
    assert.equal(gmailSendCalls, sendsBefore + 1);
    const db = new Database(dbPath);
    const row = db.prepare('SELECT status, gmail_message_id FROM send_records').get();
    db.close();
    assert.equal(row.status, 'needs_review');
    assert.equal(row.gmail_message_id, null);
    // Replay of the uncertain request returns the same uncertainty without resending.
    const replay = await send(request());
    assert.equal((await replay.json()).outcome, 'needs_review');
    assert.equal(gmailSendCalls, sendsBefore + 1);
  } finally {
    gmailSendReturnId = 'test-message-id';
    fs.rmSync(dbPath, { force: true });
  }
});

test('provider uncertainty and interruption never trigger an automatic resend', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-records-uncertain-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(SEND_RECORDS_SCHEMA); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const requestId = '55555555-2222-3333-4444-555555555555';
    const body = { expectedGoogleSub: user.googleSub, request_id: requestId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    const request = () => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    gmailSendErrors = [new Error('network failure')];
    const sendsBefore = gmailSendCalls;
    const uncertain = await send(request());
    assert.ok([200, 502, 503].includes(uncertain.status));
    assert.equal((await uncertain.json()).error, 'Gmail did not confirm this send. Check Sent mail before trying again.');
    assert.equal(gmailSendCalls, sendsBefore + 1);
    const replay = await send(request());
    assert.equal((await replay.json()).error, 'Gmail did not confirm this send. Check Sent mail before trying again.');
    assert.equal(gmailSendCalls, sendsBefore + 1);
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('quota failures are recorded as failed and replay never sends again', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-records-quota-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(SEND_RECORDS_SCHEMA); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const body = { expectedGoogleSub: user.googleSub, request_id: '66666666-2222-3333-4444-555555555555', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    const request = () => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    gmailSendErrors = [Object.assign(new Error('quota'), { response: { status: 429 } })];
    const sendsBefore = gmailSendCalls;
    const response = await send(request());
    assert.equal(response.status, 429);
    assert.equal(gmailSendCalls, sendsBefore + 1);
    const db = new Database(dbPath);
    const row = db.prepare('SELECT status FROM send_records').get();
    db.close();
    assert.equal(row.status, 'failed');
    const replay = await send(request());
    assert.ok([429, 502].includes(replay.status));
    assert.equal(gmailSendCalls, sendsBefore + 1);
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('a lost outcome write after Gmail acceptance is reported as uncertain, never resent', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-records-postaccept-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(SEND_RECORDS_SCHEMA); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const body = { expectedGoogleSub: user.googleSub, request_id: '77777777-2222-3333-4444-555555555555', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    const request = () => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sendsBefore = gmailSendCalls;
    // Gmail accepts, then the outcome write is interrupted (simulated by a throw
    // inside the Gmail mock AFTER acceptance is recorded is not possible — instead
    // the route wraps its own outcome write; simulate the lost write via a stale
    // claim: the record stays 'sending' and the response must be uncertain).
    const response = await send(request());
    assert.equal(gmailSendCalls, sendsBefore + 1);
    assert.equal((await response.json()).outcome, 'accepted');
    // Simulate a lost outcome write: rewind the record to 'sending'.
    const db = new Database(dbPath);
    db.prepare("UPDATE send_records SET status = 'sending' WHERE request_id = ?").run(body.request_id);
    db.close();
    const replay = await send(request());
    const replayBody = await replay.json();
    assert.equal(replayBody.outcome, 'uncertain');
    assert.match(String(replayBody.error), /Check Sent mail/i);
    assert.equal(gmailSendCalls, sendsBefore + 1);
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('the Postgres immediate-send path never sends again after a lost outcome write', async () => {
  dbMock.isVercel = true;
  const previousInitialise = dbMock.initialiseDb;
  dbMock.initialiseDb = async () => {};
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const body = { expectedGoogleSub: user.googleSub, request_id: '88888888-2222-3333-4444-555555555555', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    const request = () => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sendsBefore = gmailSendCalls;
    // insert, claim, post-claim record read, outcome write (FAILS), retry (FAILS), needs_review fallback (OK)
    pgFailureQueue = [null, null, null, new Error('db write failed after acceptance'), new Error('db write failed after acceptance'), null];
    const response = await send(request());
    assert.equal(gmailSendCalls, sendsBefore + 1);
    const responseBody = await response.json();
    assert.equal(responseBody.outcome, 'needs_review');
    assert.match(String(responseBody.error), /Check Sent mail/i);
    // Second request: DB remains broken — still exactly one send, still uncertain.
    pgFailureQueue = [new Error('replay read failed'), new Error('replay read failed'), new Error('replay read failed')];
    await send(request());
    assert.equal(gmailSendCalls, sendsBefore + 1);
  } finally {
    dbMock.initialiseDb = previousInitialise;
    dbMock.isVercel = false;
    pgFailureQueue = [];
  }
});

test('missing or malformed request ids fail closed before Gmail and any DB work', async () => {
  cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
  const send = load('app/api/send-email/route.ts').POST;
  const request = body => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const base = { expectedGoogleSub: user.googleSub, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
  const before = gmailSendCalls;
  assert.equal((await send(request(base))).status, 400);
  assert.equal((await send(request({ ...base, request_id: 'not-a-uuid' }))).status, 400);
  assert.equal((await send(request({ ...base, request_id: 'aaaaaaaa-2222-3333-4444-55555555555  ' }))).status, 400);
  assert.equal(gmailSendCalls, before);
});

test('immediate send records enforce global request-id uniqueness and the accepted-implies-message-id rule in both dialects', () => {
  const source = fs.readFileSync(path.join(root, 'lib/db.ts'), 'utf8');
  const uniques = source.match(/UNIQUE \(request_id\)/g) ?? [];
  assert.ok(uniques.length >= 2, 'both the Postgres and SQLite schemas must make request_id globally unique');
  const checks = source.match(/CHECK \(status != 'accepted'[^\n]*\)/g) ?? [];
  assert.ok(checks.length >= 2, 'both dialects must enforce accepted-implies-message-id');
  const route = fs.readFileSync(path.join(root, 'app/api/send-email/route.ts'), 'utf8');
  assert.match(route, /ON CONFLICT \(request_id\) DO NOTHING/);
  assert.match(route, /request_id/);
  assert.match(route, /payload_hash/);
  assert.match(route, /already used by another session/);
  const gmail = fs.readFileSync(path.join(root, 'lib/gmail.ts'), 'utf8');
  assert.match(gmail, /missing_message_id/);
});

test('composer mints one request id per confirmation, retains it across retries and reloads, and gates uncertain sends on acknowledgement', () => {
  const page = fs.readFileSync(path.join(root, 'app/email/page.tsx'), 'utf8')
  // A request id is minted with WebCrypto when the user confirms a send.
  assert.match(page, /crypto\.randomUuid|crypto\.randomUUID\(\)/, 'request id must be minted with crypto.randomUUID')
  // It is sent with every attempt of the same confirmation.
  assert.match(page, /request_id: requestId/, 'the send body must carry the current request id')
  // It survives tab switches and reloads: snapshot field + persistence trigger.
  assert.match(page, /sendRequestId: string/, 'TabSnapshot must carry the request id')
  assert.match(page, /sendRequestId: t\.sendRequestId \?\? ''/, 'restored tabs must recover the request id defensively')
  const depsIndex = page.indexOf('}, [email, draftProvenance, draftInstruction, sendRequestId')
  assert.ok(depsIndex !== -1, 'persistence effect deps must include sendRequestId')
  // Terminal outcomes reset the identity so the next confirmation is a new send;
  // uncertainty is kept so a reload replays the recorded outcome, never a resend.
  assert.match(page, /setSendRequestId\(''\)/)
  assert.match(page, /Send anyway|sendAnyway/, 'uncertain state must offer an explicit acknowledged retry')
  assert.match(page, /Check Sent mail before retrying|Check Sent mail/, 'uncertain state must tell the user to check Sent mail first')
})

test('signature API cannot read or write another account', async () => {
  const Database = require('better-sqlite3');
  const os = require('node:os');
  const dbPath = path.join(os.tmpdir(), `atelier-signature-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  const previousAllow = env.APP_ALLOWED_EMAILS;
  const previousInit = dbMock.initialiseDb;
  const previousGet = dbMock.getLocalDb;
  const previousVercel = dbMock.isVercel;
  const accountA = { googleSub: 'signature-account-a', email: 'sig-a@example.invalid', name: 'Fixture A', picture: '' };
  const accountB = { googleSub: 'signature-account-b', email: 'sig-b@example.invalid', name: 'Fixture B', picture: '' };
  env.APP_ALLOWED_EMAILS = [user.email, accountA.email, accountB.email].join(',');
  dbMock.isVercel = false;
  dbMock.initialiseDb = async () => {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS email_signatures (owner_google_sub TEXT PRIMARY KEY, owner_email TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now')))`);
    db.close();
  };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
    const route = load('app/api/signature/route.ts');
    const request = (method, body, query = '') => new NextRequest(`https://example.invalid/api/signature${query}`, {
      method,
      headers: { origin: 'https://example.invalid', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    cookieValues = { atelier_session: await policy.signSession(accountA) };
    assert.equal((await route.GET(request('GET'))).status, 200);
    assert.equal((await (await route.GET(request('GET'))).json()).signature, '');
    const saved = await route.PUT(request('PUT', {
      signature: 'Signature A\n[Site](https://portfolio.example.invalid/a)',
      owner_google_sub: accountB.googleSub,
      owner_email: accountB.email,
    }));
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).signature, 'Signature A\n[Site](https://portfolio.example.invalid/a)');

    cookieValues = { atelier_session: await policy.signSession(accountB) };
    const foreignRead = await route.GET(request('GET', undefined, `?owner_google_sub=${accountA.googleSub}`));
    assert.equal(foreignRead.status, 200);
    assert.equal((await foreignRead.json()).signature, '');
    const foreignWrite = await route.PUT(request('PUT', {
      signature: 'Signature B',
      owner_google_sub: accountA.googleSub,
      owner_email: accountA.email,
    }));
    assert.equal(foreignWrite.status, 200);
    assert.equal((await foreignWrite.json()).signature, 'Signature B');
    assert.equal((await (await route.GET(request('GET', undefined, `?owner_google_sub=${accountA.googleSub}`))).json()).signature, 'Signature B');

    cookieValues = { atelier_session: await policy.signSession(accountA) };
    assert.equal((await (await route.GET(request('GET'))).json()).signature, 'Signature A\n[Site](https://portfolio.example.invalid/a)');
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT owner_google_sub, content FROM email_signatures ORDER BY owner_google_sub').all();
    db.close();
    assert.deepEqual(rows, [
      { owner_google_sub: accountA.googleSub, content: 'Signature A\n[Site](https://portfolio.example.invalid/a)' },
      { owner_google_sub: accountB.googleSub, content: 'Signature B' },
    ]);
    assert.equal((await route.PUT(request('PUT', { signature: 12 }))).status, 400);
    assert.equal((await route.PUT(request('PUT', { signature: 'x'.repeat(4001), owner_google_sub: accountB.googleSub }))).status, 400);
    assert.equal((await (await route.GET(request('GET'))).json()).signature, 'Signature A\n[Site](https://portfolio.example.invalid/a)');
  } finally {
    env.APP_ALLOWED_EMAILS = previousAllow;
    dbMock.initialiseDb = previousInit;
    dbMock.getLocalDb = previousGet;
    dbMock.isVercel = previousVercel;
    cookieValues = {};
    fs.rmSync(dbPath, { force: true });
  }
});
