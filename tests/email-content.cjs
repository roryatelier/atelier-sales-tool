/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const loadTypeScript = require('./load-ts.cjs')

const root = path.resolve(__dirname, '..')
const roles = loadTypeScript('../lib/email-role.ts')
const content = loadTypeScript('../lib/email-content.ts', { process: { env: {} } })
const provenance = loadTypeScript('../lib/email-template-provenance.ts')

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

test('draft provenance distinguishes selected, automatic, template-free and fallback drafts', () => {
  assert.equal(
    JSON.stringify(provenance.generatedDraftProvenance({
      apiTemplateName: 'Manual selection',
      selectedTemplateName: 'Founder introduction',
      apiRoleGroup: 'CEO',
      requestedRole: 'Founder & CEO'
    })),
    JSON.stringify({ kind: 'manual-template', templateName: 'Founder introduction', roleGroup: 'CEO' })
  )
  assert.equal(
    JSON.stringify(provenance.generatedDraftProvenance({
      apiTemplateName: 'CMO outreach',
      apiRoleGroup: 'CMO',
      requestedRole: 'Marketing Director'
    })),
    JSON.stringify({ kind: 'automatic-template', templateName: 'CMO outreach', roleGroup: 'CMO' })
  )
  assert.equal(
    JSON.stringify(provenance.generatedDraftProvenance({ requestedRole: 'General Manager' })),
    JSON.stringify({ kind: 'no-template', templateName: null, roleGroup: 'General Manager' })
  )
  assert.equal(
    JSON.stringify(provenance.fallbackDraftProvenance('COO')),
    JSON.stringify({ kind: 'fallback', templateName: null, roleGroup: 'COO' })
  )
})

// Note: objects produced inside the transpiled-module sandbox have a different
// realm prototype, so compare via JSON rather than deepStrictEqual.
function at(value) { return JSON.stringify(value) }

test('guidance provenance distinguishes stored guidance from the default fallback', () => {
  assert.equal(
    at(content.guidanceProvenance({ content: 'Stored guidance text', source: 'user', updated_at: '2026-10-19 05:36:00' })),
    at({ source: 'stored', revision: '2026-10-19 05:36:00' })
  )
  assert.equal(at(content.guidanceProvenance(undefined)), at({ source: 'default', revision: 'default' }))
  assert.equal(at(content.guidanceProvenance(null)), at({ source: 'default', revision: 'default' }))
  assert.equal(
    at(content.guidanceProvenance({ content: '', updated_at: '2026-10-19 05:36:00' })),
    at({ source: 'default', revision: 'default' })
  )
  // A stored row whose timestamp is missing still reports stored, with an honest revision.
  assert.equal(
    at(content.guidanceProvenance({ content: 'Stored guidance text', source: 'user' })),
    at({ source: 'stored', revision: 'unknown' })
  )
})

test('draft provenance carries optional guidance fields and stays backward compatible', () => {
  const withGuidance = provenance.generatedDraftProvenance({
    apiTemplateName: 'CMO outreach',
    apiRoleGroup: 'CMO',
    requestedRole: 'Marketing Director',
    apiGuidanceSource: 'stored',
    apiGuidanceRevision: '2026-10-19 05:36:00'
  })
  assert.equal(withGuidance.kind, 'automatic-template')
  assert.equal(withGuidance.guidanceSource, 'stored')
  assert.equal(withGuidance.guidanceRevision, '2026-10-19 05:36:00')

  // Without guidance inputs the new fields are absent, not undefined — older callers
  // and persisted snapshots keep the exact same shape as PR #8.
  assert.equal(
    JSON.stringify(provenance.generatedDraftProvenance({ requestedRole: 'General Manager' })),
    JSON.stringify({ kind: 'no-template', templateName: null, roleGroup: 'General Manager' })
  )
  const defaultGuidance = provenance.generatedDraftProvenance({
    requestedRole: 'COO',
    apiGuidanceSource: 'default',
    apiGuidanceRevision: 'default'
  })
  assert.equal(defaultGuidance.guidanceSource, 'default')
  assert.equal(defaultGuidance.guidanceRevision, 'default')
  assert.equal(provenance.fallbackDraftProvenance('COO').guidanceSource, undefined)
})

