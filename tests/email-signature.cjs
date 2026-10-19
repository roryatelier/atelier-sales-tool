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

test('generation appends a signature outside the model and sends the same body', () => {
  const route = fs.readFileSync(path.join(root, 'app/api/email/route.ts'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'app/email/page.tsx'), 'utf8')
  const db = fs.readFileSync(path.join(root, 'lib/db.ts'), 'utf8')
  const gmail = fs.readFileSync(path.join(root, 'app/api/auth/gmail/route.ts'), 'utf8')
  assert.match(route, /SIGNATURE_RULE/)
  assert.match(route, /Do not write a signature block/)
  assert.doesNotMatch(route, /readSignature|appendSignature/)
  assert.match(page, /draftFromGeneration\(manualDraft\)/)
  assert.match(page, /draftFromGeneration\(data\.email\)/)
  assert.match(page, /emailBody: outboundBody\(\)/)
  assert.match(page, /body: outboundBody\(\)/)
  assert.match(page, /Edit signature/)
  assert.match(db, /CREATE TABLE IF NOT EXISTS email_signatures/)
  assert.match(gmail, /https:\/\/www\.googleapis\.com\/auth\/gmail\.send/)
  assert.doesNotMatch(gmail, /gmail\.(readonly|modify|compose|settings)/)
})
