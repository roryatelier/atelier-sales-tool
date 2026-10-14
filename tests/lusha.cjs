const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { NextRequest, NextResponse } = require('next/server');
function setup({ key = 'synthetic-key', status = 200, data = {}, companyData = { results: [{ id: 'company-1', name: 'Example', domain: 'example.invalid' }] }, denied = false, timeout = false } = {}) {
  const calls = []; const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
    vm.runInNewContext(source, { exports, process: { env: { LUSHA_API_KEY: key } }, URL, AbortSignal, Response, console: { error() {} }, fetch: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); if (timeout) throw Error('private provider details'); return new Response(JSON.stringify(String(url).endsWith('/companies/search') ? companyData : data), { status }); }, require: name => {
      if (name === 'server-only') return {};
      if (name === 'next/server') return { NextRequest, NextResponse };
      if (name === '@/lib/api-auth') return { authorizeRequest: async () => denied ? { error: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) } : { session: { googleSub: 'owner-A' } } };
      if (name === '@/lib/safe-log') return { logSafeError() {} };
      if (name.startsWith('@/')) return load(name.slice(2) + '.ts');
      if (name.startsWith('.')) return load(path.posix.join(path.posix.dirname(file), name) + '.ts');
      throw Error('Unexpected module: ' + name);
    } }); return exports;
  }
  const route = load('app/api/lookup-contacts/route.ts');
  return { calls, load, request: body => route.POST(new NextRequest('https://example.invalid/api/lookup-contacts', { method: 'POST', body: JSON.stringify(body), headers: { origin: 'https://example.invalid' } })) };
}
const search = { brand_name: 'Example', domain: 'https://WWW.Example.invalid:443/about?x=1' };
const reveal = { enrich_id: 'contact-1', expectedGoogleSub: 'owner-A' };
test('search starts at zero with supported uncapped params and safe domain', async () => {
  const s = setup({ data: { results: [{ id: '1', firstName: 'Test', jobTitle: {} }], pagination: { page: 0, size: 50, total: 101, totalGuaranteed: true } } });
  const res = await s.request(search); const body = await res.json();
  const contactCall=s.calls.find(call=>call.url.endsWith('/contacts/prospecting'));
  assert.equal(res.status, 200); assert.equal(contactCall.body.pagination.page, 0);
  assert.equal(contactCall.body.options.maxContactsPerCompany, undefined);
  assert.equal(contactCall.body.filters.companies.include.domains[0], 'example.invalid');
  assert.equal(body.hasMore, true); assert.equal(body.nextPage, 1);
  assert.match(res.headers.get('cache-control'), /no-store/);
});
test('different name and domain matches require an explicit canonical company choice', async () => {
  const s=setup({data:{results:[],pagination:{page:0,size:50,total:0,totalGuaranteed:true}},companyData:{results:[{id:'parent',name:'Example Group',domain:'careers.example.invalid'},{id:'retail',name:'Example Retail',domain:'example.invalid'}]}})
  const res=await s.request({...search,company_name:'Example'});const body=await res.json()
  assert.equal(res.status,409);assert.equal(body.status,'company_choice_required');assert.equal(body.companies.length,2)
  assert.equal(s.calls.filter(call=>call.url.endsWith('/contacts/prospecting')).length,1)
  const chosen=await s.request({...search,company_name:'Example',company_id:'parent'});assert.equal(chosen.status,200)
  const contactCall=s.calls.find(call=>call.url.endsWith('/contacts/prospecting')&&call.body.filters.companies.include.ids)
  assert.equal(contactCall.body.filters.companies.include.ids[0],'parent')
})
test('company name can resolve contacts when a dossier has no website', async () => {
  const s=setup({data:{results:[],pagination:{page:0,size:50,total:0,totalGuaranteed:true}}})
  const res=await s.request({company_name:'Example',domain:'',page:0});const body=await res.json();assert.equal(res.status,409)
  assert.equal(body.status,'company_choice_required')
  assert.equal(s.calls[0].body.companies[0].name,'Example')
  assert.equal(s.calls[0].body.companies.length,1)
  assert.equal(s.calls.filter(call=>call.url.endsWith('/contacts/prospecting')).length,0)
})
test('canonical lookup is deferred until direct domain search returns no contacts', async () => {
  const s=setup({data:{results:[],pagination:{page:0,size:50,total:0,totalGuaranteed:true}}})
  const res=await s.request({...search,company_name:'Example'});const body=await res.json()
  assert.equal(res.status,409);assert.equal(body.status,'company_choice_required')
  assert.equal(s.calls[0].url.endsWith('/contacts/prospecting'),true)
  assert.equal(s.calls[1].url.endsWith('/companies/search'),true)
  assert.equal(s.calls[1].body.companies.length,1)
})
test('no-match, missing config, provider failures never fabricate success', async () => {
  for (const [options, expected] of [[{key:''},503],[{status:402},409],[{status:429},429],[{status:401},502],[{status:500},502]]) {
    const s = setup(options); const res = await s.request(search);
    assert.equal(res.status, expected); assert.equal((await res.json()).success, false);
  }
  const s = setup({ data: { results: [], pagination: { page:0,size:50 } } });
  const body = await (await s.request(search)).json(); assert.equal(body.contacts.length,0); assert.equal(body.status,'empty');
});
test('invalid domain/page and stale or missing owner deny before spending', async () => {
  for (const body of [{brand_name:'Example'}, {...search,domain:'file:///etc/passwd'}, {...search,page:-1}, {...search,enrich_id:0}, {enrich_id:'1'}, {...reveal, expectedGoogleSub:'owner-B'}]) {
    const s = setup(); const res = await s.request(body); assert.ok(res.status >=400); assert.equal(s.calls.length,0);
  }
  const s = setup({denied:true}); assert.equal((await s.request(reveal)).status,401); assert.equal(s.calls.length,0);
});
test('reveal only emails, match ID, preserve evidence and require private choice', async () => {
  const s=setup({data:{results:[{id:'contact-1',emails:[{email:'private@example.invalid',type:'private'},{email:'work@example.invalid',type:'work',confidence:'A+'}]}]}});
  const res=await s.request(reveal); const body=await res.json();
  assert.equal(s.calls[0].body.reveal.join(','),'emails'); assert.equal(s.calls[0].body.waterfallEnabled,false);
  assert.equal(body.email,'work@example.invalid'); assert.equal(body.verified,false);
  const p=setup({data:{results:[{id:'contact-1',emails:[{email:'private@example.invalid',type:'private'}]}]}});
  const privateResult=await (await p.request(reveal)).json(); assert.equal(privateResult.email,''); assert.equal(privateResult.status,'choose_email'); assert.equal(privateResult.emails.length,1);
});
test('empty, mismatched, credit and async results never become empty success', async () => {
  for (const [data,state] of [[{results:[{id:'contact-1',emails:[]}]},'unavailable'],[{results:[{id:'other',emails:[{email:'wrong@example.invalid',type:'work'}]}]},'failed'],[{status:'OUT_OF_CREDITS',results:[]},'needs_credits'],[{results:[],job:{id:'private-upstream-id'}},'pending']]) {
    const s=setup({data}); const body=await (await s.request(reveal)).json(); assert.equal(body.status,state); assert.equal(body.success,false); assert.equal(body.email,undefined); assert.equal(body.job,undefined);
  }
  const s=setup({timeout:true}); const res=await s.request(reveal); assert.equal(res.status,504); assert.equal((await res.json()).status,'ambiguous'); assert.equal(s.calls.length,1);
});
test('overlapping pages preserve revealed addresses and distinct same-name contacts', () => {
  const {mergeContacts}=setup().load('lib/lusha-contact.ts');
  const previous=Array.from({length:50},(_,i)=>({contactId:String(i),name:'Same name',email:i===45?'revealed@example.invalid':''}));
  const next=Array.from({length:50},(_,i)=>({contactId:String(i+45),name:'Same name',email:''}));
  const merged=mergeContacts(previous,next); assert.equal(merged.length,95); assert.equal(merged.find(c=>c.contactId==='45').email,'revealed@example.invalid');
});
test('HTTP-200 credit failure during search is not genuine no-match', async () => {
  const s=setup({data:{status:'OUT_OF_CREDITS',results:[]}});const res=await s.request(search);assert.equal(res.status,409);assert.equal((await res.json()).status,'needs_credits');
});
