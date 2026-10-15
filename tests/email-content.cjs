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
    'VP, Finance': 'CFO',
    'Vice President of Finance': 'CFO',
    'Director of Finance': 'CFO',
    'Chief Operating Officer': 'COO',
    'Vice President, Operations': 'COO',
    'Director of Operations': 'COO',
    'Director of Supply Chain & Logistics': 'COO',
    'Chief Marketing Officer': 'CMO',
    'Vice President of Marketing': 'CMO',
    'Director of Marketing': 'CMO',
    'Director of Product Marketing': 'CMO',
    'Global Brand Director': 'CMO',
    'Founder & CEO': 'CEO',
    'Managing Director': 'CEO',
    'VP Product Development': 'Head of NPD',
    'Vice President, Product': 'Head of NPD',
    'Director of Product': 'Head of NPD',
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
  assert.equal(templates.some(template => /I've attached/i.test(template.body)), false)
  assert.match(content.DEFAULT_EMAIL_GUIDANCE, /Tailor the message to the prospect's responsibilities/)
})

test('user templates and legacy role labels take priority over recovered defaults', () => {
  const templates = [
    { name: 'User VP Marketing', role: 'Cold Outreach', subject: 'User', body: 'User', target_role: 'VP Marketing', source: 'user' },
    { name: 'Recovered CMO', role: 'Cold Outreach', subject: 'Recovered', body: 'Recovered', target_role: 'CMO', source: 'recovered' },
    { name: 'Recovered general', role: 'Cold Outreach', subject: 'General', body: 'General', target_role: '', source: 'recovered' }
  ]
  assert.equal(content.chooseTemplate(templates, 'CMO').name, 'User VP Marketing')
  assert.equal(content.chooseTemplate(templates, 'CFO').name, 'Recovered general')

  const generalOverride = [
    { name: 'User general', role: 'Cold Outreach', subject: 'User', body: 'User', target_role: '', source: 'user' },
    { name: 'Recovered CFO', role: 'Cold Outreach', subject: 'Recovered', body: 'Recovered', target_role: 'CFO', source: 'recovered' }
  ]
  assert.equal(content.chooseTemplate(generalOverride, 'CFO').name, 'User general')
})

test('manual templates override automatic recovery and unknown titles do not receive CEO messaging', () => {
  const route = fs.readFileSync(path.join(root, 'app/api/email/route.ts'), 'utf8')
  assert.match(route, /template \?\? recoveredTemplate \?\? undefined/)
  assert.match(route, /MESSAGE_MATRIX\[canonicalRole\] \?\? MESSAGE_MATRIX\.General/)
  assert.doesNotMatch(route, /MESSAGE_MATRIX\['CEO'\]/)
  assert.match(route, /verifiedSignals\.length === 0/)
  assert.match(route, /Do not invent or imply a second signal/)
  assert.doesNotMatch(route, /weave at least two/i)
  assert.match(route, /FOLLOW-UP CONTEXT/)
  assert.match(route, /Do not claim an attachment is included/)
})

test('template recovery is a one-time migration so user edits and deletions persist', () => {
  const source = fs.readFileSync(path.join(root, 'lib/email-content.ts'), 'utf8')
  assert.match(source, /content_migrations/)
  assert.match(source, /outreach_templates_2026_09_v2_review_fixes/)
  assert.match(source, /BEGIN/)
  assert.match(source, /COMMIT/)
  assert.match(source, /source = 'recovered'/)
  assert.match(source, /name = \$1 AND role = \$2 AND subject = \$3 AND target_role = \$4/)
  assert.doesNotMatch(source, /COUNT\(\*\).*templates/is)
})

