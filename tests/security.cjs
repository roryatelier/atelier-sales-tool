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
let gmailSendGate = null;
let pgFailureQueue = [];
let failAcceptedWrites = 0;
let commitAcceptedBeforeFailure = false;
let failOutcomeWrites = 0;
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
  gmail: () => ({ users: { messages: { send: async () => { providerCalls++; gmailSendCalls++; const error = gmailSendErrors.shift(); if (error) throw error; if (gmailSendGate) await gmailSendGate; if (gmailSendDelay) await new Promise(resolve => setTimeout(resolve, gmailSendDelay)); return { data: { id: gmailSendReturnId } }; } } } }),
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
  vm.runInNewContext(source, { exports: exported, process: { env, cwd: () => process.cwd() }, crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, Buffer, URL, URLSearchParams, Request, Response, localStorage: browserStorage, window: { addEventListener() {}, removeEventListener() {} },
    setTimeout, clearTimeout,
    console: { error: (...args) => logLines.push(args), log() {}, warn() {} },
    fetch: async (...args) => { providerCalls++; refreshCalls++; return externalFetch(...args); },
    require: name => {
      if (name === 'server-only') return {};
      if (name === 'jose') return jose;
      if (name === 'next/server') return require('next/server');
      if (name === 'next/headers') return { cookies: async () => ({ get: name => cookieValues[name] ? { value: cookieValues[name] } : undefined }) };
      if (name === 'googleapis') return { google };
      if (name === 'better-sqlite3') return require('better-sqlite3');
      if (name === 'path') return require('path');
      if (name === 'node:crypto') return require('node:crypto');
      if (name === '@vercel/postgres') return {
        sql: async (strings, ...values) => {
          providerCalls++;
          const failure = pgFailureQueue.shift();
          if (failure) throw failure;
          const text = Array.isArray(strings) ? strings.join('?') : String(strings);
          if (!text.includes('send_records')) return { rows: [], rowCount: 0 };
          if (text.includes('INSERT INTO send_records')) {
            const requestId = values[2];
            if (pgStore.has(requestId)) return { rows: [], rowCount: 0 };
            const record = { id: pgNextId++, owner: values[0], requestId, status: 'recorded', messageId: null, errorCode: null, hash: values[3] };
            pgStore.set(requestId, record);
            return { rows: [{ id: record.id }], rowCount: 1 };
          }
          if (text.includes("SET status = 'sending'")) {
            const record = pgFind(Number(values[0]), values[1]);
            if (!record || record.status !== 'recorded') return { rows: [], rowCount: 0 };
            record.status = 'sending';
            return { rows: [{ id: record.id }], rowCount: 1 };
          }
          if (text.includes("SET status = 'recorded'")) {
            const record = text.includes('request_id =') ? pgStore.get(values[0]) : pgFind(Number(values[0]), values[1]);
            if (!record || record.status !== 'sending') return { rows: [], rowCount: 0 };
            if (text.includes('request_id =') && record.owner !== values[1]) return { rows: [], rowCount: 0 };
            record.status = 'recorded';
            record.errorCode = null;
            return { rows: [{ id: record.id }], rowCount: 1 };
          }
          // Only the outcome UPDATE writes gmail_message_id. SELECTs also mention
          // the column and must fall through to the read branch below.
          if (text.includes('UPDATE send_records') && text.includes('gmail_message_id')) {
            const record = pgFind(Number(values[5]), values[6]);
            if (!record || record.status !== 'sending') return { rows: [], rowCount: 0 };
            if (failOutcomeWrites > 0) { failOutcomeWrites -= 1; throw new Error('outcome write failed'); }
            if (values[0] === 'accepted' && failAcceptedWrites > 0) {
              failAcceptedWrites -= 1;
              if (commitAcceptedBeforeFailure) { record.status = 'accepted'; record.messageId = values[1]; record.errorCode = null; }
              throw new Error('accepted write failed');
            }
            record.status = values[0];
            record.messageId = values[1];
            record.errorCode = values[2];
            return { rows: [{ id: record.id }], rowCount: 1 };
          }
          if (text.includes('FROM send_records')) {
            const record = text.includes('WHERE id =') ? pgFind(Number(values[0]), values[1]) : pgStore.get(values[0]);
            if (!record || (text.includes('owner_google_sub') && text.includes('WHERE id =') && record.owner !== values[1])) return { rows: [], rowCount: 0 };
            if (!text.includes('WHERE id =') && text.includes('owner_google_sub') && values.length > 1 && record.owner !== values[0]) return { rows: [], rowCount: 0 };
            return { rows: [{ id: record.id, status: record.status, gmail_message_id: record.messageId, last_error_code: record.errorCode, payload_hash: record.hash, owner_google_sub: record.owner }], rowCount: 1 };
          }
          throw new Error('Unrecognised send_records SQL in the Postgres mock');
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
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) if (route[method]) {
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
  assert.ok(fs.readFileSync(path.join(root, 'lib/scheduled-email-store.ts'), 'utf8').includes('FOR UPDATE SKIP LOCKED'));
  assert.ok(workerSource.includes('beginScheduledSend'));
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
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
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
    restoreSendMocks();
    fs.rmSync(dbPath, { force: true });
  }
});

test('direct sends return safe actionable Gmail failures and only retry explicit authentication rejection', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-failures-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  const originalSeal = policy.sealGmailCredentials;
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

  gmailSendErrors = [Object.assign(new Error('temporary'), { response: { status: 503 } })];
  response = await send(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).outcome, 'needs_review');
  gmailSendErrors = [new Error('network failure')];
  response = await send(request());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).outcome, 'needs_review');
  assert.equal(refreshCalls, initialRefreshes + 2);

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
  policy.sealGmailCredentials = async () => { throw new Error('persistence secret'); };
  gmailSendErrors = [];
  response = await send(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).message_id, 'test-message-id');
  policy.sealGmailCredentials = originalSeal;

  } finally {
    policy.sealGmailCredentials = originalSeal;
    restoreSendMocks();
    fs.rmSync(dbPath, { force: true });
  }
});

