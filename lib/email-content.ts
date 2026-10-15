import { getLocalDb, initialiseDb, isVercel } from '@/lib/db'
import { canonicaliseEmailRole, type CanonicalEmailRole } from '@/lib/email-role'

export interface EmailTemplateContent {
  id?: number
  name: string
  role: string
  subject: string
  body: string
  target_role: string
}

export interface DraftEmailContent {
  canonicalRole: CanonicalEmailRole
  guidance: string
  template: EmailTemplateContent | null
}

const RECOVERY_MIGRATION = 'outreach_templates_2026_09_v1'

// Recovered from the company-owned “Outreach Templates” Google Doc, last updated 16 September 2026.
export const DEFAULT_EMAIL_GUIDANCE = `Always open with a genuine, specific reason for reaching out, such as a launch, acquisition, campaign, retail expansion, hiring signal, or recent role change.

Tailor the message to the prospect's responsibilities and explain how Atelier can make their job easier. Keep the initial email concise: earn attention, use only the most relevant benefits, and finish with a soft request for a call.

Use Atelier's approved proof points selectively: launch products 6x faster, increase product output by 10x, reduce the cost of innovation to near $0, and improve operating profit margins by up to 2x. Do not force every proof point into one email.

For follow-ups, add a useful new reason to respond, such as an introduction deck or a new brand signal, instead of repeating the first email.`

