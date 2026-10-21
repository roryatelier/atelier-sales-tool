const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('@playwright/test')

test('scheduled recovery UI preserves failed cancellations and requires explicit resume', { timeout: 180000 }, async () => {
  const root = path.resolve(__dirname, '..')
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-scheduled-ui-'))
  fs.mkdirSync(path.join(fixture, 'app'))
  fs.mkdirSync(path.join(fixture, 'lib'))
  fs.copyFileSync(path.join(root, 'lib/browser-storage.ts'), path.join(fixture, 'lib/browser-storage.ts'))
  fs.copyFileSync(path.join(root, 'tsconfig.json'), path.join(fixture, 'tsconfig.json'))
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir')
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ private: true, dependencies: { next: '16.2.9', react: '19.2.4', 'react-dom': '19.2.4' } }))
  fs.writeFileSync(path.join(fixture, 'app/layout.tsx'), 'export default function Layout({children}:{children:React.ReactNode}){return <html><body>{children}</body></html>}')
  fs.writeFileSync(path.join(fixture, 'app/page.tsx'), "'use client'; import {useEffect,useState} from 'react'; import {activateBrowserIdentity} from '@/lib/browser-storage'; import ScheduledSends from './ScheduledSends'; export default function Page(){const [ready,setReady]=useState(false);useEffect(()=>{activateBrowserIdentity('synthetic-owner');setReady(true)},[]);return ready?<ScheduledSends/>:null}")
  fs.copyFileSync(path.join(root, 'app/components/ScheduledSends.tsx'), path.join(fixture, 'app/ScheduledSends.tsx'))
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3175'], { cwd: fixture, env: { PATH: process.env.PATH, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' })
  let browser
  try {
    let ready = false
    for (let i = 0; i < 90 && !ready; i++) { try { ready = (await fetch('http://127.0.0.1:3175')).ok } catch {} if (!ready) await new Promise(r => setTimeout(r, 1000)) }
    assert.ok(ready)
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) })
    const page = await browser.newPage({ timezoneId: 'America/Los_Angeles' })
    await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:3175/') ? route.continue() : route.abort())
    let failed = false; let resumes = 0; let cancel = false; let owner = 'synthetic-owner'; let holdNext = false; let releaseOld; let oldStarted
    const oldRequestStarted = new Promise(resolve => { oldStarted = resolve })
    const jobs = [
      { id: 1, to_email: 'pending@example.invalid', subject: 'Synthetic pending', scheduled_at: '2026-01-01T00:00:00Z', timezone: 'Australia/Sydney', delivery_status: 'pending' },
      { id: 2, to_email: 'paused@example.invalid', subject: 'Synthetic paused', scheduled_at: '2026-01-01T00:00:00Z', timezone: 'Australia/Sydney', delivery_status: 'needs_reauth' },
      { id: 3, to_email: 'uncertain@example.invalid', subject: 'Synthetic uncertain', scheduled_at: '2026-01-01T00:00:00Z', timezone: 'Australia/Sydney', delivery_status: 'needs_review' },
    ]
    await page.route('**/api/schedule-email**', async route => {
      if (route.request().method() === 'DELETE') { cancel = true; return route.fulfill({ status: 409, json: { error: 'Already processing' } }) }
      if (route.request().method() === 'PATCH') { resumes++; jobs[1].delivery_status = 'pending'; assert.equal(route.request().postDataJSON().expectedGoogleSub, 'synthetic-owner'); return route.fulfill({ json: { success: true } }) }
      if (holdNext) {
        holdNext = false
        const snapshot = JSON.parse(JSON.stringify(jobs))
        await new Promise(resolve => { releaseOld = resolve; oldStarted() })
        return route.fulfill({ json: { success: true, emails: snapshot, owner_google_sub: owner } })
      }
      return route.fulfill(failed ? { status: 503, json: { error: 'unavailable' } } : { json: { success: true, emails: jobs, owner_google_sub: owner } })
    })
    await page.goto('http://127.0.0.1:3175')
    const pending = page.locator('article').filter({ hasText: 'pending@example.invalid' })
    await pending.getByText('Overdue', { exact: false }).waitFor()
    assert.match(await pending.innerText(), /11:00 (am|AM)/)
    await pending.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByText('Already processing', { exact: false }).waitFor()
    assert.equal(cancel, true); assert.equal(await pending.count(), 1)
    const paused = page.locator('article').filter({ hasText: 'paused@example.invalid' })
    holdNext = true
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await oldRequestStarted
    await paused.getByRole('button', { name: 'Resume…' }).click(); assert.equal(resumes, 0)
    await paused.getByRole('button', { name: 'Confirm resume' }).click()
    await page.waitForFunction(() => !document.body.innerText.includes('Confirm resume'))
    assert.equal(resumes, 1)
    await paused.getByText('Overdue', { exact: false }).waitFor()
    releaseOld()
    await page.waitForTimeout(100)
    assert.equal(await paused.getByRole('button', { name: 'Resume…' }).count(), 0, 'a stale GET must not restore the old state')
    assert.equal(await page.locator('article').filter({ hasText: 'uncertain@example.invalid' }).getByRole('button').count(), 0)
    failed = true
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.getByText('Could not refresh scheduled sends.', { exact: false }).waitFor()
    assert.equal(await page.getByText('No scheduled sends', { exact: true }).count(), 0)
    failed = false
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.waitForFunction(() => !document.body.innerText.includes('Could not refresh'))
    owner = 'other-owner'
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.getByText('Your Google account changed.', { exact: false }).waitFor()
    assert.equal(await page.locator('article').count(), 0)

  } finally { if (browser) await browser.close(); server.kill('SIGTERM'); fs.rmSync(fixture, { recursive: true, force: true }) }
})