function sendRecordsSchema() {
  return load('lib/db.ts').SEND_RECORDS_SQLITE_DDL;
}
const pgStore = new Map();
let pgNextId = 1;
function pgFind(id, owner) {
  for (const record of pgStore.values()) if (record.id === Number(id) && record.owner === owner) return record;
  return null;
}
function resetPgStore() {
  pgStore.clear();
  pgNextId = 1;
  pgFailureQueue = [];
  failAcceptedWrites = 0;
  commitAcceptedBeforeFailure = false;
  failOutcomeWrites = 0;
}
function outcomeDb(dbPath) {
  const Database = require('better-sqlite3');
  return () => {
    const db = new Database(dbPath);
    const prepare = db.prepare.bind(db);
    db.prepare = sql => {
      const statement = prepare(sql);
      if (typeof sql === 'string' && sql.includes('gmail_message_id') && sql.includes("status = 'sending'")) {
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          if (failOutcomeWrites > 0) { failOutcomeWrites -= 1; throw new Error('outcome write failed'); }
          if (args[0] === 'accepted' && failAcceptedWrites > 0) {
            failAcceptedWrites -= 1;
            if (commitAcceptedBeforeFailure) run(...args);
            throw new Error('accepted write failed');
          }
          return run(...args);
        };
      }
      return statement;
    };
    return db;
  };
}
function restoreSendMocks() {
  gmailSendErrors = [];
  gmailSendReturnId = 'test-message-id';
  gmailSendDelay = 0;
  gmailSendGate = null;
  sheetsShouldFail = false;
  externalFetch = async () => { throw new Error('Unexpected external call'); };
  cookieValues = {};
  dbMock.isVercel = false;
  dbMock.initialiseDb = async () => { providerCalls++; throw new Error('Unexpected DB call'); };
  dbMock.getLocalDb = () => { throw new Error('Unexpected DB call'); };
  resetPgStore();
  delete env.GOOGLE_SERVICE_ACCOUNT;
  delete env.GOOGLE_SHEETS_ID;
}

