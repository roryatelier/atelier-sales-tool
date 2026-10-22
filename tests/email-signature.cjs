/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const loadTypeScript = require('./load-ts.cjs')

const root = path.resolve(__dirname, '..')
const content = loadTypeScript('../lib/email-signature.ts')
const signature = 'Fixture User\nExample Studio\n[Portfolio](https://portfolio.example.invalid/fixture)'

function occurrences(value, needle) {
  return value.split(needle).length - 1
}

test('signature text is appended once and keeps line breaks and links', () => {
  const body = 'Hi Fixture,\n\nDraft for Fixture Brand.\n\nThanks,'
  const once = content.appendSignature(body, signature)
  assert.equal(once, `${body}\n\n${signature}`)
  assert.equal(occurrences(once, signature), 1)
  assert.equal(content.appendSignature(once, signature), once)
  assert.equal(content.appendSignature(content.appendSignature(once, `\n${signature}\n`), signature), once)

  const parts = content.signatureParts(signature)
  assert.equal(JSON.stringify(parts.filter(part => part.type === 'link')), JSON.stringify([{
    type: 'link',
    text: 'Portfolio',
    href: 'https://portfolio.example.invalid/fixture'
  }]))
  assert.equal(parts.filter(part => part.type === 'text').map(part => part.text).join(''), 'Fixture User\nExample Studio\n')
  assert.equal(content.safeSignatureHref('javascript:alert(1)'), null)
  const unsafe = content.signatureParts('[click](javascript:alert(1))')
  assert.equal(unsafe.some(part => part.type === 'link'), false)
  assert.equal(unsafe.map(part => part.text).join(''), '[click](javascript:alert(1))')
})

test('regenerating or reopening a draft does not duplicate or rewrite the signature', () => {
  const first = content.appendSignature('Draft 1\n\nThanks,', signature)
  const regenerated = content.appendSignature('Draft 2\n\nThanks,', signature)
  assert.equal(regenerated.includes('Draft 1'), false)
  assert.equal(occurrences(regenerated, signature), 1)
  assert.equal(content.appendSignature(first, signature), first)
  assert.equal(content.removeTrailingSignature(first, signature), 'Draft 1\n\nThanks,')
  assert.equal(content.appendSignature('I am grateful', 'grateful'), 'I am grateful\n\ngrateful')
  assert.equal(content.appendSignature('Hello \n', ''), 'Hello \n')
  assert.equal(content.appendSignature('Hello\r\n', 'Line 1\r\nLine 2'), 'Hello\n\nLine 1\nLine 2')
})

test('drafts saved before signatures existed still load', () => {
  const legacy = { subject: 'Hello', body: 'Hi there,' }
  assert.equal(content.signatureFromUnknown(undefined), '')
  assert.equal(content.signatureFromUnknown(legacy.signature), '')
  assert.equal(content.appendSignature(legacy.body, content.signatureFromUnknown(legacy.signature)), legacy.body)
  assert.equal(content.appendSignature(null, signature), signature)
  assert.equal(content.removeTrailingSignature(undefined, signature), '')
})

test('different accounts keep different signatures in sqlite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-signature-store-'))
  const previous = process.cwd()
  process.chdir(dir)
  try {
    const store = loadTypeScript('../lib/email-signature-store.ts', { process: { env: {}, cwd: () => process.cwd() } })
    const first = 'Signature A\n[Site](https://portfolio.example.invalid/a)'
    await store.writeSignature('account-a', 'a@example.invalid', first)
    await store.writeSignature('account-b', 'b@example.invalid', 'Signature B')
    assert.equal(await store.readSignature('account-a'), first)
    assert.equal(await store.readSignature('account-b'), 'Signature B')
    assert.equal(await store.readSignature('account-c'), '')
    await store.writeSignature('account-a', 'a@example.invalid', 'Signature A2')
    assert.equal(await store.readSignature('account-b'), 'Signature B')
    assert.equal(await store.readSignature('account-a'), 'Signature A2')
  } finally {
    process.chdir(previous)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a trailing signature matches across whitespace and line breaks without rewriting other drafts', () => {
  const opened = content.appendSignature('Draft 1\n\nThanks,', signature)
  assert.equal(content.removeTrailingSignature(`${opened} `, signature), 'Draft 1\n\nThanks,')
  assert.equal(content.removeTrailingSignature(opened.replace('Fixture User', 'Fixture User\u00a0'), signature), 'Draft 1\n\nThanks,')
  assert.equal(content.removeTrailingSignature(opened.replaceAll('\n', '\r'), signature), 'Draft 1\n\nThanks,')
  assert.equal(content.removeTrailingSignature(`${opened}\n\n${signature}`, signature), 'Draft 1\n\nThanks,')
  const mentioned = `Please see ${signature} in the note`
  assert.equal(content.removeTrailingSignature(mentioned, signature), mentioned)
  assert.equal(content.appendSignature(mentioned, signature), `${mentioned}\n\n${signature}`)
  assert.equal(content.removeTrailingSignature('Hello \n', signature), 'Hello \n')
  assert.equal(content.removeTrailingSignature('Hello\r\n', signature), 'Hello\r\n')
  assert.equal(content.safeSignatureHref('https://user:pass@example.invalid/secret'), null)
  assert.equal(content.safeSignatureHref('https://example.invalid/\r\nBcc: attacker@example.invalid'), null)
  assert.equal(content.safeSignatureHref('mailto:a@example.invalid\r\nCc: a@example.invalid'), null)
})