test('per-draft instruction reaches the prompt last and is bounded', () => {
  const route = fs.readFileSync(path.join(root, 'app/api/email/route.ts'), 'utf8')
  // Accepted and validated on the request body.
  assert.match(route, /draft_instruction/)
  assert.match(route, /1000/)
  // The block exists in both prompt branches and carries an explicit conflict rule.
  assert.match(route, /PER-DRAFT INSTRUCTION/)
  assert.match(route, /unless it conflicts with the SIGNAL RULE/)
  assert.match(route, /must not change global guidance/)
  // Precedence: the instruction block sits after the safety/signature rules and before
  // OUTPUT FORMAT in the template branch. Anchor on the template-branch SIGNATURE RULE
  // usage ('SIGNATURE RULE\n' + SIGNATURE_RULE) — the plain first occurrence of
  // 'SIGNATURE RULE' is inside the block label itself.
  const signatureIndex = route.indexOf("'SIGNATURE RULE\\n' + SIGNATURE_RULE")
  const callSite = 'draftInstructionBlock(draftInstruction)'
  const templateCallIndex = signatureIndex === -1 ? -1 : route.indexOf(callSite, signatureIndex)
  const outputIndex = route.indexOf('OUTPUT FORMAT')
  assert.ok(signatureIndex !== -1 && templateCallIndex !== -1 && outputIndex !== -1)
  assert.ok(signatureIndex < templateCallIndex, 'instruction must come after the signature safety rule')
  assert.ok(templateCallIndex < outputIndex, 'instruction must come before the output format')
  // Non-template branch: instruction sits after the writing rules, before OUTPUT FORMAT.
  const nonTemplateIndex = route.indexOf('EMAIL WRITING RULES')
  assert.ok(nonTemplateIndex !== -1)
  assert.ok(route.indexOf(callSite, nonTemplateIndex) !== -1, 'non-template branch must include the instruction block')
  // Empty or whitespace-only instructions never inject a block (trimmed value falls
  // back to undefined before the prompt is built).
  assert.match(route, /draftInstruction = cleaned \|\| undefined/)
  assert.match(route, /\(draftInstruction \? draftInstructionBlock\(draftInstruction\) : ''\)/)
  })

test('guidance fallback is disclosed on every path, including route-level recovery failure', () => {
  const route = fs.readFileSync(path.join(root, 'app/api/email/route.ts'), 'utf8')
  // Route-level default fallback declares itself as default guidance.
  assert.match(route, /guidanceSource = 'default'/)
  assert.match(route, /guidanceRevision = 'default'/)
  // The lib reports what it used; the route passes both through to the response.
  assert.match(route, /guidance_source/)
  assert.match(route, /guidance_revision/)
  const lib = fs.readFileSync(path.join(root, 'lib/email-content.ts'), 'utf8')
  // The lib-level fallback (missing row) also reports default.
  assert.match(lib, /guidanceProvenance/)
})

