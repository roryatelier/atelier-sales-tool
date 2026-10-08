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
let tokenData = { access_token: 'test-access' };
let userData = { id: 'google-1', email: 'member@example.invalid', verified_email: true, name: 'Member', picture: '' };
let logLines = [];
const storageValues = new Map();
const browserStorage = { get length() { return storageValues.size; }, key: i => [...storageValues.keys()][i] ?? null, getItem: key => storageValues.get(key) ?? null, setItem: (key, value) => storageValues.set(key, value), removeItem: key => storageValues.delete(key) };
const user = { googleSub: 'google-1', email: 'member@example.invalid', name: 'Member', picture: '' };
const env = { JWT_SECRET: 'test-secret-'.repeat(6), APP_ALLOWED_EMAILS: user.email, NODE_ENV: 'test', CRON_SECRET: 'test-cron' };
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
  gmail: () => ({ users: { messages: { send: async () => { providerCalls++; return { data: { id: 'test-message-id' } }; } } } }),
  sheets: () => ({ spreadsheets: { values: { append: async () => { if (sheetsShouldFail) throw new Error('Sheets unavailable'); } } } }),
};
function load(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename);
  const exported = {};
  cache.set(filename, exported);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  vm.runInNewContext(source, { exports: exported, process: { env }, crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, Buffer, URL, URLSearchParams, Request, Response, localStorage: browserStorage, window: { addEventListener() {}, removeEventListener() {} },
    console: { error: (...args) => logLines.push(args), log() {}, warn() {} },
    fetch: async () => { providerCalls++; throw new Error('Unexpected external call'); },
    require: name => {
      if (name === 'server-only') return {};
      if (name === 'jose') return jose;
      if (name === 'next/server') return require('next/server');
      if (name === 'next/headers') return { cookies: async () => ({ get: name => cookieValues[name] ? { value: cookieValues[name] } : undefined }) };
      if (name === 'googleapis') return { google };
      if (name === '@anthropic-ai/sdk') return class { constructor() { this.messages = { create: async () => { providerCalls++; throw new Error('Unexpected AI call'); } }; } };
      if (name === '@/lib/db') return { initialiseDb: async () => { providerCalls++; throw new Error('Unexpected DB call'); }, isVercel: false };
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

test('legacy scheduled jobs remain quarantined even with valid session and cron secret', async () => {
  cookieValues = { atelier_session: await policy.signSession(user) };
  const schedule = load('app/api/schedule-email/route.ts');
  let response = await schedule.GET(new NextRequest('https://example.invalid/api/schedule-email'));
  assert.equal((await response.json()).legacy_jobs_quarantined, true);
  response = await schedule.POST(new NextRequest('https://example.invalid/api/schedule-email', { method: 'POST', headers: { origin: 'https://example.invalid' } }));
  assert.equal(response.status, 503);
  response = await schedule.DELETE(new NextRequest('https://example.invalid/api/schedule-email?id=1', { method: 'DELETE', headers: { origin: 'https://example.invalid' } }));
  assert.equal(response.status, 409);
  const cron = load('app/api/cron/send-scheduled-emails/route.ts').GET;
  response = await cron(new NextRequest('https://example.invalid/api/cron/send-scheduled-emails', { headers: { authorization: 'Bearer test-cron' } }));
  assert.equal(response.status, 503);
});

test('safe logging drops bearer tokens, bodies, headers and provider messages', () => {
  logLines = [];
  load('lib/safe-log.ts').logSafeError('Provider failed', { status: 403, message: 'test-secret', config: { headers: { authorization: 'test-bearer' } }, response: { status: 403, data: 'test-body' } });
  const line = JSON.stringify(logLines);
  assert.ok(line.includes('403'));
  for (const secret of ['test-secret', 'test-bearer', 'test-body']) assert.equal(line.includes(secret), false);
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
  cookieValues = { atelier_session: await policy.signSession(user), atelier_gmail: await policy.sealGmailCredentials({ ...user, accessToken: 'test-access' }) };
  const send = load('app/api/send-email/route.ts').POST;
  const valid = { expectedGoogleSub: user.googleSub, to: 'contact@example.invalid', subject: 'Hello', emailBody: 'Body', contactName: 'Contact' };
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
  const partialResponse = await send(request({ ...valid, dossier: { brand_name: 'Test Brand' } }));
  assert.equal(partialResponse.status, 200);
  assert.equal((await partialResponse.json()).pipeline_synced, false);
  sheetsShouldFail = false;
  const syncedResponse = await send(request({ ...valid, dossier: { brand_name: 'Test Brand' } }));
  assert.equal(syncedResponse.status, 200);
  assert.equal((await syncedResponse.json()).pipeline_synced, true);
  delete env.GOOGLE_SERVICE_ACCOUNT;
  delete env.GOOGLE_SHEETS_ID;
});