export const RECOVERED_EMAIL_TEMPLATES: EmailTemplateContent[] = [
  {
    name: 'General initial outreach',
    role: 'Cold Outreach',
    target_role: '',
    subject: '[Brand] x Atelier — faster product innovation',
    body: `Hi [Name],

I'm [Your name] from Atelier.

[Personalised introduction tailored to the brand and a recent signal.]

Atelier's GenAI platform streamlines the end-to-end NPD and manufacturing process, using 8.5M+ supply chain permutations to match product specifications with aligned manufacturer capabilities.

We've helped leading beauty brands and retailers launch products 6x faster, increase product output by 10x and reduce the cost of innovation to near $0 — without incremental headcount or internal resource strain.

Would you be open to a quick call next week to explore how Atelier could support [Brand]'s growth and innovation goals?

Thank you,
[Your name]`
  },
  {
    name: 'Retailer initial outreach',
    role: 'Cold Outreach',
    target_role: 'Retailer',
    subject: '[Retailer] x Atelier — private-label innovation',
    body: `Hi [Name],

I'm [Your name] from Atelier.

[Personalised introduction about the retailer's health, beauty or private-label activity.]

Atelier partners with retailers to scale private-label innovation with greater speed, cost efficiency and operational control. Our GenAI platform streamlines end-to-end NPD and manufacturing through 8.5M+ supply chain permutations.

We've helped beauty, health and wellness companies launch products 6x faster, increase product output by 10x and reduce the cost of innovation to near $0.

Would you be open to a brief conversation next week about [Retailer]'s private-label innovation priorities?

Thank you,
[Your name]`
  },
  {
    name: 'CFO outreach',
    role: 'Cold Outreach',
    target_role: 'CFO',
    subject: 'Transforming [Brand]’s NPD economics',
    body: `Hi [Name],

I'm [Your name] from Atelier.

[Specific compliment or recent commercial signal.]

As [Brand] continues to scale, Atelier can help accelerate innovation while improving supply-chain resilience and reducing fixed costs. Our AI-powered manufacturing platform helps brands launch products faster with less capital and operational complexity.

Atelier has helped brands launch new products 6x faster, increase SKU output by 10x and reduce NPD costs to near $0. The result is faster revenue generation, greater agility and improved operating leverage.

Would you be open to a 20-minute conversation to explore whether there could be a fit for [Brand]?

Thank you,
[Your name]`
  },
  {
    name: 'COO outreach',
    role: 'Cold Outreach',
    target_role: 'COO',
    subject: 'Rethinking NPD and manufacturing for [Brand]',
    body: `Hi [Name],

I'm [Your name] from Atelier.

[Specific operational, hiring or expansion signal.]

Atelier's GenAI platform streamlines end-to-end NPD and manufacturing, using 8.5M+ supply chain permutations to match product specifications with aligned manufacturer capabilities. Our network-based approach supports agile product development and end-to-end supply-chain management without adding internal overhead.

Brands working with Atelier have launched products 6x faster, increased product output by 10x without a new FTE and reduced NPD costs to near $0.

Would you be open to a quick call this week to explore whether Atelier could help [Brand] scale more efficiently?

Best,
[Your name]`
  },
  {
    name: 'CEO and founder outreach',
    role: 'Cold Outreach',
    target_role: 'CEO',
    subject: '[Brand] x Atelier — scaling innovation',
    body: `Hi [Name],

[Specific compliment about what the founder or leadership team has built.]

I'm [Your name] from Atelier, an AI-native manufacturing platform that helps brands like [Brand] innovate quickly, scale efficiently and maintain the standards that define their brand.

We've helped brands transform their innovation economics by developing products 6x faster, increasing SKU output by 10x and reducing the cost of NPD to near $0.

Would you be open to a quick call this week to explore how Atelier could support [Brand]'s growth and innovation goals?

Thank you,
[Your name]`
  },
  {
    name: 'CMO outreach',
    role: 'Cold Outreach',
    target_role: 'CMO',
    subject: 'Increasing [Brand]’s innovation velocity',
    body: `Hi [Name],

I'm [Your name] from Atelier.

[Specific compliment about a recent campaign, collaboration, launch or cultural moment.]

Atelier's AI-powered manufacturing platform helps beauty brands bring more products to market faster and more efficiently. Our network-based approach enables agile product development without traditional overhead, helping brands respond to trends and cultural moments in real time.

Brands partnering with Atelier have launched products 6x faster, increased product output by 10x without internal resource drain and reduced the cost of innovation to near $0.

Would you be open to a quick chat this week to explore whether there's a fit for [Brand]?

Best,
[Your name]`
  },
  {
    name: 'Head and Director of NPD outreach',
    role: 'Cold Outreach',
    target_role: 'Head of NPD',
    subject: '[Brand] x Atelier — faster, more efficient innovation',
    body: `Hi [Name],

I'm [Your name] from Atelier.

[Specific compliment about the brand's product strategy or recent launches.]

Atelier helps NPD teams increase innovation capacity by removing the manual and operational work that consumes product-development time. Our GenAI platform streamlines end-to-end NPD and manufacturing through 8.5M+ supply chain permutations.

We've helped leading beauty brands launch products 6x faster, increase product output by 10x and reduce the operational burden of product development without adding headcount.

Would you be open to a brief call this week to explore how Atelier could support [Brand]'s growth and innovation goals?

Best,
[Your name]`
  },
  {
    name: 'Brand follow-up',
    role: 'Follow-up',
    target_role: '',
    subject: 'Following up — [Brand] x Atelier',
    body: `Hi [Name],

Kindly following up on my previous note.

I've attached an introduction deck for your reference. It shows how Atelier helps beauty brands expand capacity and bring more products to market faster and more efficiently, without internal resource drain or incremental headcount.

Would you be open to a quick call next week to explore how Atelier could support [Brand]'s growth and innovation goals?

Thanks,
[Your name]`
  },
  {
    name: 'Retailer follow-up',
    role: 'Follow-up',
    target_role: 'Retailer',
    subject: 'Following up — [Retailer] x Atelier',
    body: `Hi [Name],

Kindly following up on my previous note.

I've attached an introduction deck for your reference. It shows how Atelier helps retailers expand capacity, scale own-brand innovation and bring products to market faster, without internal resource drain or incremental headcount.

Would you be open to a quick call next week to explore how Atelier could support [Retailer]'s private-label innovation priorities?

Thanks,
[Your name]`
  }
]

