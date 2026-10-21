const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('@playwright/test')

test('pipeline retries never send email and edits target a specific outreach', { timeout: 180000 }, async () => {
  const root = path.resolve(__dirname, '..')
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-outbox-ui-'))
  fs.mkdirSync(path.join(fixture, 'app'))
  fs.mkdirSync(path.join(fixture, 'lib'))
  fs.mkdirSync(path.join(fixture, 'app/pipeline'))
  fs.mkdirSync(path.join(fixture, 'app/components'))
  fs.copyFileSync(path.join(root, 'lib/browser-storage.ts'), path.join(fixture, 'lib/browser-storage.ts'))
  fs.copyFileSync(path.join(root, 'tsconfig.json'), path.join(fixture, 'tsconfig.json'))
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir')
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ private: true, dependencies: { next: '16.2.9', react: '19.2.4', 'react-dom': '19.2.4' } }))
  fs.writeFileSync(path.join(fixture, 'app/layout.tsx'), 'export default function Layout({children}:{children:React.ReactNode}){return <html><body>{children}</body></html>}')
  fs.writeFileSync(path.join(fixture, 'app/page.tsx'), "'use client'; import {useEffect,useState} from 'react'; import {activateBrowserIdentity} from '@/lib/browser-storage'; import Pipeline from './pipeline/page'; export default function Page(){const [ready,setReady]=useState(false);useEffect(()=>{activateBrowserIdentity('synthetic-owner');setReady(true)},[]);return ready?<Pipeline/>:null}")
  fs.copyFileSync(path.join(root, 'app/components/PipelineSyncStatus.tsx'), path.join(fixture, 'app/components/PipelineSyncStatus.tsx'))
  fs.copyFileSync(path.join(root, 'app/pipeline/page.tsx'), path.join(fixture, 'app/pipeline/page.tsx'))
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3176'], { cwd: fixture, env: { PATH: process.env.PATH, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' })
  let browser
  try {
    let ready = false
    for (let i = 0; i < 90 && !ready; i++) { try { ready = (await fetch('http://127.0.0.1:3176')).ok } catch {} if (!ready) await new Promise(r => setTimeout(r, 1000)) }
    assert.ok(ready)
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) })
    const page = await browser.newPage({ timezoneId: 'America/Los_Angeles' })
    await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:3176/') ? route.continue() : route.abort())
    let owner='synthetic-owner';let failRetry=true;let readsFail=false;let sends=0;let holdNext=false;let releaseOld;let oldStarted
    const oldStartedPromise=new Promise(resolve=>{oldStarted=resolve})
    page.on('request',request=>{if(request.url().includes('/api/send-email'))sends++})
    const jobs=[{outreach_id:'immediate:1',brand_name:'Synthetic',to_email:'recipient@example.invalid',subject:'Synthetic accepted',status:'failed'},
      {outreach_id:'immediate:2',brand_name:'Synthetic uncertain',to_email:'other@example.invalid',subject:'Synthetic uncertain',status:'needs_review'}]
    const base={brand_name:'Same synthetic brand',website:'example.invalid',lead_source:'Outbound',date_added:'01/01/2026',status:'Sent',icp_score:'50',score_band:'B',notes:''}
    const leads=[{...base,pipeline_key:'immediate:1',outreach_id:'immediate:1',contact_name:'Contact One'}, {...base,pipeline_key:'immediate:2',outreach_id:'immediate:2',contact_name:'Contact Two'}]
    const writes=[]
    let failEdit=true;let holdEdit=false;let releaseEdit;let editStarted
    const editStartedPromise=new Promise(resolve=>{editStarted=resolve})
    await page.route('**/api/pipeline',route=>route.fulfill({json:{success:true,leads}}))
    await page.route('**/api/update-pipeline',async route=>{
      const input=route.request().postDataJSON();writes.push(input)
      if(failEdit)return route.fulfill({status:409,json:{error:'Synthetic legacy conflict'}})
      if(holdEdit)await new Promise(resolve=>{releaseEdit=resolve;editStarted()})
      leads.find(lead=>lead.outreach_id===input.outreach_id).status=input.status
      return route.fulfill({json:{success:true}})
    })
    await page.route('**/api/update-notes',route=>{writes.push(route.request().postDataJSON());return route.fulfill({json:{success:true}})})
    await page.route('**/api/pipeline-exports',async route=>{
      if(route.request().method()==='POST'){
        const input=route.request().postDataJSON();assert.equal(input.expectedGoogleSub,'synthetic-owner')
        if(failRetry)return route.fulfill({status:503,json:{error:'Synthetic Sheets outage'}})
        const job=jobs.find(job=>job.outreach_id===input.outreach_id)
        if(job.status!=='needs_review')job.status='synced'
        return route.fulfill({json:{success:true,status:job.status}})
      }
      if(holdNext){holdNext=false;const snapshot=JSON.parse(JSON.stringify(jobs));await new Promise(resolve=>{releaseOld=resolve;oldStarted()});return route.fulfill({json:{success:true,exports:snapshot,owner_google_sub:owner}})}
      return route.fulfill(readsFail?{status:503,json:{error:'unavailable'}}:{json:{success:true,exports:jobs,owner_google_sub:owner}})
    })
    await page.goto('http://127.0.0.1:3176')
    const sync=page.getByRole('region',{name:'Pipeline sync',exact:true})
    await sync.getByRole('button',{name:'Retry sync',exact:true}).click()
    await sync.getByText('Synthetic Sheets outage').waitFor()
    assert.equal(await sync.getByRole('button',{name:'Retry sync',exact:true}).count(),1)
    holdNext=true;await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await oldStartedPromise
    failRetry=false;await sync.getByRole('button',{name:'Retry sync',exact:true}).click()
    await page.waitForFunction(()=>!document.querySelector('section[aria-label="Pipeline sync"]').innerText.includes('Retry sync'))
    releaseOld();await page.waitForTimeout(100)
    assert.equal(await sync.getByRole('button',{name:'Retry sync',exact:true}).count(),0)
    await sync.getByRole('button',{name:'Check Sheets',exact:true}).click()
    await sync.getByText('Sheets did not confirm the append.',{exact:false}).waitFor()
    assert.equal(sends,0)
    const rowOne=page.locator('tbody tr').filter({hasText:'Contact One'})
    const rowTwo=page.locator('tbody tr').filter({hasText:'Contact Two'})
    await rowOne.locator('select').selectOption('Called')
    await page.getByText('Synthetic legacy conflict').waitFor()
    assert.equal(await page.locator('tbody tr').count(),2,'an edit error must preserve loaded rows')
    failEdit=false;holdEdit=true
    await rowTwo.locator('select').selectOption('Replied')
    await editStartedPromise
    leads.reverse()
    await page.evaluate(()=>window.dispatchEvent(new Event('pipeline-sync-complete')))
    await page.waitForFunction(()=>document.querySelector('tbody').innerText.indexOf('Contact Two')<document.querySelector('tbody').innerText.indexOf('Contact One'))
    releaseEdit()
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('tbody tr')).find(row=>row.innerText.includes('Contact Two')).querySelector('select').value==='Replied')
    assert.equal(await rowOne.locator('select').inputValue(),'Sent')
    assert.equal(writes.at(-1).outreach_id,'immediate:2')
    await rowTwo.getByText('+ Add note',{exact:true}).click()
    await rowTwo.locator('input').fill('Synthetic note')
    await rowTwo.getByRole('button',{name:'Save',exact:true}).click()
    await rowTwo.getByText('Synthetic note',{exact:true}).waitFor()
    assert.equal(writes.at(-1).outreach_id,'immediate:2')
    readsFail=true;await sync.getByRole('button',{name:'Refresh sync status'}).click()
    await sync.getByText('Could not load pipeline sync status').waitFor()
    readsFail=false;await sync.getByRole('button',{name:'Refresh sync status'}).click()
    await page.waitForFunction(()=>!document.body.innerText.includes('Could not load pipeline sync status'))
    owner='other-owner';await sync.getByRole('button',{name:'Refresh sync status'}).click()
    await sync.getByText('Your account changed. Reload before continuing.').waitFor()
    assert.equal(await sync.locator('article').count(),0)

  } finally { if (browser) await browser.close(); server.kill('SIGTERM'); fs.rmSync(fixture, { recursive: true, force: true }) }
})
