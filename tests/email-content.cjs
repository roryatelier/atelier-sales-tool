/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const loadTypeScript = require('./load-ts.cjs')

const root = path.resolve(__dirname, '..')
const roles = loadTypeScript('../lib/email-role.ts')
const content = loadTypeScript('../lib/email-content.ts', { process: { env: {} } })

test('real prospect titles map to the intended outreach group', () => {
  const examples = {
    'Chief Financial Officer': 'CFO',
    'VP Finance': 'CFO',
    'Chief Operating Officer': 'COO',
    'Director of Supply Chain & Logistics': 'COO',
    'Chief Marketing Officer': 'CMO',
    'Global Brand Director': 'CMO',
    'Founder & CEO': 'CEO',
    'Managing Director': 'CEO',
    'VP Product Development': 'Head of NPD',
    'Director of New Product Development': 'Head of NPD',
    'Private Label Category Manager': 'Retailer',
    'Vice President, Client Partnerships': 'General'
  }

  for (const [title, expected] of Object.entries(examples)) {
    assert.equal(roles.canonicaliseEmailRole(title), expected, title)
  }
})

test('recovered content covers each required role and follow-up path', () => {
  const templates = content.RECOVERED_EMAIL_TEMPLATES
  assert.equal(templates.length, 9)
  assert.equal(new Set(templates.map(template => template.name)).size, templates.length)
  for (const role of ['', 'CEO', 'CFO', 'COO', 'CMO', 'Head of NPD', 'Retailer']) {
    assert.ok(templates.some(template => template.role === 'Cold Outreach' && template.target_role === role), `missing cold template for ${role || 'General'}`)
  }
  assert.ok(templates.some(template => template.role === 'Follow-up' && template.target_role === ''))
  assert.ok(templates.some(template => template.role === 'Follow-up' && template.target_role === 'Retailer'))
  assert.match(content.DEFAULT_EMAIL_GUIDANCE, /Tailor the message to the prospect's responsibilities/)
})

test('manual templates override automatic recovery and unknown titles do not receive CEO messaging', () => {
  const route = fs.readFileSync(path.join(root, 'app/api/email/route.ts'), 'utf8')
  assert.match(route, /template \?\? recoveredTemplate \?\? undefined/)
  assert.match(route, /MESSAGE_MATRIX\[canonicalRole\] \?\? MESSAGE_MATRIX\.General/)
  assert.doesNotMatch(route, /MESSAGE_MATRIX\['CEO'\]/)
})

test('template recovery is a one-time migration so user edits and deletions persist', () => {
  const source = fs.readFileSync(path.join(root, 'lib/email-content.ts'), 'utf8')
  assert.match(source, /content_migrations/)
  assert.match(source, /BEGIN/)
  assert.match(source, /COMMIT/)
  assert.doesNotMatch(source, /COUNT\(\*\).*templates/is)
})