async function seedPostgresContent() {
  const { sql } = await import('@vercel/postgres')
  const client = await sql.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('atelier-email-content-v1'))")
    const existing = await client.query('SELECT key FROM content_migrations WHERE key = $1', [RECOVERY_MIGRATION])
    if (existing.rowCount === 0) {
      await client.query('INSERT INTO email_guidance (id, content) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [DEFAULT_EMAIL_GUIDANCE])
      for (const template of RECOVERED_EMAIL_TEMPLATES) {
        await client.query(
          'INSERT INTO templates (name, role, subject, body, target_role) VALUES ($1, $2, $3, $4, $5)',
          [template.name, template.role, template.subject, template.body, template.target_role]
        )
      }
      await client.query('INSERT INTO content_migrations (key) VALUES ($1)', [RECOVERY_MIGRATION])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function seedSqliteContent() {
  const db = getLocalDb()
  const seed = db.transaction(() => {
    const existing = db.prepare('SELECT key FROM content_migrations WHERE key = ?').get(RECOVERY_MIGRATION)
    if (existing) return
    db.prepare('INSERT OR IGNORE INTO email_guidance (id, content) VALUES (1, ?)').run(DEFAULT_EMAIL_GUIDANCE)
    const insert = db.prepare('INSERT INTO templates (name, role, subject, body, target_role) VALUES (?, ?, ?, ?, ?)')
    for (const template of RECOVERED_EMAIL_TEMPLATES) {
      insert.run(template.name, template.role, template.subject, template.body, template.target_role)
    }
    db.prepare('INSERT INTO content_migrations (key) VALUES (?)').run(RECOVERY_MIGRATION)
  })
  seed()
  db.close()
}

export async function ensureRecoveredEmailContent() {
  await initialiseDb()
  if (isVercel) await seedPostgresContent()
  else seedSqliteContent()
}

export async function getEmailGuidance(): Promise<string> {
  await ensureRecoveredEmailContent()
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const result = await sql`SELECT content FROM email_guidance WHERE id = 1`
    return String(result.rows[0]?.content ?? DEFAULT_EMAIL_GUIDANCE)
  }
  const db = getLocalDb()
  const row = db.prepare('SELECT content FROM email_guidance WHERE id = 1').get() as { content?: string } | undefined
  db.close()
  return row?.content ?? DEFAULT_EMAIL_GUIDANCE
}

export async function updateEmailGuidance(content: string) {
  await ensureRecoveredEmailContent()
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    await sql`INSERT INTO email_guidance (id, content, updated_at) VALUES (1, ${content}, NOW()) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`
  } else {
    const db = getLocalDb()
    db.prepare("INSERT INTO email_guidance (id, content, updated_at) VALUES (1, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')").run(content)
    db.close()
  }
}

export async function getDraftEmailContent(role: string, followUp: boolean): Promise<DraftEmailContent> {
  const canonicalRole = canonicaliseEmailRole(role)
  await ensureRecoveredEmailContent()
  const templateType = followUp ? 'Follow-up' : 'Cold Outreach'

  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const guidanceResult = await sql`SELECT content FROM email_guidance WHERE id = 1`
    const templateResult = await sql`
      SELECT id, name, role, subject, body, target_role
      FROM templates
      WHERE role = ${templateType} AND (target_role = ${canonicalRole} OR target_role = '')
      ORDER BY CASE WHEN target_role = ${canonicalRole} THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `
    return {
      canonicalRole,
      guidance: String(guidanceResult.rows[0]?.content ?? DEFAULT_EMAIL_GUIDANCE),
      template: (templateResult.rows[0] as EmailTemplateContent | undefined) ?? null
    }
  }

  const db = getLocalDb()
  const guidance = db.prepare('SELECT content FROM email_guidance WHERE id = 1').get() as { content?: string } | undefined
  const template = db.prepare(`
    SELECT id, name, role, subject, body, target_role
    FROM templates
    WHERE role = ? AND (target_role = ? OR target_role = '')
    ORDER BY CASE WHEN target_role = ? THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 1
  `).get(templateType, canonicalRole, canonicalRole) as EmailTemplateContent | undefined
  db.close()
  return { canonicalRole, guidance: guidance?.content ?? DEFAULT_EMAIL_GUIDANCE, template: template ?? null }
}
