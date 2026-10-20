import { getGmailCredentials } from '@/lib/session'
import { sealGmailCredentials } from '@/lib/auth-policy'
import { appendPipelineRow } from '@/lib/sheets'
import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { classifyGmailError } from '@/lib/gmail'
import { buildHtmlEmailRaw } from '@/lib/email-mime'
import { logSafeError } from '@/lib/safe-log'

const REDIRECT_URI = process.env.PRODUCTION_URL
  ? `${process.env.PRODUCTION_URL}/api/auth/callback`
  : 'http://localhost:3000/api/auth/callback'

// Immediate sends are keyed by a request id the composer mints when the user
// confirms one specific message. It is treated as opaque; the payload hash is
// what actually binds it to the confirmed content.
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UNCERTAIN_MESSAGE = 'Gmail did not confirm this send. Check Sent mail before trying again.'
const IN_PROGRESS_MESSAGE = 'This send is in progress or its outcome was not confirmed. Check Sent mail before retrying.'

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    REDIRECT_URI
  )
}

type RefreshResult = { accessToken: string } | { error: 'reauth' | 'temporary' | 'configuration' }

async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) return { error: 'configuration' }
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GMAIL_CLIENT_ID ?? '',
        client_secret: process.env.GMAIL_CLIENT_SECRET ?? '',
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) return { error: 'temporary' }
      let reason = ''
      try { reason = String((await res.json() as { error?: unknown }).error ?? '') } catch {}
      return { error: ['invalid_client', 'unauthorized_client', 'deleted_client'].includes(reason) ? 'configuration' : 'reauth' }
    }
    const data = await res.json()
    return typeof data.access_token === 'string' && data.access_token ? { accessToken: data.access_token } : { error: 'temporary' }
  } catch {
    return { error: 'temporary' }
  }
}

function refreshFailure(result: Exclude<RefreshResult, { accessToken: string }>) {
  if (result.error === 'reauth') return NextResponse.json({ error: 'Gmail session expired — reconnect Gmail', reauth: true }, { status: 401 })
  if (result.error === 'configuration') return NextResponse.json({ error: 'Gmail is not configured correctly. Contact an administrator.' }, { status: 503 })
  return NextResponse.json({ error: 'Gmail is temporarily unavailable. Please try again later.' }, { status: 503 })
}

function sendFailure(error: unknown, outcome?: SendOutcome) {
  const kind = classifyGmailError(error)
  logSafeError('Gmail send failed', error)
  if (kind === 'auth' || kind === 'permission') {
    return NextResponse.json({ error: 'Gmail access needs to be reconnected before sending.', reauth: true, outcome: outcome ?? 'failed_auth' }, { status: 401 })
  }
  if (kind === 'policy') return NextResponse.json({ error: 'Your Google Workspace administrator has blocked Gmail access for this app.', outcome: outcome ?? 'failed' }, { status: 403 })
  if (kind === 'quota') return NextResponse.json({ error: 'Gmail has temporarily limited sending. Please try again later.', outcome: outcome ?? 'failed' }, { status: 429 })
  if (kind === 'temporary') return NextResponse.json({ error: UNCERTAIN_MESSAGE, outcome: outcome ?? 'needs_review', uncertain: true }, { status: 503 })
  return NextResponse.json({ error: UNCERTAIN_MESSAGE, outcome: outcome ?? 'needs_review', uncertain: true }, { status: 502 })
}

async function gmailSend(accessToken: string, raw: string): Promise<string> {
  const oauth2Client = getOAuthClient()
  oauth2Client.setCredentials({ access_token: accessToken })
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
  const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
  const messageId = result.data.id
  if (typeof messageId !== 'string' || !messageId) {
    // A send without a message id can never be recorded as accepted; the caller
    // treats this as an uncertain outcome that needs review, never a resend.
    throw Object.assign(new Error('Gmail did not return a message id (missing_message_id)'), { code: 'missing_message_id' })
  }
  return messageId
}

interface SendRecord {
  id: number
  status: string
  gmail_message_id: string | null
  last_error_code: string | null
}

