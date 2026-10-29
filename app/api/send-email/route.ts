import { getGmailCredentials } from '@/lib/session'
import { sealGmailCredentials } from '@/lib/auth-policy'
import { pipelineSnapshot, syncPipelineSource, sourceExportStatus } from '@/lib/outreach-outbox'
import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'
import { classifyGmailError, sendViaGmail, type GmailErrorKind } from '@/lib/gmail'
import { buildHtmlEmailRaw } from '@/lib/email-mime'
import { logSafeError } from '@/lib/safe-log'
import { initialiseDb } from '@/lib/db'

// Immediate sends are keyed by a request id the composer mints when the user
// confirms one specific message. It is treated as opaque; the payload hash is
// what actually binds it to the confirmed content.
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UNCERTAIN_MESSAGE = 'Gmail did not confirm this send. Check Sent mail before trying again.'
const IN_PROGRESS_MESSAGE = 'This send is in progress or its outcome was not confirmed. Check Sent mail before retrying.'
const QUOTA_MESSAGE = 'Gmail has temporarily limited sending. Please try again later.'
const POLICY_MESSAGE = 'Your Google Workspace administrator has blocked Gmail access for this app.'
const REAUTH_MESSAGE = 'Gmail access needs to be reconnected before sending.'
const ACCEPTED_WRITE_BACKOFF_MS = 25

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
  if (result.error === 'reauth') return NextResponse.json({ error: 'Gmail session expired — reconnect Gmail', reauth: true, outcome: 'failed_auth' }, { status: 401 })
  if (result.error === 'configuration') return NextResponse.json({ error: 'Gmail is not configured correctly. Contact an administrator.' }, { status: 503 })
  return NextResponse.json({ error: 'Gmail is temporarily unavailable. Please try again later.' }, { status: 503 })
}

interface SendRecord {
  id: number
  status: string
  gmail_message_id: string | null
  last_error_code: string | null
}

type SendOutcome = 'accepted' | 'failed_auth' | 'failed' | 'needs_review'

// One classification for the first Gmail attempt and the post-refresh retry.
// quota and policy are definite non-deliveries. auth and permission are definite
// rejections. Everything else, including a missing message id, a 5xx, a network
// error, a bare 400, and a 403 whose reason we do not recognise, stays
// needs_review: those responses do not prove the message was refused, so they
// must not become a status the user can retry as a new send.
function outcomeFor(kind: GmailErrorKind): SendOutcome {
  if (kind === 'auth' || kind === 'permission') return 'failed_auth'
  if (kind === 'quota' || kind === 'policy') return 'failed'
  return 'needs_review'
}

function sendFailure(error: unknown, outcome?: SendOutcome) {
  const kind = classifyGmailError(error)
  logSafeError('Gmail send failed', error)
  const recorded = outcome ?? outcomeFor(kind)
  if (kind === 'auth' || kind === 'permission') {
    return NextResponse.json({ error: REAUTH_MESSAGE, reauth: true, outcome: recorded }, { status: 401 })
  }
  if (kind === 'policy') return NextResponse.json({ error: POLICY_MESSAGE, outcome: recorded }, { status: 403 })
  if (kind === 'quota') return NextResponse.json({ error: QUOTA_MESSAGE, outcome: recorded }, { status: 429 })
  if (kind === 'temporary') return NextResponse.json({ error: UNCERTAIN_MESSAGE, outcome: recorded, uncertain: true }, { status: 503 })
  return NextResponse.json({ error: UNCERTAIN_MESSAGE, outcome: recorded, uncertain: true }, { status: 502 })
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === '23505' ||
    /UNIQUE constraint failed: send_records/.test(String((error as { message?: string } | null)?.message ?? ''))
}

function hasMessageId(record: SendRecord): boolean {
  return typeof record.gmail_message_id === 'string' && record.gmail_message_id.length > 0
}