test('immediate sends create a durable record: replay returns the original outcome without resending', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-records-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
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
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  let releaseGmail = () => {};
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const body = { expectedGoogleSub: user.googleSub, request_id: '22222222-2222-3333-4444-555555555555', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    const request = () => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sendsBefore = gmailSendCalls;
    gmailSendGate = new Promise(resolve => { releaseGmail = resolve; });
    const first = send(request());
    let sawSending = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const probe = new Database(dbPath);
        const row = probe.prepare('SELECT status FROM send_records').get();
        probe.close();
        if (row?.status === 'sending') { sawSending = true; break; }
      } catch { /* the claim has not created the table yet */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(sawSending, true);
    const second = await send(request());
    assert.equal(second.status, 409);
    assert.equal((await second.json()).outcome, 'uncertain');
    assert.equal(gmailSendCalls, sendsBefore + 1);
    releaseGmail();
    const accepted = await first;
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).outcome, 'accepted');
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT request_id, status, gmail_message_id FROM send_records').all();
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'accepted');
    assert.equal(rows[0].gmail_message_id, 'test-message-id');
  } finally {
    releaseGmail();
    restoreSendMocks();
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
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
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
    assert.equal(foreign.status, 409);
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
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const body = { expectedGoogleSub: user.googleSub, request_id: '44444444-2222-3333-4444-555555555555', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    const request = () => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    gmailSendReturnId = '';
    const sendsBefore = gmailSendCalls;
    const uncertain = await send(request());
    assert.equal(uncertain.status, 502);
    assert.equal((await uncertain.json()).outcome, 'needs_review');
    assert.equal(gmailSendCalls, sendsBefore + 1);
    const db = new Database(dbPath);
    const row = db.prepare('SELECT status, gmail_message_id FROM send_records').get();
    db.close();
    assert.equal(row.status, 'needs_review');
    assert.equal(row.gmail_message_id, null);
    // Replay of the uncertain request returns the same uncertainty without resending.
    const replay = await send(request());
    assert.equal(replay.status, 502);
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
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
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
    assert.equal(uncertain.status, 502);
    assert.equal((await uncertain.json()).outcome, 'needs_review');
    assert.equal(gmailSendCalls, sendsBefore + 1);
    const replay = await send(request());
    assert.equal(replay.status, 502);
    assert.equal((await replay.json()).outcome, 'needs_review');
    assert.equal(gmailSendCalls, sendsBefore + 1);
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('quota failures are recorded as failed and replay never sends again', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-records-quota-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
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
    assert.equal(replay.status, 429);
    assert.equal((await replay.json()).error, 'Gmail has temporarily limited sending. Please try again later.');
    assert.equal(gmailSendCalls, sendsBefore + 1);
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('a lost outcome write after Gmail acceptance is reported as uncertain, never resent', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-records-postaccept-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
  failAcceptedWrites = 2;
  dbMock.getLocalDb = outcomeDb(dbPath);
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const body = { expectedGoogleSub: user.googleSub, request_id: '77777777-2222-3333-4444-555555555555', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    const request = () => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sendsBefore = gmailSendCalls;
    const response = await send(request());
    const responseBody = await response.json();
    assert.equal(response.status, 502);
    assert.equal(responseBody.outcome, 'needs_review');
    assert.equal(responseBody.uncertain, true);
    assert.equal(responseBody.message_id, 'test-message-id');
    assert.equal(gmailSendCalls, sendsBefore + 1);
    const db = new Database(dbPath);
    const row = db.prepare('SELECT status, gmail_message_id, last_error_code FROM send_records').get();
    db.close();
    assert.equal(row.status, 'needs_review');
    assert.equal(row.gmail_message_id, 'test-message-id');
    assert.equal(row.last_error_code, 'outcome_write_lost');
    const replay = await send(request());
    const replayBody = await replay.json();
    assert.equal(replay.status, 200);
    assert.equal(replayBody.success, true);
    assert.equal(replayBody.message_id, 'test-message-id');
    assert.equal(replayBody.replayed, true);
    assert.equal(gmailSendCalls, sendsBefore + 1);
  } finally {
    restoreSendMocks();
    fs.rmSync(dbPath, { force: true });
  }
});

test('the Postgres immediate-send path never sends again after a lost outcome write', async () => {
  dbMock.isVercel = true;
  dbMock.initialiseDb = async () => {};
  failAcceptedWrites = 2;
  try {
    resetPgStore();
    failAcceptedWrites = 2;
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const body = { expectedGoogleSub: user.googleSub, request_id: '88888888-2222-3333-4444-555555555555', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    const request = () => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sendsBefore = gmailSendCalls;
    const response = await send(request());
    const responseBody = await response.json();
    assert.equal(response.status, 502);
    assert.equal(responseBody.outcome, 'needs_review');
    assert.equal(responseBody.message_id, 'test-message-id');
    assert.equal(gmailSendCalls, sendsBefore + 1);
    const stored = [...pgStore.values()][0];
    assert.equal(stored.status, 'needs_review');
    assert.equal(stored.messageId, 'test-message-id');
    assert.equal(stored.errorCode, 'outcome_write_lost');
    const replay = await send(request());
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).message_id, 'test-message-id');
    assert.equal(gmailSendCalls, sendsBefore + 1);
  } finally {
    restoreSendMocks();
  }
});

test('missing or malformed request ids fail closed before Gmail and any DB work', async () => {
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const request = body => new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const base = { expectedGoogleSub: user.googleSub, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
    const before = gmailSendCalls;
    const malformed = [
      undefined,
      null,
      12345,
      '',
      '   ',
      'not-a-uuid',
      'zzzzzzzz-2222-3333-4444-555555555555',
      'aaaaaaaa-2222-3333-4444-55555555555',
      'aaaaaaaa-2222-3333-4444-5555555555555',
      'aaaaaaaa222233334444555555555555',
      '{aaaaaaaa-2222-3333-4444-555555555555}',
      'aaaaaaaa-2222-3333-4444-55555555555  ',
    ];
    for (const requestId of malformed) {
      assert.equal((await send(request({ ...base, request_id: requestId }))).status, 400, JSON.stringify(requestId));
    }
    assert.equal(gmailSendCalls, before);
  } finally {
    restoreSendMocks();
  }
});

test('immediate send records enforce global request-id uniqueness and the accepted-implies-message-id rule in both dialects', () => {
  const source = fs.readFileSync(path.join(root, 'lib/db.ts'), 'utf8');
  const uniques = source.match(/UNIQUE \(request_id\)/g) ?? [];
  assert.ok(uniques.length >= 2, 'both the Postgres and SQLite schemas must make request_id globally unique');
  const checks = source.match(/CHECK \(status != 'accepted'[^\n]*\)/g) ?? [];
  assert.ok(checks.length >= 2, 'both dialects must enforce accepted-implies-message-id');
  assert.match(source, /send_records_request_id_key/);
  assert.match(source, /ensureSqliteSendRecords/);
  const route = fs.readFileSync(path.join(root, 'app/api/send-email/route.ts'), 'utf8');
  assert.match(route, /ON CONFLICT \(request_id\) DO NOTHING/);
  assert.match(route, /request_id/);
  assert.match(route, /payload_hash/);
  assert.match(route, /already used by another session/);
  assert.match(route, /sendViaGmail\(/);
  assert.match(route, /AND status = 'sending'/);
  assert.match(route, /THEN NOW\(\)/);
  assert.equal(route.includes('function gmailSend'), false);
  const gmail = fs.readFileSync(path.join(root, 'lib/gmail.ts'), 'utf8');
  assert.match(gmail, /missing_message_id/);
});

test('an older sqlite send_records table gains the request_id conflict target before a send', async () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-send-schema-'));
  const previous = process.cwd();
  const Database = require('better-sqlite3');
  try {
    const raw = new Database(path.join(dir, 'atelier.db'));
    raw.exec(`CREATE TABLE send_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_google_sub TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'recorded'
    )`);
    raw.prepare(`INSERT INTO send_records (owner_google_sub, owner_email, request_id, payload_hash, status) VALUES ('owner', 'owner@example.invalid', 'kept-id', 'hash', 'recorded')`).run();
    raw.close();
    process.chdir(dir);
    await load('lib/db.ts').initialiseDb();
    const db = new Database(path.join(dir, 'atelier.db'));
    const kept = db.prepare('SELECT request_id, status FROM send_records').get();
    assert.equal(kept.request_id, 'kept-id');
    assert.throws(() => db.prepare(`INSERT INTO send_records (owner_google_sub, owner_email, request_id, payload_hash, status) VALUES ('other', 'other@example.invalid', 'kept-id', 'hash', 'recorded')`).run());
    assert.throws(() => db.prepare(`INSERT INTO send_records (owner_google_sub, owner_email, request_id, payload_hash, status, gmail_message_id) VALUES ('owner', 'owner@example.invalid', 'accepted-without-id', 'hash', 'accepted', NULL)`).run());
    db.close();
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('existing unique SQLite send records gain all outcome invariants and required columns without losing rows', async () => {
  const os = require('node:os');
  const Database = require('better-sqlite3');
  const schema = load('lib/db.ts').SEND_RECORDS_SQLITE_DDL;
  const acceptedCheck = ",\n        CHECK (status != 'accepted' OR (gmail_message_id IS NOT NULL AND gmail_message_id != ''))";
  const variants = [
    ['old status check', schema.replace(",'needs_review'", '')],
    ['missing accepted message check', schema.replace(acceptedCheck, '')],
    ['missing outcome column', schema.replace('        last_error_code TEXT,\n', '')],
  ];
  const previous = process.cwd();
  for (const [label, legacySchema] of variants) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-send-invariants-'));
    let db;
    try {
      db = new Database(path.join(dir, 'atelier.db'));
      db.exec(legacySchema);
      db.prepare(`INSERT INTO send_records (owner_google_sub, owner_email, request_id, payload_hash, status, gmail_message_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('owner', 'owner@example.invalid', 'kept-id', 'kept-hash', 'accepted', 'kept-message-id');
      const before = db.prepare('SELECT * FROM send_records').get();
      db.close();
      process.chdir(dir);
      await load('lib/db.ts').initialiseDb();
      db = new Database(path.join(dir, 'atelier.db'));
      const after = db.prepare('SELECT * FROM send_records').get();
      for (const [column, value] of Object.entries(before)) assert.equal(after[column], value, `${label}: ${column}`);
      assert.ok(db.prepare('PRAGMA table_info(send_records)').all().some(column => column.name === 'last_error_code'));
      db.prepare(`INSERT INTO send_records (owner_google_sub, owner_email, request_id, payload_hash, status) VALUES ('owner', 'owner@example.invalid', 'review-id', 'hash', 'needs_review')`).run();
      for (const messageId of [null, '']) {
        assert.throws(() => db.prepare(`INSERT INTO send_records (owner_google_sub, owner_email, request_id, payload_hash, status, gmail_message_id) VALUES ('owner', 'owner@example.invalid', 'invalid-id', 'hash', 'accepted', ?)`).run(messageId), /CHECK constraint failed/, label);
      }
      assert.throws(() => db.prepare(`INSERT INTO send_records (owner_google_sub, owner_email, request_id, payload_hash, status) VALUES ('other', 'other@example.invalid', 'kept-id', 'hash', 'recorded')`).run(), /UNIQUE constraint failed/, label);
      await load('lib/db.ts').initialiseDb();
      assert.equal(db.prepare('SELECT count(*) AS count FROM send_records').get().count, 2, `${label}: repeated init preserves rows`);
    } finally {
      if (db?.open) db.close();
      process.chdir(previous);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('incompatible legacy SQLite outcomes roll back the migration and fail closed', async () => {
  const os = require('node:os');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-send-invalid-'));
  const previous = process.cwd();
  let db;
  try {
    db = new Database(path.join(dir, 'atelier.db'));
    db.exec(load('lib/db.ts').SEND_RECORDS_SQLITE_DDL.replace(",\n        CHECK (status != 'accepted' OR (gmail_message_id IS NOT NULL AND gmail_message_id != ''))", ''));
    db.prepare(`INSERT INTO send_records (owner_google_sub, owner_email, request_id, payload_hash, status) VALUES ('owner', 'owner@example.invalid', 'legacy-id', 'hash', 'accepted')`).run();
    const before = db.prepare('SELECT * FROM send_records').get();
    db.close();
    process.chdir(dir);
    await assert.rejects(load('lib/db.ts').initialiseDb(), /CHECK constraint failed/);
    db = new Database(path.join(dir, 'atelier.db'));
    assert.deepEqual(db.prepare('SELECT * FROM send_records').get(), before);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'send_records_legacy'").get(), undefined);
    await assert.rejects(load('lib/db.ts').initialiseDb(), /CHECK constraint failed/);
  } finally {
    if (db?.open) db.close();
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sendRequest(body) {
  return new NextRequest('https://example.invalid/api/send-email', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('a retried accepted write still syncs Sheets and stores the refreshed token', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-m1-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
  failAcceptedWrites = 1;
  dbMock.getLocalDb = outcomeDb(dbPath);
  env.GOOGLE_SERVICE_ACCOUNT = '{}';
  env.GOOGLE_SHEETS_ID = 'test-sheet';
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: '', refreshToken: 'test-refresh' }) };
    externalFetch = async () => new Response(JSON.stringify({ access_token: 'new-access' }), { status: 200, headers: { 'content-type': 'application/json' } });
    const send = load('app/api/send-email/route.ts').POST;
    const sendsBefore = gmailSendCalls;
    const response = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: '99999999-2222-3333-4444-555555555551', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact', dossier: { brand_name: 'Test Brand' } }));
    const responseBody = await response.json();
    assert.equal(response.status, 200);
    assert.equal(responseBody.outcome, 'accepted');
    assert.equal(responseBody.pipeline_synced, true);
    assert.equal(gmailSendCalls, sendsBefore + 1);
    const opened = await policy.openGmailCredentials(response.cookies.get('atelier_gmail').value, user);
    assert.equal(opened.accessToken, 'new-access');
    const db = new Database(dbPath);
    const row = db.prepare('SELECT status, gmail_message_id FROM send_records').get();
    db.close();
    assert.equal(row.status, 'accepted');
    assert.equal(row.gmail_message_id, 'test-message-id');
  } finally {
    restoreSendMocks();
    fs.rmSync(dbPath, { force: true });
  }
});

test('an accepted write that commits but reports failure is not downgraded to needs_review', async () => {
  dbMock.isVercel = true;
  dbMock.initialiseDb = async () => {};
  try {
    resetPgStore();
    failAcceptedWrites = 1;
    commitAcceptedBeforeFailure = true;
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const response = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: '99999999-2222-3333-4444-555555555552', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact', dossier: { brand_name: 'Test Brand' } }));
    env.GOOGLE_SERVICE_ACCOUNT = '{}';
    env.GOOGLE_SHEETS_ID = 'test-sheet';
    assert.equal(response.status, 200);
    assert.equal((await response.json()).outcome, 'accepted');
    const stored = [...pgStore.values()][0];
    assert.equal(stored.status, 'accepted');
    assert.equal(stored.messageId, 'test-message-id');
  } finally {
    restoreSendMocks();
  }
});

test('ambiguous errors after a token refresh are recorded as needs_review', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-m2-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'expired-access', refreshToken: 'test-refresh' }) };
    externalFetch = async () => new Response(JSON.stringify({ access_token: 'new-access' }), { status: 200, headers: { 'content-type': 'application/json' } });
    const send = load('app/api/send-email/route.ts').POST;
    const cases = [
      { id: '99999999-2222-3333-4444-555555555553', error: Object.assign(new Error('temporary'), { response: { status: 503 } }), status: 503, code: 'temporary' },
      { id: '99999999-2222-3333-4444-555555555554', error: new Error('network failure'), status: 502, code: 'unknown' },
      { id: '99999999-2222-3333-4444-555555555555', error: Object.assign(new Error('missing'), { code: 'missing_message_id' }), status: 502, code: 'unknown' },
    ];
    for (const item of cases) {
      const sendsBefore = gmailSendCalls;
      gmailSendErrors = [Object.assign(new Error('expired'), { response: { status: 401 } }), item.error];
      const response = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: item.id, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
      const responseBody = await response.json();
      assert.equal(response.status, item.status, item.code);
      assert.equal(responseBody.outcome, 'needs_review', item.code);
      assert.equal(gmailSendCalls, sendsBefore + 2, item.code);
      const replay = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: item.id, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
      assert.equal(replay.status, 502);
      assert.equal(gmailSendCalls, sendsBefore + 2, item.code);
    }
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT status, last_error_code FROM send_records ORDER BY request_id').all();
    db.close();
    assert.deepEqual(rows, cases.map(item => ({ status: 'needs_review', last_error_code: item.code })));
  } finally {
    restoreSendMocks();
    fs.rmSync(dbPath, { force: true });
  }
});

test('token refresh outages before acceptance release the claim and a real reauth does not', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-m3-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
    const refreshOnly = await policy.sealGmailCredentials({ ...user, accessToken: '', refreshToken: 'test-refresh' });
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: refreshOnly };
    const send = load('app/api/send-email/route.ts').POST;
    const temporaryId = 'aaaaaaaa-2222-4333-8444-555555555551';
    const sendsBefore = gmailSendCalls;
    externalFetch = async () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    const temporary = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: temporaryId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(temporary.status, 503);
    assert.equal(gmailSendCalls, sendsBefore);
    let db = new Database(dbPath);
    assert.equal(db.prepare('SELECT status FROM send_records WHERE request_id = ?').get(temporaryId).status, 'recorded');
    db.close();
    externalFetch = async () => new Response(JSON.stringify({ access_token: 'new-access' }), { status: 200, headers: { 'content-type': 'application/json' } });
    const retried = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: temporaryId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(retried.status, 200);
    assert.equal(gmailSendCalls, sendsBefore + 1);

    const configId = 'aaaaaaaa-2222-4333-8444-555555555552';
    externalFetch = async () => new Response(JSON.stringify({ error: 'deleted_client' }), { status: 400, headers: { 'content-type': 'application/json' } });
    const configured = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: configId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(configured.status, 503);
    db = new Database(dbPath);
    assert.equal(db.prepare('SELECT status FROM send_records WHERE request_id = ?').get(configId).status, 'recorded');
    db.close();
    assert.equal(gmailSendCalls, sendsBefore + 1);

    const reauthId = 'aaaaaaaa-2222-4333-8444-555555555553';
    externalFetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
    const reauth = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: reauthId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(reauth.status, 401);
    assert.equal((await reauth.json()).outcome, 'failed_auth');
    db = new Database(dbPath);
    assert.equal(db.prepare('SELECT status, last_error_code FROM send_records WHERE request_id = ?').get(reauthId).status, 'failed_auth');
    db.close();
    const replay = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: reauthId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(replay.status, 401);
    assert.equal(gmailSendCalls, sendsBefore + 1);

    cookieValues.atelier_gmail = await policy.sealGmailCredentials({ ...user, accessToken: 'expired-access', refreshToken: 'test-refresh' });
    const midId = 'aaaaaaaa-2222-4333-8444-555555555554';
    gmailSendErrors = [Object.assign(new Error('expired'), { response: { status: 401 } })];
    externalFetch = async () => new Response('no', { status: 503 });
    const mid = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: midId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(mid.status, 503);
    db = new Database(dbPath);
    assert.equal(db.prepare('SELECT status FROM send_records WHERE request_id = ?').get(midId).status, 'recorded');
    db.close();
    assert.equal(gmailSendCalls, sendsBefore + 2);
  } finally {
    restoreSendMocks();
    fs.rmSync(dbPath, { force: true });
  }
});

test('a failed outcome write still returns the classified response and does not invite another send', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-m4-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
  failOutcomeWrites = 5;
  dbMock.getLocalDb = outcomeDb(dbPath);
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const quotaId = 'bbbbbbbb-2222-4333-8444-555555555551';
    gmailSendErrors = [Object.assign(new Error('quota'), { response: { status: 429 } })];
    const sendsBefore = gmailSendCalls;
    const quota = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: quotaId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(quota.status, 429);
    assert.equal((await quota.json()).outcome, 'failed');
    let db = new Database(dbPath);
    assert.equal(db.prepare('SELECT status FROM send_records WHERE request_id = ?').get(quotaId).status, 'sending');
    db.close();
    const quotaReplay = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: quotaId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(quotaReplay.status, 409);
    assert.equal((await quotaReplay.json()).outcome, 'uncertain');
    assert.equal(gmailSendCalls, sendsBefore + 1);

    const networkId = 'bbbbbbbb-2222-4333-8444-555555555552';
    gmailSendErrors = [new Error('network failure')];
    const network = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: networkId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    const networkBody = await network.json();
    assert.equal(network.status, 502);
    assert.equal(networkBody.outcome, 'needs_review');
    assert.equal(networkBody.uncertain, true);
    assert.match(networkBody.error, /Check Sent mail/);
    const networkReplay = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: networkId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(networkReplay.status, 409);
    assert.equal(gmailSendCalls, sendsBefore + 2);
  } finally {
    restoreSendMocks();
    fs.rmSync(dbPath, { force: true });
  }
});

test('policy replays stay a 403 and unknown Gmail 400s stay needs_review', async () => {
  const Database = require('better-sqlite3');
  const dbPath = path.join(require('node:os').tmpdir(), `atelier-send-policy-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  dbMock.initialiseDb = async () => { const db = new Database(dbPath); db.exec(sendRecordsSchema()); db.close(); };
  dbMock.getLocalDb = () => new Database(dbPath);
  try {
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    const policyId = 'cccccccc-2222-4333-8444-555555555551';
    gmailSendErrors = [Object.assign(new Error('policy'), { response: { status: 403, data: { error: { errors: [{ reason: 'domainPolicy' }] } } } })];
    const denied = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: policyId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(denied.status, 403);
    const deniedReplay = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: policyId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(deniedReplay.status, 403);
    assert.equal((await deniedReplay.json()).error, 'Your Google Workspace administrator has blocked Gmail access for this app.');

    const unknownId = 'cccccccc-2222-4333-8444-555555555552';
    const sendsBefore = gmailSendCalls;
    gmailSendErrors = [Object.assign(new Error('bad request'), { response: { status: 400 } })];
    const badRequest = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: unknownId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(badRequest.status, 502);
    assert.equal((await badRequest.json()).outcome, 'needs_review');
    gmailSendErrors = [Object.assign(new Error('forbidden'), { response: { status: 403, data: { error: { errors: [{ reason: 'unknownReason' }] } } } })];
    const unknownForbidden = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: 'cccccccc-2222-4333-8444-555555555553', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(unknownForbidden.status, 502);
    assert.equal((await unknownForbidden.json()).outcome, 'needs_review');
    const replay = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: unknownId, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(replay.status, 502);
    assert.equal(gmailSendCalls, sendsBefore + 2);

    const upper = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: 'DDDDDDDD-2222-4333-8444-555555555554', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(upper.status, 200);
  } finally {
    restoreSendMocks();
    fs.rmSync(dbPath, { force: true });
  }
});

test('Postgres outcome writes update only the claimed request id', async () => {
  dbMock.isVercel = true;
  dbMock.initialiseDb = async () => {};
  try {
    resetPgStore();
    cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
    const send = load('app/api/send-email/route.ts').POST;
    gmailSendReturnId = 'message-a';
    const accepted = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: 'dddddddd-2222-4333-8444-555555555551', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(accepted.status, 200);
    gmailSendReturnId = 'message-b';
    gmailSendErrors = [Object.assign(new Error('quota'), { response: { status: 429 } })];
    const limited = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: 'dddddddd-2222-4333-8444-555555555552', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    assert.equal(limited.status, 429);
    const replay = await send(sendRequest({ expectedGoogleSub: user.googleSub, request_id: 'dddddddd-2222-4333-8444-555555555551', to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body' }));
    const replayBody = await replay.json();
    assert.equal(replay.status, 200);
    assert.equal(replayBody.message_id, 'message-a');
    assert.equal(replayBody.replayed, true);
    const rows = [...pgStore.values()].map(record => ({ id: record.id, status: record.status, messageId: record.messageId, errorCode: record.errorCode }));
    assert.deepEqual(rows, [
      { id: 1, status: 'accepted', messageId: 'message-a', errorCode: null },
      { id: 2, status: 'failed', messageId: null, errorCode: 'quota' },
    ]);
  } finally {
    restoreSendMocks();
  }
});

test('confirmation fingerprints are compact, deterministic and bind attachment bytes', async () => {
  const { confirmedSendDraftKey, confirmedSendDraftContent, createConfirmedSendLedger } = load('lib/send-confirmation.ts');
  const draft = { to: 'contact@example.invalid', cc: '', bcc: '', subject: 'Hello', emailBody: 'Body', attachments: [{ name: 'fixture.pdf', type: 'application/pdf', data: Buffer.alloc(1536 * 1024, 65).toString('base64') }] };
  const key = await confirmedSendDraftKey(draft);
  assert.equal(key.length, 64);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(await confirmedSendDraftKey(draft), key);
  for (const changed of [{ ...draft, to: 'other@example.invalid' }, { ...draft, cc: 'cc@example.invalid' }, { ...draft, bcc: 'bcc@example.invalid' }, { ...draft, subject: 'Changed' }, { ...draft, emailBody: 'Changed' }, { ...draft, attachments: [{ ...draft.attachments[0], data: 'Qg==' }] }]) {
    assert.notEqual(await confirmedSendDraftKey(changed), key);
  }
  const legacy = createConfirmedSendLedger();
  const retained = { requestId: '11111111-1111-4111-8111-111111111111', draftKey: confirmedSendDraftContent(draft) };
  legacy.restore('tab-0', retained);
  await legacy.compact('tab-0');
  assert.equal(legacy.claim('tab-0', key), retained.requestId, 'legacy compaction must keep the original request id');
  assert.equal(legacy.parked('tab-0')[0].draftKey, key);
});

test('the composer keeps confirmed content replayable across uncertainty, acceptance, edits and reload', async () => {
  const { createConfirmedSendLedger, confirmedSendDraftKey } = load('lib/send-confirmation.ts');
  const draft = { to: 'contact@example.invalid', cc: '', bcc: '', subject: 'Hello', emailBody: 'Body', attachments: [] };
  const key = await confirmedSendDraftKey(draft);
  let minted = 0;
  const ledger = createConfirmedSendLedger(() => '10000000-0000-4000-8000-00000000000' + (++minted));
  const first = ledger.claim('tab-0', key);
  assert.equal(first, ledger.claim('tab-0', key));
  ledger.observe('tab-0', ledger.current('tab-0').requestId, { kind: 'network_error' });
  assert.equal(ledger.claim('tab-0', key), first);
  ledger.observe('tab-0', ledger.current('tab-0').requestId, { kind: 'response', httpStatus: 409, uncertain: true, outcome: 'uncertain', success: false });
  assert.equal(ledger.claim('tab-0', key), first);
  ledger.observe('tab-0', ledger.current('tab-0').requestId, { kind: 'response', httpStatus: 502, uncertain: true, outcome: 'needs_review', success: false });
  assert.equal(ledger.claim('tab-0', key), first);
  const otherTab = ledger.claim('tab-1', key);
  assert.notEqual(otherTab, first);
  const changed = await confirmedSendDraftKey({ ...draft, subject: 'Changed' });
  const next = ledger.claim('tab-0', changed);
  assert.notEqual(next, first);
  assert.equal(ledger.claim('tab-0', key), first);
  assert.equal(ledger.claim('tab-0', changed), next);
  ledger.observe('tab-0', ledger.current('tab-0').requestId, { kind: 'response', httpStatus: 200, success: true, outcome: 'accepted' });
  assert.equal(ledger.current('tab-0'), null);
  assert.equal(ledger.claim('tab-0', key), first);
  const afterSuccess = ledger.claim('tab-0', changed);
  assert.equal(afterSuccess, next, 'accepted content remains replayable');
  ledger.observe('tab-0', ledger.current('tab-0').requestId, { kind: 'response', httpStatus: 429, success: false, outcome: 'failed' });
  assert.equal(ledger.current('tab-0'), null);
  const uncertainChanged = ledger.claim('tab-0', changed);
  ledger.observe('tab-0', ledger.current('tab-0').requestId, { kind: 'response', httpStatus: 200, success: true, uncertain: true, outcome: 'needs_review' });
  assert.equal(ledger.current('tab-0').draftKey, changed);
  const parked = ledger.parked('tab-0');
  assert.equal(parked.some(send => send.requestId === first && send.draftKey === key), true);
  ledger.forget('tab-0');
  ledger.restore('tab-0', { requestId: first, draftKey: key }, parked);
  assert.equal(ledger.claim('tab-0', key), first);
  assert.equal(ledger.claim('tab-0', changed), uncertainChanged);
  // A delayed reply belongs to its request, even after another draft is active.
  ledger.observe('tab-0', first, { kind: 'response', httpStatus: 429, outcome: 'failed' });
  assert.equal(ledger.current('tab-0').requestId, uncertainChanged);
  ledger.observe('tab-0', uncertainChanged, { kind: 'response', httpStatus: 401 });
  assert.equal(ledger.claim('tab-0', changed), uncertainChanged, 'expired replay auth must not discard a possibly sent id');
  const recovered = createConfirmedSendLedger();
  recovered.restore('tab-0', { requestId: 'not-a-uuid', draftKey: null }, [{ requestId: first }]);
  assert.equal(recovered.current('tab-0'), null);
  assert.equal(recovered.parked('tab-0').length, 0);
  const page = fs.readFileSync(path.join(root, 'app/email/page.tsx'), 'utf8');
  const handleSend = page.slice(page.indexOf('async function handleSend'), page.indexOf('if (!checked)'));
  assert.match(handleSend, /request_id: requestId/);
  assert.match(handleSend, /confirmedSendsRef\.current\.claim\(/);
  assert.match(handleSend, /confirmedSendsRef\.current\.observe\(/);
  assert.match(page, /confirmedRequestId/);
  assert.match(page, /parkedSends/);
});

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