type SendOutcome = 'accepted' | 'failed_auth' | 'failed' | 'needs_review'

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === '23505' ||
    /UNIQUE constraint failed: send_records/.test(String((error as { message?: string } | null)?.message ?? ''))
}

// Map a persisted record to the response the composer expects. A replay never
// triggers a new send; each status tells the user exactly what happened.
function recordResponse(record: SendRecord, replayed: boolean): NextResponse {
  const outcome: SendOutcome | 'uncertain' = record.status === 'accepted' ? 'accepted'
    : record.status === 'sending' || record.status === 'needs_review' ? (record.status === 'sending' ? 'uncertain' : 'needs_review')
    : record.status === 'failed_auth' ? 'failed_auth'
    : 'failed'
  if (outcome === 'accepted') {
    return NextResponse.json({
      success: true,
      outcome,
      message_id: record.gmail_message_id,
      replayed,
    })
  }
  if (outcome === 'failed_auth') {
    return NextResponse.json({ error: 'Gmail access needs to be reconnected before sending.', reauth: true, outcome, replayed }, { status: 401 })
  }
  if (outcome === 'uncertain') {
    return NextResponse.json({ success: false, outcome, uncertain: true, error: IN_PROGRESS_MESSAGE, replayed }, { status: 409 })
  }
  // needs_review / failed: the recorded uncertainty or failure replays verbatim.
  return NextResponse.json({ success: false, outcome, replayed, error: UNCERTAIN_MESSAGE }, { status: 502 })
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  const session = auth.session

  try {
    const body = await request.json()
    if (body.expectedGoogleSub !== session.googleSub) {
      return NextResponse.json({ error: 'Your Google account changed. Reload and review the draft before sending.' }, { status: 409 })
    }

    // Validate everything before creating any durable record or contacting Gmail.
    const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : ''
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      // Fail closed for cached clients: without a request id there is no safe
      // replay identity, so the composer must refresh and confirm again.
      return NextResponse.json({ error: 'Your session is out of date. Refresh the page and confirm the send again.' }, { status: 400 })
    }

    const credentials = await getGmailCredentials(session)
    let accessToken = credentials?.accessToken
    const refreshToken = credentials?.refreshToken

    if (!accessToken && !refreshToken) {
      return NextResponse.json(
        { error: 'Not authenticated — authorise Gmail first', reauth: true },
        { status: 401 }
      )
    }

    const { to, cc, bcc, subject, emailBody, contactName, leadSource, attachments } = body

    if (!to || !subject || !emailBody) {
      return NextResponse.json(
        { error: 'to, subject, and emailBody are required' },
        { status: 400 }
      )
    }

    if (typeof subject !== 'string' || typeof emailBody !== 'string' ||
      (attachments !== undefined && (!Array.isArray(attachments) || attachments.some(att => !att || typeof att.name !== 'string' || typeof att.data !== 'string' || typeof att.type !== 'string')))) {
      return NextResponse.json({ error: 'Invalid message fields' }, { status: 400 })
    }
    if ([to, cc, bcc].some(value => value !== undefined && (typeof value !== 'string' || /[\r\n]/.test(value))) ||
      (Array.isArray(attachments) && attachments.some(att => typeof att.type !== 'string' || /[\r\n]/.test(att.type)))) {
      return NextResponse.json({ error: 'Invalid message headers' }, { status: 400 })
    }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 4 * 1024 * 1024) {
      return NextResponse.json({ error: 'Message and attachments exceed the upload limit' }, { status: 413 })
    }
    const recipients = [to, cc, bcc].filter(Boolean).flatMap(value => value.split(',').map((address: string) => address.trim()).filter(Boolean))
    if (!to.split(',').some((address: string) => address.trim()) || recipients.length > 20 || recipients.some(address => !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address)) ||
      (attachments ?? []).some((att: { type: string; data: string }) => !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(att.type) || !/^[A-Za-z0-9+/]*={0,2}$/.test(att.data) || att.data.length % 4 !== 0)) {
      return NextResponse.json({ error: 'Invalid recipients or attachment format' }, { status: 400 })
    }

    // Hash exactly the confirmed outbound content, including attachments.
    const payloadHash = await sha256Hex(JSON.stringify({
      to, cc: cc ?? '', bcc: bcc ?? '', subject, emailBody, attachments: attachments ?? [],
    }))

    const { isVercel, initialiseDb, getLocalDb } = await import('@/lib/db')
    await initialiseDb()

    async function loadRecord(): Promise<SendRecord | null> {
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        const result = await sql`
          SELECT id, status, gmail_message_id, last_error_code FROM send_records
          WHERE owner_google_sub = ${session.googleSub} AND request_id = ${requestId}`
        return (result.rows[0] as unknown as SendRecord | undefined) ?? null
      }
      const db = getLocalDb()
      try {
        return (db.prepare('SELECT id, status, gmail_message_id, last_error_code FROM send_records WHERE owner_google_sub = ? AND request_id = ?').get(session.googleSub, requestId) as SendRecord | undefined) ?? null
      } finally {
        db.close()
      }
    }

    // Durable record first. If this write fails, Gmail is never contacted.
    // The request id is globally unique: a replay from another account can never
    // silently send its own copy to the same recipient.
    async function replayAfterConflict(): Promise<NextResponse | null> {
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        const rows = await sql`
          SELECT id, status, gmail_message_id, last_error_code, payload_hash, owner_google_sub FROM send_records
          WHERE request_id = ${requestId}`
        const existing = rows.rows[0] as (SendRecord & { payload_hash: string; owner_google_sub: string }) | undefined
        if (!existing || existing.owner_google_sub !== session.googleSub) {
          return NextResponse.json({ error: 'This request id was already used by another session. Refresh and confirm again as a new send.' }, { status: 409 })
        }
        if (existing.payload_hash !== payloadHash) {
          return NextResponse.json({ error: 'This request id was already used for a different email. Refresh and confirm again as a new send.' }, { status: 409 })
        }
        if (existing.status !== 'recorded') return recordResponse(existing, true)
        const claim = await sql`
          UPDATE send_records SET status = 'sending', updated_at = NOW()
          WHERE id = ${existing.id} AND owner_google_sub = ${session.googleSub} AND status = 'recorded'
          RETURNING id`
        if ((claim.rowCount ?? 0) === 0) {
          const current = await loadRecord()
          if (current) return recordResponse(current, true)
          return NextResponse.json({ success: false, outcome: 'uncertain', uncertain: true, error: IN_PROGRESS_MESSAGE }, { status: 409 })
        }
        return null
      }
      const db = getLocalDb()
      try {
        const existing = db.prepare('SELECT id, status, gmail_message_id, last_error_code, payload_hash, owner_google_sub FROM send_records WHERE request_id = ?').get(requestId) as (SendRecord & { payload_hash: string; owner_google_sub: string }) | undefined
        if (!existing || existing.owner_google_sub !== session.googleSub) {
          return NextResponse.json({ error: 'This request id was already used by another session. Refresh and confirm again as a new send.' }, { status: 409 })
        }
        if (existing.payload_hash !== payloadHash) {
          return NextResponse.json({ error: 'This request id was already used for a different email. Refresh and confirm again as a new send.' }, { status: 409 })
        }
        if (existing.status !== 'recorded') return recordResponse(existing, true)
        const claimed = db.prepare(`UPDATE send_records SET status = 'sending', updated_at = datetime('now')
          WHERE id = ? AND owner_google_sub = ? AND status = 'recorded'`).run(existing.id, session.googleSub)
        if (claimed.changes === 0) {
          const current = db.prepare('SELECT id, status, gmail_message_id, last_error_code FROM send_records WHERE id = ? AND owner_google_sub = ?').get(existing.id, session.googleSub) as SendRecord | undefined
          if (current) return recordResponse(current, true)
          return NextResponse.json({ success: false, outcome: 'uncertain', uncertain: true, error: IN_PROGRESS_MESSAGE }, { status: 409 })
        }
        return null
      } finally {
        db.close()
      }
    }

    try {
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        const inserted = await sql`
          INSERT INTO send_records (owner_google_sub, owner_email, request_id, payload_hash, status)
          VALUES (${session.googleSub}, ${session.email}, ${requestId}, ${payloadHash}, 'recorded')
          ON CONFLICT (request_id) DO NOTHING
          RETURNING id`
        if ((inserted.rowCount ?? 0) === 0) {
          const replay = await replayAfterConflict()
          if (replay) return replay
        } else {
          // Claim the record before Gmail. If another request claimed first, this
          // one becomes a replay instead of a second send.
          const claim = await sql`
            UPDATE send_records SET status = 'sending', updated_at = NOW()
            WHERE request_id = ${requestId} AND owner_google_sub = ${session.googleSub} AND status = 'recorded'
            RETURNING id`
          if ((claim.rowCount ?? 0) === 0) {
            const replay = await replayAfterConflict()
            if (replay) return replay
          }
        }
      } else {
        const db = getLocalDb()
        try {
          db.prepare(`INSERT INTO send_records (owner_google_sub, owner_email, request_id, payload_hash, status)
            VALUES (?, ?, ?, ?, 'recorded')`).run(session.googleSub, session.email, requestId, payloadHash)
          // Claim the record before Gmail. If another request claimed first, this
          // one becomes a replay instead of a second send.
          const claimed = db.prepare(`UPDATE send_records SET status = 'sending', updated_at = datetime('now')
            WHERE request_id = ? AND owner_google_sub = ? AND status = 'recorded'`).run(requestId, session.googleSub)
          if (claimed.changes === 0) {
            const replay = await replayAfterConflict()
            if (replay) return replay
          }
        } catch (insertError) {
          if (!isUniqueViolation(insertError)) throw insertError
          const replay = await replayAfterConflict()
          if (replay) return replay
        } finally {
          db.close()
        }
      }
    } catch (recordError) {
      // A database failure before Gmail means no send attempt was made.
      logSafeError('Send record persistence failed before Gmail', recordError)
      return NextResponse.json({ error: 'Could not start this send. Try again in a moment.' }, { status: 503 })
    }

    const recordRow = await loadRecord()
    const recordId = recordRow?.id
    if (!recordId) {
      return NextResponse.json({ error: 'Send record unavailable. Refresh and confirm the send again.' }, { status: 503 })
    }

    async function finishOutcome(status: SendOutcome, messageId: string | null, errorCode: string | null): Promise<void> {
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        await sql`UPDATE send_records
          SET status = ${status},
              gmail_message_id = ${messageId},
              last_error_code = ${errorCode},
              last_error = ${errorCode ?? null},
              accepted_at = ${status === 'accepted' ? new Date().toISOString() : null},
              updated_at = NOW()
          WHERE id = ${recordId} AND owner_google_sub = ${session.googleSub}`
      } else {
        const db = getLocalDb()
        try {
          db.prepare(`UPDATE send_records
            SET status = ?, gmail_message_id = ?, last_error_code = ?, last_error = ?,
                accepted_at = CASE WHEN ? = 'accepted' THEN datetime('now') ELSE NULL END,
                updated_at = datetime('now')
            WHERE id = ? AND owner_google_sub = ?`)
            .run(status, messageId, errorCode, errorCode, status, recordId, session.googleSub)
        } finally {
          db.close()
        }
      }
    }

    const raw = buildHtmlEmailRaw(to, subject, emailBody, cc, bcc, attachments)
    let newAccessToken: string | null = null

    // If no access token but refresh token exists, refresh before first attempt
    if (!accessToken) {
      const refreshed = await refreshAccessToken(refreshToken!)
      if ('error' in refreshed) {
        await finishOutcome('failed_auth', null, 'token_refresh_' + refreshed.error)
        return refreshFailure(refreshed)
      }
      newAccessToken = refreshed.accessToken
      accessToken = refreshed.accessToken
    }

    let messageId: string
    try {
      messageId = await gmailSend(accessToken, raw)
    } catch (sendError) {
      if (classifyGmailError(sendError) === 'auth' && refreshToken) {
        // Token expired mid-session — refresh and retry once
        const refreshed = await refreshAccessToken(refreshToken)
        if ('error' in refreshed) {
          await finishOutcome('failed_auth', null, 'token_refresh_' + refreshed.error)
          return refreshFailure(refreshed)
        }
        newAccessToken = refreshed.accessToken
        try {
          messageId = await gmailSend(newAccessToken, raw)
        } catch (retryError) {
          const kind = classifyGmailError(retryError)
          const status: SendOutcome = kind === 'auth' || kind === 'permission' ? 'failed_auth' : 'failed'
          await finishOutcome(status, null, kind)
          return sendFailure(retryError, status)
        }
      } else {
        const kind = classifyGmailError(sendError)
        const status: SendOutcome = kind === 'auth' || kind === 'permission' ? 'failed_auth' : kind === 'quota' || kind === 'policy' ? 'failed' : 'needs_review'
        await finishOutcome(status, null, kind)
        return sendFailure(sendError, status)
      }
    }

    // Gmail accepted. The outcome write must never fail silently into a resend:
    // retry once, then fall back to needs_review. If even that write fails the
    // record remains 'sending', whose replay reports the uncertainty and asks the
    // user to check Sent mail — a stuck record can never cause a second send.
    try {
      await finishOutcome('accepted', messageId, null)
    } catch (outcomeError) {
      logSafeError('Send outcome persistence failed after Gmail acceptance', outcomeError)
      try {
        await finishOutcome('accepted', messageId, null)
      } catch (retryError) {
        logSafeError('Send outcome persistence retry failed after Gmail acceptance', retryError)
        try {
          await finishOutcome('needs_review', messageId, 'outcome_write_lost')
        } catch (fallbackError) {
          logSafeError('Send outcome needs_review fallback failed after Gmail acceptance', fallbackError)
        }
      }
      return NextResponse.json({
        success: true,
        outcome: 'needs_review',
        uncertain: true,
        message_id: messageId,
        error: IN_PROGRESS_MESSAGE,
      })
    }

    const dossier = body.dossier
    let pipelineSynced: boolean | null = null
    if (dossier) {
      pipelineSynced = false
      try {
        await appendPipelineRow({
            brand_name: dossier.brand_name,
            website: dossier.website,
            lead_source: leadSource ?? 'Outbound',
            revenue_estimate: dossier.revenue_estimate,
            retailers: dossier.retailers,
            category: dossier.category,
            icp_score: dossier.icp_score,
            score_band: dossier.score_band,
            signals: dossier.signals,
            target_role: body.role,
            contact_name: contactName,
            email_subject: subject,
            email_body: emailBody,
            status: 'Sent',
            sent_by: session.email
        })
        pipelineSynced = true
      } catch {
        console.error('Sheets sync failed')
      }
    }

    try {
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        await sql`
          INSERT INTO contact_history (brand_name, contact_role, contact_name, contact_email, method)
          VALUES (${dossier?.brand_name ?? ''}, ${body.role ?? ''}, ${contactName}, ${to}, 'email')
        `
      } else {
        const db = getLocalDb()
        db.prepare('INSERT INTO contact_history (brand_name, contact_role, contact_name, contact_email, method) VALUES (?, ?, ?, ?, ?)').run(dossier?.brand_name ?? '', body.role ?? '', contactName, to, 'email')
      }
    } catch {
      console.error('Failed to log contact history')
    }

    const response = NextResponse.json({
      success: true,
      outcome: 'accepted' as const,
      message_id: messageId,
      to,
      contact_name: contactName,
      pipeline_synced: pipelineSynced
    })

    // Persist the refreshed token so subsequent requests don't need to refresh again
    if (newAccessToken) {
      try {
        response.cookies.set('atelier_gmail', await sealGmailCredentials({ ...credentials!, accessToken: newAccessToken }), {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 60 * 60 * 24 * 30,
          path: '/',
        })
      } catch (error) {
        // Gmail already accepted the message. Never turn this into a send failure.
        logSafeError('Gmail credential persistence failed after send', error)
      }
    }

    return response

  } catch (error: unknown) {
    logSafeError('Send email request failed', error)
    return NextResponse.json({ error: 'The email request could not be completed. Please try again.' }, { status: 500 })
  }
}
