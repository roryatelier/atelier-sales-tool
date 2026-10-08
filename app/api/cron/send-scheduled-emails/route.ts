import { NextRequest, NextResponse } from 'next/server'
import { initialiseDb, isVercel, getLocalDb } from '@/lib/db'
import { openGmailCredentials } from '@/lib/auth-policy'
import { makeEmailRaw, refreshGmailToken, sendViaGmail } from '@/lib/gmail'
import { appendPipelineRow } from '@/lib/sheets'

interface ScheduledEmail {
  id: number
  to_email: string
  cc: string
  bcc: string
  subject: string
  body: string
  brand_name: string
  contact_name: string
  owner_google_sub: string
  owner_email: string
  credential_ciphertext: string
  dossier_json: string
}

async function claimNext(): Promise<ScheduledEmail | null> {
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const result = await sql`WITH candidate AS (
      SELECT id FROM scheduled_emails
      WHERE delivery_status = 'pending' AND scheduled_at <= NOW()
      ORDER BY scheduled_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE scheduled_emails AS job
      SET delivery_status = 'sending', claimed_at = NOW(), attempt_count = COALESCE(attempt_count, 0) + 1
      FROM candidate WHERE job.id = candidate.id
      RETURNING job.*`
    return (result.rows[0] as unknown as ScheduledEmail | undefined) ?? null
  }
  const db = getLocalDb()
  const claim = db.transaction(() => {
    const row = db.prepare(`SELECT * FROM scheduled_emails WHERE delivery_status = 'pending' AND scheduled_at <= datetime('now') ORDER BY scheduled_at ASC LIMIT 1`).get() as ScheduledEmail | undefined
    if (!row) return null
    const updated = db.prepare(`UPDATE scheduled_emails SET delivery_status = 'sending', claimed_at = datetime('now'), attempt_count = COALESCE(attempt_count, 0) + 1 WHERE id = ? AND delivery_status = 'pending'`).run(row.id)
    return updated.changes === 1 ? row : null
  })
  return claim()
}

async function setFailure(id: number, status: 'needs_reauth' | 'needs_review', code: string) {
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    await sql`UPDATE scheduled_emails SET delivery_status = ${status}, last_error_code = ${code} WHERE id = ${id} AND delivery_status = 'sending'`
  } else {
    getLocalDb().prepare(`UPDATE scheduled_emails SET delivery_status = ?, last_error_code = ? WHERE id = ? AND delivery_status = 'sending'`).run(status, code, id)
  }
}

async function setSent(id: number, messageId: string) {
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    await sql`UPDATE scheduled_emails SET delivery_status = 'sent', sent = true, sent_at = NOW(), gmail_message_id = ${messageId}, last_error_code = NULL WHERE id = ${id} AND delivery_status = 'sending'`
  } else {
    getLocalDb().prepare(`UPDATE scheduled_emails SET delivery_status = 'sent', sent = 1, sent_at = datetime('now'), gmail_message_id = ?, last_error_code = NULL WHERE id = ? AND delivery_status = 'sending'`).run(messageId, id)
  }
}

async function recordHistory(email: ScheduledEmail) {
  try {
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      await sql`INSERT INTO contact_history (brand_name, contact_role, contact_name, contact_email, method) VALUES (${email.brand_name}, '', ${email.contact_name}, ${email.to_email}, 'email')`
    } else {
      getLocalDb().prepare(`INSERT INTO contact_history (brand_name, contact_role, contact_name, contact_email, method) VALUES (?, '', ?, ?, 'email')`).run(email.brand_name, email.contact_name, email.to_email)
    }
  } catch { console.error('Scheduled contact history sync failed') }
}

async function syncPipeline(email: ScheduledEmail) {
  if (!email.brand_name) return
  try {
    const dossier = email.dossier_json ? JSON.parse(email.dossier_json) : {}
    await appendPipelineRow({
      brand_name: email.brand_name,
      website: dossier.website,
      lead_source: 'Scheduled',
      revenue_estimate: dossier.revenue_estimate,
      retailers: dossier.retailers,
      category: dossier.category,
      icp_score: dossier.icp_score,
      score_band: dossier.score_band,
      signals: dossier.signals,
      target_role: dossier.target_role,
      contact_name: email.contact_name,
      email_subject: email.subject,
      email_body: email.body,
      status: 'Sent',
      sent_by: email.owner_email,
    })
  } catch { console.error('Scheduled pipeline sync failed') }
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) return NextResponse.json({ error: 'Gmail configuration unavailable' }, { status: 503 })
  try { await initialiseDb() } catch { return NextResponse.json({ error: 'Database unavailable' }, { status: 503 }) }

  let sent = 0
  let needsReview = 0
  let needsReauth = 0
  for (let processed = 0; processed < 20; processed++) {
    const email = await claimNext()
    if (!email) break
    const owner = { googleSub: email.owner_google_sub, email: email.owner_email }
    const credentials = email.credential_ciphertext ? await openGmailCredentials(email.credential_ciphertext, owner) : null
    if (!credentials?.refreshToken) {
      await setFailure(email.id, 'needs_reauth', 'credentials_unavailable')
      needsReauth++
      continue
    }
    const accessToken = await refreshGmailToken(credentials.refreshToken)
    if (!accessToken) {
      await setFailure(email.id, 'needs_reauth', 'token_refresh_failed')
      needsReauth++
      continue
    }
    try {
      const raw = makeEmailRaw(email.to_email, email.subject, email.body, email.cc || undefined, email.bcc || undefined)
      const messageId = await sendViaGmail(accessToken, raw)
      if (!messageId) throw new Error('missing_message_id')
      await setSent(email.id, messageId)
      sent++
      await recordHistory(email)
      await syncPipeline(email)
    } catch {
      // A failed Gmail request can be ambiguous. Never retry it automatically.
      await setFailure(email.id, 'needs_review', 'gmail_send_ambiguous')
      needsReview++
    }
  }
  return NextResponse.json({ success: true, sent, needs_review: needsReview, needs_reauth: needsReauth })
}
