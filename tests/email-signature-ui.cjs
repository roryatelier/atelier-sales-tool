const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { chromium } = require('@playwright/test')
const { SignJWT } = require('jose')

const SIGNATURE = 'Fixture User\nExample Studio\n[Portfolio](https://portfolio.example.invalid/fixture)'

test('save a signature, generate, regenerate, and preview the same signature on send', { timeout: 240000 }, async () => {
  const root = path.resolve(__dirname, '..')
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-signature-ui-'))
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean)
  const extra = ['lib/email-signature.ts', 'lib/email-signature-store.ts', 'app/api/signature/route.ts', 'lib/send-confirmation-store.ts']
  for (const relative of [...new Set([...tracked, ...extra])]) {
    if (relative.startsWith('tests/') || relative.startsWith('.env') || relative === 'atelier.db' || relative.includes('service-account')) continue
    const file = path.join(root, relative)
    if (!fs.existsSync(file)) continue
    fs.mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true })
    fs.copyFileSync(file, path.join(fixture, relative))
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir')
  for (const relative of tracked.filter(file => file.startsWith('app/api/') && file.endsWith('/route.ts') && !file.includes('/me/') && !file.includes('/signature/'))) {
    const body = relative === 'app/api/email/route.ts'
      ? "import {NextResponse} from 'next/server'; let draft=0; export async function POST(){draft+=1; return NextResponse.json({success:true,guidance_source:'unknown',guidance_revision:'fixture-revision',email:{subject:'Fixture subject '+draft,body:'Hi Fixture,\\n\\nDraft '+draft+' for Fixture Brand.\\n\\nThanks,'}})}"
      : relative === 'app/api/email-guidance/route.ts'
        ? "import {NextResponse} from 'next/server'; export async function GET(){return NextResponse.json({success:true,guidance:'Fixture guidance'})} export async function PUT(){return NextResponse.json({success:true})}"
        : "import {NextResponse} from 'next/server'; const data={success:true,history:[],templates:[],timing:null}; export async function GET(){return NextResponse.json(data)} export async function POST(){return NextResponse.json(data)} export async function PUT(){return NextResponse.json(data)} export async function DELETE(){return NextResponse.json(data)}"
    fs.writeFileSync(path.join(fixture, relative), body)
  }
  fs.writeFileSync(path.join(fixture, 'no-egress.cjs'), "const original=global.fetch; global.fetch=async(url,options)=>{const target=String(url); if(target.startsWith('http://127.0.0.1:')||target.startsWith('http://localhost:')) return original(url,options); throw new Error('Fixture blocked server egress');};")
  const secret = 'synthetic-test-secret-only-'.repeat(3)
  const email = 'fixture.user@example.invalid'
  const token = await new SignJWT({ googleSub: 'owner-sig', email, name: 'Fixture User', picture: '', sessionVersion: 2 }).setProtectedHeader({ alg: 'HS256' }).setSubject('owner-sig').setIssuer('atelier-sales-tool').setAudience('atelier-app').setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(secret))
  const env = { PATH: process.env.PATH, NODE_ENV: 'development', TMPDIR: os.tmpdir(), JWT_SECRET: secret, APP_ALLOWED_EMAILS: email, NODE_OPTIONS: '--require ' + path.join(fixture, 'no-egress.cjs'), NEXT_TELEMETRY_DISABLED: '1' }
  const log = fs.createWriteStream(path.join(os.tmpdir(), 'atelier-signature-ui-server.log'))
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3174'], { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.pipe(log)
  server.stderr.pipe(log)
  let browser
  try {
    let ready = false
    for (let attempt = 0; attempt < 90 && !ready; attempt++) {
      try {
        const response = await fetch('http://127.0.0.1:3174/api/me', { headers: { cookie: 'atelier_session=' + token } })
        ready = response.status === 200
      } catch { /* server still booting */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 1000))
    }
    assert.ok(ready, 'Fixture starts')
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) })
    const context = await browser.newContext()
    await context.route('**/*', route => /^http:\/\/(127\.0\.0\.1|localhost):3174\//.test(route.request().url()) ? route.continue() : route.abort())
    await context.addCookies([{ name: 'atelier_session', value: token, url: 'http://localhost:3174', httpOnly: true }])
    await context.addInitScript(() => {
      localStorage.setItem('atelier:storage-owner:v2', 'owner-sig')
      localStorage.setItem('atelier:draft:v2:owner-sig:current_dossier', JSON.stringify({ brand_name: 'Fixture Brand', website: 'fixture.example.invalid' }))
      localStorage.setItem('atelier:draft:v2:owner-sig:atelier_user_name', 'Fixture User')
    })
    const errors = []
    const page = await context.newPage()
    page.setDefaultTimeout(20000)
    page.on('pageerror', error => errors.push(error.message))
    const sent = []
    const scheduled = []
    let releaseDelayedSend
    let markDelayedSendStarted
    const delayedSendStarted = new Promise(resolve => { markDelayedSendStarted = resolve })
    await page.route('**/api/send-email', async route => {
      sent.push(route.request().postDataJSON())
      if (sent.length === 1) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, outcome: 'uncertain', uncertain: true, error: 'This send is in progress or its outcome was not confirmed. Check Sent mail before retrying.' }),
        })
        return
      }
      if (sent.length === 2) {
        await route.abort('failed')
        return
      }
      if (sent.length === 4) await new Promise(resolve => {
        releaseDelayedSend = resolve
        markDelayedSendStarted()
      })
      await route.fulfill({ json: { success: true, outcome: 'accepted', message_id: 'fixture-message', ...(sent.length === 4 ? { replayed: true } : { pipeline_synced: true }) } })
    })
    await page.route('**/api/schedule-email', async route => {
      scheduled.push(route.request().postDataJSON())
      await route.fulfill({ json: { success: true } })
    })

    let guidanceSource = 'unknown'
    let guidanceWrites = 0
    await page.route('**/api/email-guidance', async route => {
      if (route.request().method() === 'PUT') {
        assert.equal(route.request().postDataJSON().guidance, 'Fixture legacy guidance')
        guidanceWrites++
        guidanceSource = 'stored'
        return route.fulfill({ json: { success: true } })
      }
      return route.fulfill({ json: { success: true, guidance: 'Fixture legacy guidance', guidance_source: guidanceSource, guidance_revision: 'fixture-revision' } })
    })

    const initialLoad = page.waitForResponse(response => response.url().endsWith('/api/signature') && response.request().method() === 'GET')
    await page.goto('http://localhost:3174/templates#signature')
    assert.equal((await initialLoad).status(), 200)
    await page.getByText('Existing guidance is in use. Its original source was not recorded.').waitFor()
    assert.equal(await page.getByLabel('Email generator guidance').inputValue(), 'Fixture legacy guidance')
    const guidanceSaved = page.waitForResponse(response => response.url().endsWith('/api/email-guidance') && response.request().method() === 'PUT')
    await page.getByRole('button', { name: 'Save guidance', exact: true }).click()
    assert.equal((await guidanceSaved).status(), 200)
    await page.getByText('Existing guidance is in use. Its original source was not recorded.').waitFor({ state: 'hidden' })
    assert.equal(guidanceWrites, 1)
    const editor = page.getByLabel('Email signature')
    await editor.fill(SIGNATURE)
    const save = page.waitForResponse(response => response.url().endsWith('/api/signature') && response.request().method() === 'PUT')
    await page.locator('#signature').getByRole('button', { name: 'Save signature' }).click()
    assert.equal((await save).status(), 200)
    const reloaded = page.waitForResponse(response => response.url().endsWith('/api/signature') && response.request().method() === 'GET')
    await page.reload()
    assert.equal((await reloaded).status(), 200)
    await page.waitForFunction(expected => document.querySelector('#signature textarea')?.value === expected, SIGNATURE)
    assert.equal(await page.getByLabel('Email signature').inputValue(), SIGNATURE)

    await page.goto('http://localhost:3174/templates')
    await page.evaluate(() => localStorage.setItem('atelier:draft:v2:owner-sig:selected_contact', JSON.stringify({ role: 'CEO', name: 'Fixture Contact', email: 'contact@example.invalid' })))
    await page.goto('http://localhost:3174/email')
    await page.locator('textarea').waitFor()
    await page.waitForFunction(() => /Draft \d+/.test(document.querySelector('textarea')?.value || ''))
    const firstDraft = Number((await page.locator('textarea').inputValue()).match(/Draft (\d+)/)[1])
    await page.getByText('Existing guidance (origin not recorded) · Guidance revision fixture-revision', { exact: false }).waitFor()
    await assertSignatureOnce(page)
    assert.equal((await page.locator('textarea').inputValue()).includes('Fixture User'), false)

    await page.getByRole('button', { name: 'Regenerate' }).click()
    await page.waitForFunction(previous => {
      const match = (document.querySelector('textarea')?.value || '').match(/Draft (\d+)/)
      return match && Number(match[1]) > previous
    }, firstDraft)
    const regenerated = Number((await page.locator('textarea').inputValue()).match(/Draft (\d+)/)[1])
    await assertSignatureOnce(page)
    assert.equal((await page.locator('textarea').inputValue()).includes(`Draft ${firstDraft}`), false)

    await page.getByRole('button', { name: 'New email tab' }).click()
    await page.waitForFunction(previous => {
      const match = (document.querySelector('textarea')?.value || '').match(/Draft (\d+)/)
      return match && Number(match[1]) > previous
    }, regenerated)
    await assertSignatureOnce(page)
    await page.getByRole('tab', { name: /Fixture Brand · Fixture/ }).click()
    await page.waitForFunction(draft => (document.querySelector('textarea')?.value || '').includes(`Draft ${draft}`), regenerated)
    await assertSignatureOnce(page)

    await page.evaluate(() => localStorage.removeItem('atelier:draft:v2:owner-sig:selected_contact'))
    await page.getByRole('link', { name: 'Edit signature' }).click()
    await page.waitForURL('**/templates#signature', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(expected => document.querySelector('#signature textarea')?.value === expected, SIGNATURE)
    await page.getByRole('link', { name: 'Email Generator' }).click()
    await page.waitForURL('**/email', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(draft => (document.querySelector('textarea')?.value || '').includes(`Draft ${draft}`), regenerated)
    await assertSignatureOnce(page)

    const currentDraft = Number((await page.locator('textarea').inputValue()).match(/Draft (\d+)/)[1])
    await page.getByRole('button', { name: 'Send email' }).click()
    const preview = page.locator('.modal .email-full')
    await preview.waitFor()
    assert.equal(occurrences(await preview.innerText(), 'Fixture User'), 1)
    assert.match(await preview.innerText(), new RegExp(`Draft ${currentDraft}`))
    assert.equal(await preview.locator('a').getAttribute('href'), 'https://portfolio.example.invalid/fixture')
    await page.locator('.modal-foot').getByRole('button', { name: 'Cancel' }).click()

    await page.getByRole('button', { name: 'New email tab' }).click()
    await page.locator('textarea').waitFor()
    await page.getByRole('button', { name: /Schedule send/ }).click()
    const schedulePreview = page.locator('.modal .email-full')
    await schedulePreview.waitFor()
    assert.equal(occurrences(await schedulePreview.innerText(), 'Fixture User'), 1)
    await page.locator('.modal-foot').getByRole('button', { name: 'Schedule send' }).click()
    await page.waitForFunction(() => document.body.innerText.includes('Email scheduled'))
    assert.equal(scheduled.length, 1)
    assert.equal(occurrences(scheduled[0].body, SIGNATURE), 1)
    assert.match(scheduled[0].body, /Draft \d+/)

    await page.getByRole('tab', { name: /Fixture Brand · Fixture/ }).click()
    await page.locator('input[type="file"]').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1536 * 1024, 65) })
    await page.getByText('fixture.txt', { exact: true }).waitFor()
    const stalePage = await context.newPage()
    await stalePage.goto('http://localhost:3174/email')
    await stalePage.locator('textarea').waitFor()
    const staleSubject = stalePage.locator('label.field-label', { hasText: /^Subject$/ }).locator('..').locator('input')
    const originalSubject = await staleSubject.inputValue()
    await page.getByRole('button', { name: 'Send email' }).click()
    await page.locator('.modal-foot').getByRole('button', { name: 'Confirm send' }).click()
    await page.getByText('This send is in progress or its outcome was not confirmed. Check Sent mail before retrying.').waitFor()
    const confirmed = await page.evaluate(() => JSON.parse(localStorage.getItem('atelier:draft:v2:owner-sig:email_tabs')).tabs.find(tab => tab.confirmedRequestId))
    assert.match(confirmed.confirmedDraftKey, /^[0-9a-f]{64}$/)
    assert.ok(confirmed.parkedSends.every(send => send.draftKey.length === 64))
    await staleSubject.fill('Stale browser edit')
    await staleSubject.fill(originalSubject)
    await stalePage.waitForFunction(subject => JSON.parse(localStorage.getItem('atelier:draft:v2:owner-sig:email_tabs')).tabs.some(tab => tab.email?.subject === subject && !tab.confirmedRequestId), originalSubject)
    await stalePage.close()
    // Reload without any intervening draft edit: the confirmed id must already
    // be durable, and the exact payload (including attachments) must survive.
    await page.reload()
    await page.locator('textarea').waitFor()
    await page.getByRole('button', { name: 'Send email' }).click()
    await page.locator('.modal-foot').getByRole('button', { name: 'Confirm send' }).click()
    await page.getByText('Gmail did not confirm this send. Check Sent mail before trying again.').waitFor()
    assert.equal(sent[1].request_id, sent[0].request_id, 'reload must replay the original send identity')
    assert.deepEqual(sent[1].attachments, sent[0].attachments, 'reload must preserve confirmed attachments')
    const subject = page.locator('label.field-label', { hasText: /^Subject$/ }).locator('..').locator('input')
    await subject.fill('Changed fixture subject')
    await page.waitForFunction(() => {
      const label = [...document.querySelectorAll('label.field-label')].find(node => node.textContent === 'Subject')
      return label?.parentElement?.querySelector('input')?.value === 'Changed fixture subject'
    })
    await page.getByRole('button', { name: 'Send email' }).click()
    await page.locator('.modal-foot').getByRole('button', { name: 'Confirm send' }).click()
    await page.getByText('Email sent successfully').waitFor()
    assert.equal(sent.length, 3)
    const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    assert.match(sent[0].request_id, requestId)
    assert.equal(sent[1].request_id, sent[0].request_id)
    assert.match(sent[2].request_id, requestId)
    assert.notEqual(sent[2].request_id, sent[0].request_id)
    assert.equal(sent[2].subject, 'Changed fixture subject')
    for (const payload of sent) {
      assert.equal(occurrences(payload.emailBody, SIGNATURE), 1)
      assert.match(payload.emailBody, new RegExp(`Draft ${currentDraft}`))
    }

    // Storage failure must prevent a provider request, rather than silently
    // starting a send whose identity cannot survive a reload.
    await page.getByRole('button', { name: 'New email tab' }).click()
    await page.locator('textarea').waitFor()
    const nextSubject = page.locator('label.field-label', { hasText: /^Subject$/ }).locator('..').locator('input')
    await nextSubject.fill('Delayed fixture subject')
    await page.evaluate(() => {
      window.originalIndexedDbOpen = IDBFactory.prototype.open
      IDBFactory.prototype.open = function() { throw new DOMException('Fixture denied', 'SecurityError') }
    })
    await page.getByRole('button', { name: 'Send email' }).click()
    await page.locator('.modal-foot').getByRole('button', { name: 'Confirm send' }).click()
    await page.getByText('Could not save this confirmation safely. Free browser storage and try again. This attempt was not sent.').waitFor()
    assert.equal(sent.length, 3, 'IndexedDB failure must prevent sending')
    await page.evaluate(() => { IDBFactory.prototype.open = window.originalIndexedDbOpen })
    await page.evaluate(() => {
      window.originalStorageSetItem = Storage.prototype.setItem
      Storage.prototype.setItem = function(key, value) {
        if (key.endsWith(':email_tabs')) throw new DOMException('Fixture quota', 'QuotaExceededError')
        return window.originalStorageSetItem.call(this, key, value)
      }
    })
    await page.getByRole('button', { name: 'Send email' }).click()
    await page.locator('.modal-foot').getByRole('button', { name: 'Confirm send' }).click()
    await page.getByText('Could not save this confirmation safely. Free browser storage and try again. This attempt was not sent.').waitFor()
    assert.equal(sent.length, 3)
    await page.evaluate(() => { Storage.prototype.setItem = window.originalStorageSetItem })

    // Keep A's request pending while switching to B. A's late acceptance must
    // update A alone, and attachments must not leak into this new draft.
    await page.getByRole('button', { name: 'Send email' }).click()
    await page.locator('.modal-foot').getByRole('button', { name: 'Confirm send' }).click()
    await delayedSendStarted
    assert.equal(sent[3].attachments, undefined, 'attachments belong to their original draft tab')
    await page.locator('.modal-foot').getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: 'New email tab' }).click()
    await page.locator('textarea').waitFor()
    await page.locator('label.field-label', { hasText: /^Subject$/ }).locator('..').locator('input').fill('Unsent fixture subject')
    releaseDelayedSend()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('atelier:draft:v2:owner-sig:email_tabs')).tabs.some(tab => tab.email?.subject === 'Delayed fixture subject' && tab.sent))
    assert.equal(await page.getByText('Email sent successfully').count(), 0, 'B must not inherit A acceptance')
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('atelier:draft:v2:owner-sig:email_tabs')))
    const sentTab = persisted.tabs.find(tab => tab.email?.subject === 'Delayed fixture subject')
    assert.ok(sentTab)
    await page.getByRole('tab').nth(persisted.tabs.findIndex(tab => tab.id === sentTab.id)).click()
    await page.getByText('Email sent successfully').waitFor()
    await page.getByText('Gmail accepted this email, but pipeline sync could not be confirmed. Check the pipeline separately; do not resend the email.').waitFor()
    await page.reload()
    await page.getByText('Email sent successfully').waitFor()

    // Exercise the real shared store from two independent documents. Claims
    // serialize, and an outdated refusal must not delete a newer identity.
    const storeSource = require('typescript').transpileModule(fs.readFileSync(path.join(root, 'lib/send-confirmation-store.ts'), 'utf8'), { compilerOptions: { module: require('typescript').ModuleKind.CommonJS, target: require('typescript').ScriptTarget.ES2020 } }).outputText
    const otherDocument = await context.newPage()
    await otherDocument.goto('http://localhost:3174/email')
    for (const document of [page, otherDocument]) await document.evaluate(source => {
      const exported = {}
      new Function('exports', source)(exported)
      window.storeForTest = exported
    }, storeSource)
    const identity = ['fixture-concurrency-owner', 'shared-tab', 'a'.repeat(64)]
    const ids = await Promise.all([
      page.evaluate(args => window.storeForTest.claimStoredSendId(...args, '11111111-1111-4111-8111-111111111111'), identity),
      otherDocument.evaluate(args => window.storeForTest.claimStoredSendId(...args, '22222222-2222-4222-8222-222222222222'), identity),
    ])
    assert.equal(ids[0], ids[1], 'concurrent documents must share one identity')
    await otherDocument.evaluate(args => window.storeForTest.forgetStoredSendId(...args, '33333333-3333-4333-8333-333333333333'), identity)
    assert.equal(await page.evaluate(args => window.storeForTest.claimStoredSendId(...args, '44444444-4444-4444-8444-444444444444'), identity), ids[0])
    await page.evaluate(args => window.storeForTest.forgetStoredSendId(...args), [...identity, ids[0]])
    assert.equal(await page.evaluate(args => window.storeForTest.claimStoredSendId(...args, '44444444-4444-4444-8444-444444444444'), identity), '44444444-4444-4444-8444-444444444444')
    await otherDocument.close()
    assert.deepEqual(errors, [])
  } finally {
    if (browser) await browser.close()
    server.kill('SIGTERM')
    log.end()
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

function occurrences(value, needle) {
  return String(value).split(needle).length - 1
}

async function assertSignatureOnce(page) {
  const preview = page.getByTestId('composer-signature')
  await preview.getByText('Fixture User').waitFor()
  assert.equal(occurrences(await preview.innerText(), 'Fixture User'), 1)
  assert.match(await preview.innerText(), /Example Studio/)
  assert.equal(await preview.locator('a').getAttribute('href'), 'https://portfolio.example.invalid/fixture')
  assert.equal(await preview.locator('a').innerText(), 'Portfolio')
}
