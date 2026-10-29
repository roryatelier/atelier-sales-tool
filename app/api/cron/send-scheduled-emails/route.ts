import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

function cronSecretMatches(presented: string | null, secret: string): boolean {
  const a = Buffer.from(presented ?? '')
  const b = Buffer.from(`Bearer ${secret}`)
  return a.length === b.length && timingSafeEqual(a, b)
}
import { initialiseDb, isVercel, getLocalDb } from '@/lib/db'
import { openGmailCredentials, isAuthorizedEmail } from '@/lib/auth-policy'
import { makeEmailRaw, refreshScheduledGmailToken, sendViaGmail } from '@/lib/gmail'
import { pipelineSnapshot, preparePipelineExport, syncPipelineSource, processPipelineExports } from '@/lib/outreach-outbox'

import { claimNext, recoverScheduledEmails, beginScheduledSend, failScheduledSend, acceptScheduledSend, recordAcceptedMessageId, type ScheduledEmail } from '@/lib/scheduled-email-store'
import { logSafeError } from '@/lib/safe-log'
import { sweepAbandonedSends } from '@/lib/send-sweeper'

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

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || !cronSecretMatches(request.headers.get('authorization'), secret)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { await initialiseDb() } catch { return NextResponse.json({ error: 'Database unavailable' }, { status: 503 }) }

  const recovery = await recoverScheduledEmails()
  const deadline = Date.now() + 60_000
  try { await processPipelineExports(1) } catch { console.error('Pipeline export worker unavailable') }
  // Move immediate sends whose outcome was never written to visible review. The
  // sweeper never sends and never returns a row to 'recorded'.
  try { await sweepAbandonedSends({ initialise: false }) } catch (sweepError) { logSafeError('Send sweeper unavailable', sweepError) }
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) return NextResponse.json({ error: 'Gmail configuration unavailable' }, { status: 503 })
  let sent = 0
  let needsReview = recovery.needs_review
  let needsReauth = 0
  for (let processed = 0; processed < 20 && Date.now() + 30_000 < deadline; processed++) {
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
    let sendStarted = false
    // Declared at loop level so the outcome handler can see whether Gmail
    // returned an id for this attempt.
    let messageId: string | null = null
    let threadId: string | null = null
    try {
      const raw = makeEmailRaw(email.to_email, email.subject, email.body, email.cc || undefined, email.bcc || undefined)
      if (!isAuthorizedEmail(email.owner_email)) {
        await failScheduledSend(email, 'needs_reauth', 'owner_not_authorized')
        needsReauth++
        continue
      }
      await preparePipelineExport('scheduled', email.id, email.owner_google_sub, pipelineSnapshot({
        ...(email.dossier_json ? JSON.parse(email.dossier_json) : {}), brand_name: email.brand_name,
        to_email: email.to_email, lead_source: 'Scheduled', contact_name: email.contact_name,
        email_subject: email.subject, email_body: email.body, sent_by: email.owner_email,
      }))
      if (Date.now() + 15_000 >= deadline) {
        await failScheduledSend(email, 'pending', 'worker_budget_exhausted')
        continue
      }
      if (!await beginScheduledSend(email)) continue
      sendStarted = true
      try {
        const sent = await sendViaGmail(refresh.accessToken, raw)
        messageId = sent.id
        threadId = sent.threadId
        if (!messageId) throw new Error('missing_message_id')
        await acceptScheduledSend(email, messageId, threadId ?? undefined)
      } catch (acceptanceError) {
        // Gmail may have accepted this attempt even though acceptance could not be
        // recorded. Persist the id and queue the export before anything else, so
        // review never turns into a hand resend and the outbox row is not lost.
        if (messageId) {
          try { await recordAcceptedMessageId(email, messageId, threadId ?? undefined) } catch (recordError) { console.error('SCHEDULED SEND ID PRESERVATION FAILED — the Gmail message id could not be recorded; review before any resend.', recordError) }
        }
        throw acceptanceError
      }
      sent++
      await recordHistory(email)
      try { await syncPipelineSource(`scheduled:${email.id}`, email.owner_google_sub) } catch { console.error('Scheduled pipeline export pending') }
    } catch (workerError) {
      if (!sendStarted) {
        console.error('Scheduled send preparation failed', workerError)
        await failScheduledSend(email, 'pending', 'preparation_failed')
        continue
      }
      // A failed Gmail request can be ambiguous. Never retry it automatically.
      // With a Gmail id in hand the more specific preservation code must survive;
      // only a truly ambiguous outcome takes the generic code.
      if (messageId) { await failScheduledSend(email, 'needs_review', 'acceptance_write_lost', true) } else { await failScheduledSend(email, 'needs_review', 'gmail_send_ambiguous') }
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