test('generation appends a signature outside the model and sends the same body', () => {
  const route = fs.readFileSync(path.join(root, 'app/api/email/route.ts'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'app/email/page.tsx'), 'utf8')
  const db = fs.readFileSync(path.join(root, 'lib/db.ts'), 'utf8')
  const gmailAuth = fs.readFileSync(path.join(root, 'app/api/auth/gmail/route.ts'), 'utf8')
  const send = fs.readFileSync(path.join(root, 'app/api/send-email/route.ts'), 'utf8')
  const gmail = fs.readFileSync(path.join(root, 'lib/gmail.ts'), 'utf8')
  assert.match(route, /SIGNATURE_RULE/)
  assert.match(route, /Do not write a signature block/)
  assert.doesNotMatch(route, /readSignature|appendSignature/)
  assert.match(page, /draftFromGeneration\(manualDraft\)/)
  assert.match(page, /draftFromGeneration\(data\.email\)/)
  assert.match(page, /emailBody: outboundBody\(\)/)
  assert.match(page, /body: outboundBody\(\)/)
  assert.match(page, /renderEmailDocument/)
  assert.match(page, /Edit signature/)
  assert.match(db, /CREATE TABLE IF NOT EXISTS email_signatures/)
  assert.match(gmailAuth, /https:\/\/www\.googleapis\.com\/auth\/gmail\.send/)
  assert.doesNotMatch(gmailAuth, /gmail\.(readonly|modify|compose|settings)/)
  assert.match(send, /buildHtmlEmailRaw\(to, subject, emailBody/)
  assert.doesNotMatch(send, /quoted-printable|href="\$2"|markdownToHtml/)
  assert.match(gmail, /return buildHtmlEmailRaw\(to, subject, body, cc, bcc\)/)
  assert.doesNotMatch(gmail, /quoted-printable/)
})

test('immediate and scheduled sends use the preview html', () => {
  const mime = loadTypeScript('../lib/email-mime.ts', { process: { env: {} }, Buffer })
  const gmail = loadTypeScript('../lib/gmail.ts', { process: { env: {} }, Buffer })
  const cases = [
    {
      name: 'javascript link',
      body: 'Hello,\n\n[click](javascript:alert(1))\n\nFixture User',
      assertHtml: html => {
        assert.equal(html.includes('<a '), false)
        assert.doesNotMatch(html, /href\s*=\s*["']?\s*javascript:/i)
        assert.match(html, /\[click\]\(javascript:alert\(1\)\)/)
      },
    },
    {
      name: 'attribute breakout',
      body: 'See [click](https://example.invalid/"onclick="alert(1))',
      assertHtml: html => {
        const tag = html.match(/<a\b[^>]*>/)[0]
        assert.equal(tag, '<a href="https://example.invalid/%22onclick=%22alert(1" style="color:#050849;">')
        assert.doesNotMatch(tag, /\sonclick\s*=/i)
        assert.equal(tag.split('"').length, 5)
      },
    },
    {
      name: 'equals twenty',
      body: 'Details: [record](https://example.invalid/?id=20)',
      assertHtml: html => {
        assert.match(html, /href="https:\/\/example\.invalid\/\?id=20"/)
        assert.doesNotMatch(html, /id= /)
      },
    },
    {
      name: 'crlf signature',
      body: 'Hello <b>there</b>\r\nBcc: injected@example.invalid',
      assertHtml: html => {
        assert.match(html, /Hello &lt;b&gt;there&lt;\/b&gt;/)
        assert.match(html, /Bcc: injected@example\.invalid/)
        assert.doesNotMatch(html, /<b>/)
      },
    },
  ]

  for (const entry of cases) {
    const preview = content.renderEmailDocument(entry.body)
    entry.assertHtml(preview)
    const immediate = mime.buildHtmlEmailRaw('recipient@example.invalid', 'Fixture subject', entry.body)
    const scheduled = gmail.makeEmailRaw('recipient@example.invalid', 'Fixture subject', entry.body)
    assert.equal(scheduled, immediate, entry.name)
    const decoded = htmlFromRaw(immediate)
    assert.equal(decoded.html, preview, entry.name)
    assert.equal(decoded.headers.split(/\r\n/).some(line => line.toLowerCase().startsWith('bcc:')), false, entry.name)
    const attachment = mime.buildHtmlEmailRaw('recipient@example.invalid', 'Fixture subject', entry.body, undefined, undefined, [{
      name: 'note.txt', type: 'text/plain', data: 'aGVsbG8=',
    }])
    assert.equal(htmlFromRaw(attachment).html, preview, `${entry.name} attachment`)
  }
})

function htmlFromRaw(raw) {
  const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4)
  const mime = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  const headerEnd = mime.indexOf('\r\n\r\n')
  assert.notEqual(headerEnd, -1)
  const headers = mime.slice(0, headerEnd)
  assert.equal(headers.replace(/\r\n/g, '').includes('\n'), false)
  const rest = mime.slice(headerEnd + 4)
  if (/Content-Type: text\/html/i.test(headers)) {
    assert.match(headers, /Content-Transfer-Encoding: base64/)
    assert.doesNotMatch(headers, /quoted-printable/)
    return { headers, html: Buffer.from(rest.replace(/\r\n/g, ''), 'base64').toString('utf8') }
  }
  const part = rest.match(/Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/)
  assert.ok(part)
  return { headers, html: Buffer.from(part[1].replace(/\r\n/g, ''), 'base64').toString('utf8') }
}

test('signature editor button state distinguishes empty, saved and edited states', () => {
  const max = 4000
  // Nothing saved, empty editor: prompt to save, disabled, empty-state hint visible
  let state = content.signatureEditorState({ loaded: true, saving: false, signature: '', savedSignature: '', maxLength: max })
  assert.equal(state.label, 'Save signature')
  assert.equal(state.disabled, true)
  assert.equal(state.showEmptyHint, true)

  // Nothing saved, text entered: save enabled, hint still visible (nothing persisted yet)
  state = content.signatureEditorState({ loaded: true, saving: false, signature: 'Thanks,\nFixture', savedSignature: '', maxLength: max })
  assert.equal(state.label, 'Save signature')
  assert.equal(state.disabled, false)
  assert.equal(state.showEmptyHint, true)

  // Saved and unchanged: shows Saved, disabled, no hint
  state = content.signatureEditorState({ loaded: true, saving: false, signature: 'Thanks,\nFixture', savedSignature: 'Thanks,\nFixture', maxLength: max })
  assert.equal(state.label, 'Saved')
  assert.equal(state.disabled, true)
  assert.equal(state.showEmptyHint, false)

  // Saved then edited: save enabled again
  state = content.signatureEditorState({ loaded: true, saving: false, signature: 'Thanks,\nFixture v2', savedSignature: 'Thanks,\nFixture', maxLength: max })
  assert.equal(state.label, 'Save signature')
  assert.equal(state.disabled, false)
  assert.equal(state.showEmptyHint, false)

  // Saving in progress: disabled regardless
  state = content.signatureEditorState({ loaded: true, saving: true, signature: 'x', savedSignature: '', maxLength: max })
  assert.equal(state.label, 'Saving...')
  assert.equal(state.disabled, true)

  // Not loaded: disabled
  state = content.signatureEditorState({ loaded: false, saving: false, signature: 'x', savedSignature: '', maxLength: max })
  assert.equal(state.disabled, true)

  // Over max length: disabled
  state = content.signatureEditorState({ loaded: true, saving: false, signature: 'x'.repeat(max + 1), savedSignature: '', maxLength: max })
  assert.equal(state.disabled, true)

  // Clearing a saved signature: enabled — empty editor over persisted content is a clear action
  state = content.signatureEditorState({ loaded: true, saving: false, signature: '', savedSignature: 'Thanks,\nFixture', maxLength: max })
  assert.equal(state.label, 'Save signature')
  assert.equal(state.disabled, false)
  assert.equal(state.showEmptyHint, false)

  // Whitespace-only editor content with nothing saved: treated as empty, disabled
  state = content.signatureEditorState({ loaded: true, saving: false, signature: '   ', savedSignature: '', maxLength: max })
  assert.equal(state.disabled, true)
  assert.equal(state.showEmptyHint, true)
})

