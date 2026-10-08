const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
const { SignJWT } = require('jose');

test('real contacts and composer: pagination, explicit reveal, manual choice and exact handoff', {timeout:180000}, async () => {
  const root=path.resolve(__dirname,'..'); const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'atelier-lusha-ui-'));
  const tracked=execFileSync('git',['ls-files','-z'],{cwd:root}).toString().split('\0').filter(Boolean);
  const extra=['lib/lusha.ts','lib/lusha-contact.ts','app/components/useLushaContacts.ts','app/components/ContactEmailActions.tsx'];
  for(const relative of [...new Set([...tracked,...extra])]) {
    if(relative.startsWith('tests/')||relative.startsWith('.env')||relative==='atelier.db'||relative.includes('service-account'))continue;
    const file=path.join(root,relative); if(!fs.existsSync(file))continue;
    fs.mkdirSync(path.dirname(path.join(fixture,relative)),{recursive:true});fs.copyFileSync(file,path.join(fixture,relative));
  }
  fs.symlinkSync(path.join(root,'node_modules'),path.join(fixture,'node_modules'),'dir');
  fs.writeFileSync(path.join(fixture,'lib/db.ts'),"export const isVercel=false; export function getLocalDb(){throw Error('No fixture DB');} export async function initialiseDb(){throw Error('No fixture DB');}");
  for(const relative of tracked.filter(p=>p.startsWith('app/api/')&&p.endsWith('/route.ts')&&!p.includes('lookup-contacts')&&!p.includes('/me/'))) {
    const dest=path.join(fixture,relative);fs.writeFileSync(dest,"import {NextResponse} from 'next/server'; const data={success:true,history:[],templates:[],email:{subject:'Fixture subject',body:'Fixture body'}}; export async function GET(){return NextResponse.json(data)} export async function POST(){return NextResponse.json(data)}");
  }
  fs.writeFileSync(path.join(fixture,'no-egress.cjs'),`const original=global.fetch; global.fetch=async(url,options)=>{const u=String(url);if(u.startsWith('https://api.lusha.com/v3/contacts/')){const b=JSON.parse(options.body);if(u.endsWith('/enrich')){if(b.ids[0]==='2')return new Response(JSON.stringify({status:'OUT_OF_CREDITS',results:[]}));if(b.ids[0]==='3')return new Response(JSON.stringify({results:[{id:'3',emails:[{email:'private3@example.invalid',type:'private'}]}]}));return new Response(JSON.stringify({results:[{id:b.ids[0],emails:[{email:'work'+b.ids[0]+'@example.invalid',type:'work'}]}]}));}const ids=Array.from({length:50},(_,i)=>String(i+(b.pagination.page===0?0:45)));return new Response(JSON.stringify({results:ids.map(id=>({id,firstName:'Contact',lastName:id,jobTitle:{title:'CEO'}})),pagination:{total:95,totalGuaranteed:true}}));}if(u.startsWith('http://localhost:'))return original(url,options);throw Error('Fixture blocked server egress');};`);
  const secret='synthetic-test-secret-only-'.repeat(3), email='tester@example.invalid';
  const token=await new SignJWT({googleSub:'owner-A',email,name:'Tester',picture:'',sessionVersion:2}).setProtectedHeader({alg:'HS256'}).setSubject('owner-A').setIssuer('atelier-sales-tool').setAudience('atelier-app').setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(secret));
  const env={PATH:process.env.PATH,NODE_ENV:'development',TMPDIR:os.tmpdir(),JWT_SECRET:secret,APP_ALLOWED_EMAILS:email,LUSHA_API_KEY:'synthetic-only',NODE_OPTIONS:'--require '+path.join(fixture,'no-egress.cjs'),NEXT_TELEMETRY_DISABLED:'1'};
  const log=fs.createWriteStream(path.join(os.tmpdir(),'atelier-lusha-ui-server.log'));
  const server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'dev','--webpack','--hostname','127.0.0.1','--port','3173'],{cwd:fixture,env,stdio:['ignore','pipe','pipe']});server.stdout.pipe(log);server.stderr.pipe(log);
  let browser;
  try{
    let ready=false;for(let i=0;i<60;i++){try{await fetch('http://localhost:3173/api/me',{headers:{cookie:'atelier_session='+token}});ready=true;break}catch{}await new Promise(r=>setTimeout(r,500))}assert.ok(ready,'Fixture starts');
    const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';browser=await chromium.launch({headless:true,...(fs.existsSync(chrome)?{executablePath:chrome}:{})});
    const context=await browser.newContext();await context.route('**/*',route=>route.request().url().startsWith('http://localhost:3173/')?route.continue():route.abort());await context.addCookies([{name:'atelier_session',value:token,url:'http://localhost:3173',httpOnly:true}]);
    const errors=[];const page=await context.newPage();page.setDefaultTimeout(15000);const revealRequests=[];page.on('request',request=>{if(request.url().endsWith('/api/lookup-contacts')&&request.method()==='POST'&&request.postDataJSON().enrich_id)revealRequests.push(request.postDataJSON())});page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message)});
    await context.addInitScript(()=>{localStorage.setItem('atelier:storage-owner:v2','owner-A');localStorage.setItem('atelier:draft:v2:owner-A:current_dossier',JSON.stringify({brand_name:'Fixture Brand',website:'example.invalid',score_band:'A',icp_score:90}));});
    await page.goto('http://localhost:3173/contacts');await page.getByText('50 contacts loaded',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Load more',exact:true}).click();await page.getByText('95 contacts loaded',{exact:true}).waitFor();
    const card=page.locator('.contact-card').filter({has:page.getByText('Contact 0',{exact:true})});await card.getByText('Contact 0',{exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Generate email for Contact 0',exact:true}).isEnabled(),false);assert.equal(revealRequests.length,0,'Selection does not spend');
    await card.getByRole('button',{name:'Reveal email',exact:true}).click();await card.getByText('work0@example.invalid',{exact:true}).waitFor();assert.equal(revealRequests.length,1);
    await page.getByRole('button',{name:'Generate email for Contact 0',exact:true}).click();await page.waitForURL('**/email');
    await page.locator('input').filter({hasNot:page.locator('[type="hidden"]')}).first().waitFor();
    await page.waitForFunction(()=>[...document.querySelectorAll('input')].some(i=>i.value==='work0@example.invalid'));
    await page.getByRole('button',{name:'Additional contacts'}).click();await page.getByText('50 contacts loaded',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Load more',exact:true}).click();await page.getByText('95 contacts loaded',{exact:true}).waitFor();
    await page.getByText('Contact 2',{exact:true}).locator('..').getByRole('button',{name:'Reveal email',exact:true}).click();await page.getByRole('alert').filter({hasText:'credits'}).waitFor();
    assert.ok(await page.locator('input').evaluateAll(inputs=>inputs.some(i=>i.value==='work0@example.invalid')));
    await page.getByText('Contact 3',{exact:true}).locator('..').getByRole('button',{name:'Reveal email',exact:true}).click();await page.getByRole('button',{name:'Use private email: private3@example.invalid'}).click();
    await page.getByText('Contact 3',{exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('input')].some(i=>i.value==='private3@example.invalid'));
    // A delayed reveal must not overwrite a manual recipient or a different tab.
    let release;
    let delayed = new Promise(resolve => {release=resolve});
    await page.route('**/api/lookup-contacts',async route=>{
      const request=route.request().postDataJSON();
      if(['4','5'].includes(request.enrich_id)) {await delayed;await route.fulfill({json:{success:true,status:'revealed',email:'late'+request.enrich_id+'@example.invalid'}})}
      else await route.continue();
    });
    await page.getByRole('button',{name:'Additional contacts'}).click();await page.getByText('50 contacts loaded',{exact:true}).waitFor();
    await page.getByText('Contact 4',{exact:true}).locator('..').getByRole('button',{name:'Reveal email',exact:true}).click();
    await page.getByPlaceholder('Enter email for Contact 3',{exact:true}).fill('manual@example.invalid');release();
    if (!(await page.getByText('Contact 4',{exact:true}).isVisible())) await page.getByRole('button',{name:'Additional contacts'}).click();
    await page.getByText('late4@example.invalid',{exact:true}).first().waitFor();
    assert.equal(await page.getByPlaceholder('Enter email for Contact 3',{exact:true}).inputValue(),'manual@example.invalid');
    delayed=new Promise(resolve=>{release=resolve});
    const lateResponse=page.waitForResponse(r=>r.url().endsWith('/api/lookup-contacts')&&r.request().postDataJSON().enrich_id==='5');
    await page.getByText('Contact 5',{exact:true}).locator('..').getByRole('button',{name:'Reveal email',exact:true}).click();
    await page.getByText('Fixture Brand · Contact',{exact:true}).first().click();release();await (await lateResponse).finished();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.waitForFunction(()=>[...document.querySelectorAll('input')].some(i=>i.value==='work0@example.invalid'));
    assert.equal(await page.getByPlaceholder('Enter email for Contact 0',{exact:true}).inputValue(),'work0@example.invalid');
    assert.deepEqual(errors,[]);
  }finally{if(browser)await browser.close();server.kill('SIGTERM');log.end();fs.rmSync(fixture,{recursive:true,force:true});}
});