// Map a persisted record to the response the composer expects. A replay never
// triggers a new send. Definite failures keep their original status, and a row
// that already has a Gmail message id is reported as sent.
async function recordResponse(record: SendRecord, replayed: boolean, owner: string): Promise<NextResponse> {
  if (record.status === 'accepted' || hasMessageId(record)) {
    const outcome = record.status === 'accepted' ? 'accepted' : 'needs_review'
    let pipelineSynced: boolean | null = null
    try {
      const syncStatus = await sourceExportStatus(`immediate:${record.id}`, owner)
      pipelineSynced = syncStatus === null ? null : syncStatus === 'synced'
    } catch {}
    return NextResponse.json({
      success: true,
      outcome,
      message_id: record.gmail_message_id,
      replayed,
      pipeline_synced: pipelineSynced,
    })
  }
  switch (record.status) {
    case 'failed_auth':
      return NextResponse.json({ error: REAUTH_MESSAGE, reauth: true, outcome: 'failed_auth', replayed }, { status: 401 })
    case 'failed':
      if (record.last_error_code === 'quota') {
        return NextResponse.json({ error: QUOTA_MESSAGE, outcome: 'failed', replayed }, { status: 429 })
      }
      if (record.last_error_code === 'policy') {
        return NextResponse.json({ error: POLICY_MESSAGE, outcome: 'failed', replayed }, { status: 403 })
      }
      return NextResponse.json({ success: false, outcome: 'needs_review', uncertain: true, error: UNCERTAIN_MESSAGE, replayed }, { status: 502 })
    case 'needs_review':
      return NextResponse.json({ success: false, outcome: 'needs_review', uncertain: true, error: UNCERTAIN_MESSAGE, replayed }, { status: 502 })
    case 'sending':
    case 'recorded':
    default:
      return NextResponse.json({ success: false, outcome: 'uncertain', uncertain: true, error: IN_PROGRESS_MESSAGE, replayed }, { status: 409 })
  }
}

type ClaimFollowUp =
  | { action: 'respond'; response: NextResponse }
  | { action: 'send'; recordId: number }