test('review fixes: contact-tab instruction leak, snapshot persistence, fallback notice resets', () => {
  const page = fs.readFileSync(path.join(root, 'app/email/page.tsx'), 'utf8')
  // 1. A generation request made in the same event as opening a new contact tab must
  // not read the previous tab's instruction (stale closure). handleContactSelect
  // overrides the instruction explicitly.
  assert.match(page, /instructionOverride/, 'generateEmail must accept an instruction override')
  assert.match(page, /generateEmail\(c\.role, undefined, undefined, \{ dossier, contactName: c\.name \|\| 'there' \}, ''\)/, 'contact-tab generation must pass an empty instruction')
  assert.match(page, /instructionOverride \?\? draftInstruction/, 'request body must prefer the override')
  // 2. Instruction-only edits must trigger tab persistence (dep list includes it).
  const depsIndex = page.indexOf('}, [email, draftProvenance, draftInstruction')
  assert.ok(depsIndex !== -1, 'persistence effect deps must include draftInstruction')
  const templatesPage = fs.readFileSync(path.join(root, 'app/templates/page.tsx'), 'utf8')
  // 3. Saving guidance must clear the default-fallback notice.
  assert.match(templatesPage, /setGuidanceFallback\(false\)/, 'a successful save must clear the fallback notice')
  // 4. When the editor loads default guidance, it must be saveable unchanged
  // (fallback content counts as unsaved).
  assert.match(templatesPage, /setSavedGuidance\(data\.guidance_source === 'default' \|\| data\.guidance_source === 'unknown' \? '' : data\.guidance\)/, 'fallback guidance must not be treated as already-saved')
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



test('database guidance provenance survives seeding, explicit saves and legacy migration', async () => {
  const os = require('node:os')
  const Database = require('better-sqlite3')
  for (const legacy of [null, content.DEFAULT_EMAIL_GUIDANCE, 'Legacy custom fixture guidance']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-guidance-'))
    try {
      if (legacy) {
        const db = new Database(path.join(dir, 'atelier.db'))
        db.exec("CREATE TABLE email_guidance (id INTEGER PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))")
        db.prepare('INSERT INTO email_guidance (id, content) VALUES (1, ?)').run(legacy)
        db.close()
      }
      const store = loadTypeScript('../lib/email-content.ts', { process: { env: {}, cwd: () => dir } })
      const initial = await store.getEmailGuidanceInfo()
      assert.equal(initial.guidanceSource, legacy ? 'unknown' : 'default')
      assert.equal(initial.content, legacy || content.DEFAULT_EMAIL_GUIDANCE)
      assert.equal((await store.getDraftEmailContent('CFO', false)).guidanceSource, initial.guidanceSource)
      // Saving the exact default text explicitly must count as a user save.
      await store.updateEmailGuidance(content.DEFAULT_EMAIL_GUIDANCE)
      assert.equal((await store.getEmailGuidanceInfo()).guidanceSource, 'stored')
      assert.equal((await store.getDraftEmailContent('CFO', false)).guidanceSource, 'stored')
      await store.updateEmailGuidance('Custom fixture guidance')
      await store.ensureRecoveredEmailContent()
      assert.equal((await store.getEmailGuidanceInfo()).content, 'Custom fixture guidance')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})


test('legacy origin stays unknown through draft provenance transport', () => {
  const draft = provenance.generatedDraftProvenance({ requestedRole: 'CFO', apiGuidanceSource: 'unknown', apiGuidanceRevision: 'legacy-revision' })
  assert.equal(draft.guidanceSource, 'unknown')
  assert.equal(content.guidanceProvenance({ content: 'Legacy custom fixture guidance' }).source, 'unknown')
})


test('rollback-era guidance edits override an obsolete default marker', async () => {
  const os = require('node:os')
  const Database = require('better-sqlite3')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-guidance-rollback-'))
  try {
    const store = loadTypeScript('../lib/email-content.ts', { process: { env: {}, cwd: () => dir } })
    await store.ensureRecoveredEmailContent()
    const db = new Database(path.join(dir, 'atelier.db'))
    db.prepare("UPDATE email_guidance SET content = ?, updated_at = '2026-10-20 00:00:00' WHERE id = 1").run('Guidance saved by the older writer')
    db.close()
    const info = await store.getEmailGuidanceInfo()
    assert.equal(info.content, 'Guidance saved by the older writer')
    assert.equal(info.guidanceSource, 'unknown')
    assert.equal(info.guidanceRevision, '2026-10-20 00:00:00')
    assert.equal((await store.getDraftEmailContent('CFO', false)).guidance, info.content)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
