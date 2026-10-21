import { NextRequest, NextResponse } from 'next/server'
import { initialiseDb, isVercel, getLocalDb } from '@/lib/db'
import { openGmailCredentials, isAuthorizedEmail } from '@/lib/auth-policy'
import { makeEmailRaw, refreshScheduledGmailToken, sendViaGmail } from '@/lib/gmail'
import { appendPipelineRow } from '@/lib/sheets'

import { claimNext, recoverScheduledEmails, beginScheduledSend, failScheduledSend, acceptScheduledSend, type ScheduledEmail } from '@/lib/scheduled-email-store'

async function recordHistory(email: ScheduledEmail) {
  try {
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      await sql`INSERT INTO contact_history (brand_name, contact_role, contact_name, contact_email, method) VALUES (${email.brand_name}, '', ${email.contact_name}, ${email.to_email}, 'email')`
    } else {
      const db = getLocalDb()
      try { db.prepare(`INSERT INTO contact_history (brand_name, contact_role, contact_name, contact_email, method) VALUES (?, '', ?, ?, 'email')`).run(email.brand_name, email.contact_name, email.to_email) } finally { db.close() }
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

  const recovery = await recoverScheduledEmails()
  let sent = 0
  let needsReview = recovery.needs_review
  let needsReauth = 0
  for (let processed = 0; processed < 20; processed++) {
    const email = await claimNext()
    if (!email) break
    const owner = { googleSub: email.owner_google_sub, email: email.owner_email }
    const credentials = email.credential_ciphertext ? await openGmailCredentials(email.credential_ciphertext, owner) : null
    if (!credentials?.refreshToken) {
      await failScheduledSend(email, 'needs_reauth', 'credentials_unavailable')
      needsReauth++
      continue
    }
    const refresh = await refreshScheduledGmailToken(credentials.refreshToken)
    if (!refresh.accessToken) {
      await failScheduledSend(email, refresh.reauth ? 'needs_reauth' : 'pending', refresh.reauth ? 'token_refresh_rejected' : 'token_refresh_unavailable')
      if (refresh.reauth) needsReauth++
      continue
    }
    try {
      const raw = makeEmailRaw(email.to_email, email.subject, email.body, email.cc || undefined, email.bcc || undefined)
      if (!isAuthorizedEmail(email.owner_email)) {
        await failScheduledSend(email, 'needs_reauth', 'owner_not_authorized')
        needsReauth++
        continue
      }
      if (!await beginScheduledSend(email)) continue
      const messageId = await sendViaGmail(refresh.accessToken, raw)
      if (!messageId) throw new Error('missing_message_id')
      await acceptScheduledSend(email, messageId)
      sent++
      await recordHistory(email)
      await syncPipeline(email)
    } catch {
      // A failed Gmail request can be ambiguous. Never retry it automatically.
      await failScheduledSend(email, 'needs_review', 'gmail_send_ambiguous')
      needsReview++
    }
  }
  let pending = 0
  let nextDue: string | null = null
  let states: Record<string, number> = {}
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const queue = await sql`SELECT COUNT(*)::int AS pending, MIN(scheduled_at) AS next_due FROM scheduled_emails WHERE delivery_status = 'pending'`
    pending = Number(queue.rows[0]?.pending ?? 0)
    nextDue = queue.rows[0]?.next_due ? new Date(queue.rows[0].next_due as string).toISOString() : null
    const stateRows = await sql`SELECT delivery_status, COUNT(*)::int AS count FROM scheduled_emails GROUP BY delivery_status ORDER BY delivery_status`
    states = Object.fromEntries(stateRows.rows.map(row => [String(row.delivery_status ?? 'unknown'), Number(row.count)]))
  } else {
    const db = getLocalDb()
    try {
      const queue = db.prepare(`SELECT COUNT(*) AS pending, MIN(scheduled_at) AS next_due FROM scheduled_emails WHERE delivery_status = 'pending'`).get() as { pending: number; next_due: string | null }
      pending = queue.pending
      nextDue = queue.next_due ? new Date(queue.next_due).toISOString() : null
      const stateRows = db.prepare(`SELECT delivery_status, COUNT(*) AS count FROM scheduled_emails GROUP BY delivery_status ORDER BY delivery_status`).all() as { delivery_status: string | null; count: number }[]
      states = Object.fromEntries(stateRows.map(row => [row.delivery_status ?? 'unknown', Number(row.count)]))
    } finally { db.close() }
  }
  return NextResponse.json({ success: true, recovered: recovery.recovered, sent, needs_review: needsReview, needs_reauth: needsReauth, pending, next_due: nextDue, checked_at: new Date().toISOString(), database: isVercel ? 'postgres' : 'local', states })
}