// Stored timestamps are UTC, but both drivers return them without a zone.
// A browser would otherwise read that text as local time.
function utcTimestamp(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
  const parsed = new Date(zoned ? trimmed : `${trimmed.replace(' ', 'T')}Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function publicSend(row: Record<string, unknown>) {
  return {
    id: row.id,
    request_id: row.request_id,
    status: row.status,
    last_error_code: row.last_error_code ?? null,
    gmail_message_id: row.gmail_message_id ?? null,
    created_at: utcTimestamp(row.created_at),
    updated_at: utcTimestamp(row.updated_at),
  }
}

export async function GET(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  const session = auth.session
  // Owner-scoped status list: lets the owner see uncertain or interrupted sends
  // without the browser tab that started them. No message bodies, no recipients,
  // no payload contents — identification is by request id and outcome.
  const { isVercel, getLocalDb } = await import('@/lib/db')
  await initialiseDb()
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const result = await sql`SELECT id, request_id, status, last_error_code, gmail_message_id, created_at::text AS created_at, updated_at::text AS updated_at
      FROM send_records WHERE owner_google_sub = ${session.googleSub} AND status IN ('needs_review', 'sending') ORDER BY updated_at DESC LIMIT 20`
    return NextResponse.json({ sends: result.rows.map(row => publicSend(row as Record<string, unknown>)), owner_google_sub: session.googleSub })
  }
  const db = getLocalDb()
  try {
    const rows = db.prepare(`SELECT id, request_id, status, last_error_code, gmail_message_id, created_at, updated_at
      FROM send_records WHERE owner_google_sub = ? AND status IN ('needs_review', 'sending') ORDER BY updated_at DESC LIMIT 20`).all(session.googleSub) as Record<string, unknown>[]
    return NextResponse.json({ sends: rows.map(publicSend), owner_google_sub: session.googleSub })
  } finally {
    db.close()
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  const session = auth.session

  let gmailAttempted = false
  // Set only after Gmail returns a message id, so an unexpected failure later
  // can still name that id instead of looking like a send that never happened.
  let acceptedMessageId: string | null = null
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

    // Freeze export data in the initial record, before acquiring any send claim.
    // A database outage here can never strand an unattempted message as sending.
    const pipelinePayload = body.dossier ? pipelineSnapshot({
      ...body.dossier, to_email: to, lead_source: leadSource ?? 'Outbound', target_role: body.role ?? '',
      contact_name: contactName ?? '', email_subject: subject, email_body: emailBody, sent_by: session.email,
    }) : null

    const { isVercel, initialiseDb, getLocalDb } = await import('@/lib/db')
    try {
      await initialiseDb()
    } catch (error) {
      logSafeError('Send record schema initialisation failed', error)
      return NextResponse.json({ error: 'Could not start this send. Try again in a moment.' }, { status: 503 })
    }

    async function loadRecordById(id: number): Promise<SendRecord | null> {
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        const result = await sql`
          SELECT id, status, gmail_message_id, last_error_code FROM send_records
          WHERE id = ${id} AND owner_google_sub = ${session.googleSub}`
        return (result.rows[0] as unknown as SendRecord | undefined) ?? null
      }
      const db = getLocalDb()
      try {
        return (db.prepare('SELECT id, status, gmail_message_id, last_error_code FROM send_records WHERE id = ? AND owner_google_sub = ?').get(id, session.googleSub) as SendRecord | undefined) ?? null
      } finally {
        db.close()
      }
    }

    async function releaseClaim(id: number): Promise<number> {
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        const result = await sql`
          UPDATE send_records
          SET status = 'recorded', last_error_code = NULL, last_error = NULL, updated_at = NOW()
          WHERE id = ${id} AND owner_google_sub = ${session.googleSub} AND status = 'sending'
          RETURNING id`
        return result.rowCount ?? result.rows.length
      }
      const db = getLocalDb()
      try {
        const result = db.prepare(`UPDATE send_records
          SET status = 'recorded', last_error_code = NULL, last_error = NULL, updated_at = datetime('now')
          WHERE id = ? AND owner_google_sub = ? AND status = 'sending'`).run(id, session.googleSub)
        return result.changes
      } finally {
        db.close()
      }
    }

    async function releaseByRequestId(): Promise<void> {
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        await sql`
          UPDATE send_records
          SET status = 'recorded', last_error_code = NULL, last_error = NULL, updated_at = NOW()
          WHERE request_id = ${requestId} AND owner_google_sub = ${session.googleSub} AND status = 'sending'`
        return
      }
      const db = getLocalDb()
      try {
        db.prepare(`UPDATE send_records
          SET status = 'recorded', last_error_code = NULL, last_error = NULL, updated_at = datetime('now')
          WHERE request_id = ? AND owner_google_sub = ? AND status = 'sending'`).run(requestId, session.googleSub)
      } finally {
        db.close()
      }
    }

    // Moves a claimed row out of 'sending'. Throws unless exactly one sending
    // row was updated, so a lost response can be retried instead of treated as
    // recorded, and a later write cannot overwrite an accepted row.
    async function finishOutcome(status: SendOutcome, messageId: string | null, errorCode: string | null, id: number): Promise<void> {
      let updated = 0
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        const result = await sql`
          UPDATE send_records
          SET status = ${status},
              gmail_message_id = ${messageId},
              last_error_code = ${errorCode},
              last_error = ${errorCode},
              accepted_at = CASE WHEN ${status} = 'accepted' THEN NOW() ELSE NULL END,
              updated_at = NOW()
          WHERE id = ${id} AND owner_google_sub = ${session.googleSub} AND status = 'sending'
          RETURNING id`
        updated = result.rowCount ?? result.rows.length
      } else {
        const db = getLocalDb()
        try {
          const result = db.prepare(`UPDATE send_records
            SET status = ?, gmail_message_id = ?, last_error_code = ?, last_error = ?,
                accepted_at = CASE WHEN ? = 'accepted' THEN datetime('now') ELSE NULL END,
                updated_at = datetime('now')
            WHERE id = ? AND owner_google_sub = ? AND status = 'sending'`)
            .run(status, messageId, errorCode, errorCode, status, id, session.googleSub)
          updated = result.changes
        } finally {
          db.close()
        }
      }
      if (updated !== 1) throw new Error('send outcome write did not update the sending row')
    }

    async function recordTerminal(id: number, status: SendOutcome, errorCode: string, response: NextResponse): Promise<NextResponse> {
      try {
        await finishOutcome(status, null, errorCode, id)
      } catch (error) {
        logSafeError('Send outcome write failed', error)
      }
      return response
    }

    // Token refresh failed before Gmail accepted anything. A real reauth burns
    // the id. A temporary or configuration failure releases the claim so the
    // same confirmation can try again without a second send.
    async function respondToRefreshFailure(id: number, result: Exclude<RefreshResult, { accessToken: string }>): Promise<NextResponse> {
      const response = refreshFailure(result)
      if (result.error === 'reauth') return recordTerminal(id, 'failed_auth', 'token_refresh_reauth', response)
      try {
        const released = await releaseClaim(id)
        if (released !== 1) logSafeError('Send claim release did not update the sending row', new Error('send claim release missed'))
      } catch (error) {
        logSafeError('Send claim release failed before Gmail acceptance', error)
      }
      return response
    }

    // Durable record first. If this write fails, Gmail is never contacted.
    // The request id is globally unique: a replay from another account can never
    // silently send its own copy to the same recipient.
    async function replayAfterConflict(): Promise<ClaimFollowUp> {
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        const rows = await sql`
          SELECT id, status, gmail_message_id, last_error_code, payload_hash, owner_google_sub FROM send_records
          WHERE request_id = ${requestId}`
        const existing = rows.rows[0] as (SendRecord & { payload_hash: string; owner_google_sub: string }) | undefined
        if (!existing || existing.owner_google_sub !== session.googleSub) {
          return { action: 'respond', response: NextResponse.json({ error: 'This request id was already used by another session. Refresh and confirm again as a new send.' }, { status: 409 }) }
        }
        if (existing.payload_hash !== payloadHash) {
          return { action: 'respond', response: NextResponse.json({ error: 'This request id was already used for a different email. Refresh and confirm again as a new send.' }, { status: 409 }) }
        }
        if (existing.status !== 'recorded') return { action: 'respond', response: await recordResponse(existing, true, session.googleSub) }
        const claim = await sql`
          UPDATE send_records SET status = 'sending', updated_at = NOW()
          WHERE id = ${existing.id} AND owner_google_sub = ${session.googleSub} AND status = 'recorded'
          RETURNING id`
        if ((claim.rowCount ?? claim.rows.length) === 1) return { action: 'send', recordId: Number(claim.rows[0]?.id ?? existing.id) }
        const current = await loadRecordById(Number(existing.id))
        if (current) return { action: 'respond', response: await recordResponse(current, true, session.googleSub) }
        return { action: 'respond', response: NextResponse.json({ success: false, outcome: 'uncertain', uncertain: true, error: IN_PROGRESS_MESSAGE }, { status: 409 }) }
      }
      const db = getLocalDb()
      try {
        const existing = db.prepare('SELECT id, status, gmail_message_id, last_error_code, payload_hash, owner_google_sub FROM send_records WHERE request_id = ?').get(requestId) as (SendRecord & { payload_hash: string; owner_google_sub: string }) | undefined
        if (!existing || existing.owner_google_sub !== session.googleSub) {
          return { action: 'respond', response: NextResponse.json({ error: 'This request id was already used by another session. Refresh and confirm again as a new send.' }, { status: 409 }) }
        }
        if (existing.payload_hash !== payloadHash) {
          return { action: 'respond', response: NextResponse.json({ error: 'This request id was already used for a different email. Refresh and confirm again as a new send.' }, { status: 409 }) }
        }
        if (existing.status !== 'recorded') return { action: 'respond', response: await recordResponse(existing, true, session.googleSub) }
        const claimed = db.prepare(`UPDATE send_records SET status = 'sending', updated_at = datetime('now')
          WHERE id = ? AND owner_google_sub = ? AND status = 'recorded'`).run(existing.id, session.googleSub)
        if (claimed.changes === 1) return { action: 'send', recordId: Number(existing.id) }
        const current = db.prepare('SELECT id, status, gmail_message_id, last_error_code FROM send_records WHERE id = ? AND owner_google_sub = ?').get(existing.id, session.googleSub) as SendRecord | undefined
        if (current) return { action: 'respond', response: await recordResponse(current, true, session.googleSub) }
        return { action: 'respond', response: NextResponse.json({ success: false, outcome: 'uncertain', uncertain: true, error: IN_PROGRESS_MESSAGE }, { status: 409 }) }
      } finally {
        db.close()
      }
    }

    async function claimNewRow(insertedId: number): Promise<ClaimFollowUp> {
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        const claim = await sql`
          UPDATE send_records SET status = 'sending', updated_at = NOW()
          WHERE id = ${insertedId} AND owner_google_sub = ${session.googleSub} AND status = 'recorded'
          RETURNING id`
        if ((claim.rowCount ?? claim.rows.length) === 1) return { action: 'send', recordId: Number(claim.rows[0]?.id ?? insertedId) }
        return replayAfterConflict()
      }
      const db = getLocalDb()
      try {
        const claimed = db.prepare(`UPDATE send_records SET status = 'sending', updated_at = datetime('now')
          WHERE id = ? AND owner_google_sub = ? AND status = 'recorded'`).run(insertedId, session.googleSub)
        if (claimed.changes === 1) return { action: 'send', recordId: insertedId }
        return await replayAfterConflict()
      } finally {
        db.close()
      }
    }

    let follow: ClaimFollowUp
    try {
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        const inserted = await sql`
          INSERT INTO send_records (owner_google_sub, owner_email, request_id, payload_hash, status, pipeline_payload)
          VALUES (${session.googleSub}, ${session.email}, ${requestId}, ${payloadHash}, 'recorded', ${pipelinePayload})
          ON CONFLICT (request_id) DO NOTHING
          RETURNING id`
        follow = (inserted.rowCount ?? inserted.rows.length) === 0
          ? await replayAfterConflict()
          : await claimNewRow(Number(inserted.rows[0].id))
      } else {
        const db = getLocalDb()
        try {
          const inserted = db.prepare(`INSERT INTO send_records (owner_google_sub, owner_email, request_id, payload_hash, status, pipeline_payload)
            VALUES (?, ?, ?, ?, 'recorded', ?)`).run(session.googleSub, session.email, requestId, payloadHash, pipelinePayload)
          follow = await claimNewRow(Number(inserted.lastInsertRowid))
        } catch (insertError) {
          if (!isUniqueViolation(insertError)) throw insertError
          follow = await replayAfterConflict()
        } finally {
          db.close()
        }
      }
    } catch (recordError) {
      // A database failure before Gmail means no send attempt was made.
      logSafeError('Send record persistence failed before Gmail', recordError)
      return NextResponse.json({ error: 'Could not start this send. Try again in a moment.' }, { status: 503 })
    }

    if (follow.action === 'respond') return follow.response
    const recordId = follow.recordId
    if (!Number.isInteger(recordId) || recordId <= 0) {
      try { await releaseByRequestId() } catch (error) {
        logSafeError('Send claim release failed before Gmail', error)
      }
      return NextResponse.json({ error: 'Send record unavailable. Refresh and confirm the send again.' }, { status: 503 })
    }

    const raw = buildHtmlEmailRaw(to, subject, emailBody, cc, bcc, attachments)
    let newAccessToken: string | null = null

    // If no access token but refresh token exists, refresh before first attempt.
    // Gmail has not been contacted yet.
    if (!accessToken) {
      const refreshed = await refreshAccessToken(refreshToken!)
      if ('error' in refreshed) return respondToRefreshFailure(recordId, refreshed)
      newAccessToken = refreshed.accessToken
      accessToken = refreshed.accessToken
    }

    async function persistAccepted(id: number, acceptedMessageId: string): Promise<boolean> {
      const tryOnce = async () => {
        try {
          await finishOutcome('accepted', acceptedMessageId, null, id)
          return true
        } catch (error) {
          logSafeError('Send outcome persistence failed after Gmail acceptance', error)
          return false
        }
      }
      if (await tryOnce()) return true
      try {
        await new Promise(resolve => setTimeout(resolve, ACCEPTED_WRITE_BACKOFF_MS))
      } catch (error) {
        // A missing timer must not abandon the retry. The row is still 'sending'
        // and Gmail has already accepted the message.
        logSafeError('Send outcome retry delay failed after Gmail acceptance', error)
      }
      if (await tryOnce()) return true
      try {
        const current = await loadRecordById(id)
        if (current?.status === 'accepted' && hasMessageId(current)) return true
      } catch (error) {
        logSafeError('Send record reload failed after Gmail acceptance', error)
      }
      try {
        await finishOutcome('needs_review', acceptedMessageId, 'outcome_write_lost', id)
      } catch (error) {
        logSafeError('Send outcome needs_review fallback failed after Gmail acceptance', error)
      }
      return false
    }

    let messageId: string
    try {
      gmailAttempted = true
      messageId = (await sendViaGmail(accessToken, raw)).id
      acceptedMessageId = messageId
    } catch (sendError) {
      if (classifyGmailError(sendError) === 'auth' && refreshToken) {
        // The auth rejection means this attempt was not accepted. Refresh and
        // retry once. A refresh outage still has not accepted a message.
        const refreshed = await refreshAccessToken(refreshToken)
        if ('error' in refreshed) return respondToRefreshFailure(recordId, refreshed)
        newAccessToken = refreshed.accessToken
        try {
          messageId = (await sendViaGmail(newAccessToken, raw)).id
          acceptedMessageId = messageId
        } catch (retryError) {
          const kind = classifyGmailError(retryError)
          const status = outcomeFor(kind)
          return recordTerminal(recordId, status, kind, sendFailure(retryError, status))
        }
      } else {
        const kind = classifyGmailError(sendError)
        const status = outcomeFor(kind)
        return recordTerminal(recordId, status, kind, sendFailure(sendError, status))
      }
    }

    // Gmail accepted. Retry the outcome write once, then fall back to
    // needs_review. A stuck 'sending' row replays as uncertain and is never
    // resent. A retry that does land continues into Sheets, history, and the
    // refreshed cookie — the same path as a write that succeeded the first time.
    const persisted = await persistAccepted(recordId, messageId)
    if (!persisted) {
      return NextResponse.json({
        success: false,
        outcome: 'needs_review',
        uncertain: true,
        message_id: messageId,
        error: IN_PROGRESS_MESSAGE,
      }, { status: 502 })
    }

    const dossier = body.dossier
    let pipelineSynced: boolean | null = null
    if (dossier) {
      try { pipelineSynced = await syncPipelineSource(`immediate:${recordId}`, session.googleSub) === 'synced' }
      catch { pipelineSynced = false }
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
        try {
          db.prepare('INSERT INTO contact_history (brand_name, contact_role, contact_name, contact_email, method) VALUES (?, ?, ?, ?, ?)').run(dossier?.brand_name ?? '', body.role ?? '', contactName, to, 'email')
        } finally {
          db.close()
        }
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
    if (gmailAttempted) {
      return NextResponse.json({
        error: UNCERTAIN_MESSAGE,
        outcome: 'needs_review',
        uncertain: true,
        ...(acceptedMessageId ? { message_id: acceptedMessageId } : {}),
      }, { status: 502 })
    }
    return NextResponse.json({ error: 'The email request could not be completed. Please try again.' }, { status: 500 })
  }
}
