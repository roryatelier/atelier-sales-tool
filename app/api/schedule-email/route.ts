import { authorizeRequest } from '@/lib/api-auth'
import { initialiseDb, isVercel, getLocalDb } from '@/lib/db'
import { sealGmailCredentials } from '@/lib/auth-policy'
import { getGmailCredentials } from '@/lib/session'
import { cancelScheduledEmail, resumeScheduledEmail } from '@/lib/scheduled-email-store'
import { refreshGmailToken, refreshScheduledGmailToken } from '@/lib/gmail'
import { NextRequest, NextResponse } from 'next/server'

const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/
const MAX_SCHEDULE_MS = 29 * 24 * 60 * 60 * 1000
// The composer mints a UUID per confirmed schedule submission; the server treats
// it as an opaque identity. The payload hash, not the id format, carries integrity.
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === '23505' ||
    /UNIQUE constraint failed: scheduled_emails/.test(String((error as { message?: string } | null)?.message ?? ''))
}

function localToUtc(value: string, timezone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error('invalid_time')
  const requested = match.slice(1).map(Number)
  const [year, month, day, hour, minute] = requested
  const fakeUtc = Date.UTC(year, month - 1, day, hour, minute)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const fields = (date: Date) => {
    const parts = formatter.formatToParts(date)
    const part = (type: string) => Number(parts.find(item => item.type === type)?.value)
    return [part('year'), part('month'), part('day'), part('hour'), part('minute')]
  }
  let candidate = fakeUtc
  for (let pass = 0; pass < 2; pass++) {
    const shown = fields(new Date(candidate))
    const shownUtc = Date.UTC(shown[0], shown[1] - 1, shown[2], shown[3], shown[4])
    candidate += fakeUtc - shownUtc
  }
  const result = new Date(candidate)
  if (fields(result).some((field, index) => field !== requested[index])) throw new Error('invalid_time')
  return result
}

function validRecipients(...groups: unknown[]): boolean {
  const addresses = groups.filter(Boolean).flatMap(value => typeof value === 'string' ? value.split(',').map(v => v.trim()).filter(Boolean) : [''])
  return addresses.length > 0 && addresses.length <= 20 && addresses.every(address => EMAIL.test(address))
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  const session = auth.session
  try {
    const body = await request.json()
    if (body.expectedGoogleSub !== session.googleSub) return NextResponse.json({ error: 'Your Google account changed. Reload before scheduling.' }, { status: 409 })

    // Scheduling is idempotent: the composer mints a request id when the user
    // confirms one specific schedule submission, and this id binds to the exact
    // payload. Missing ids fail closed (cached clients must refresh).
    const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : ''
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return NextResponse.json({ error: 'Your session is out of date. Refresh the page and schedule again.' }, { status: 400 })
    }

    const { to, cc, bcc, subject, body: emailBody, brand_name, contact_name, scheduled_at_local, timezone = 'Australia/Sydney', dossier, attachments } = body

    // Attachment bytes are not durable yet: scheduling with attachments would
    // silently drop them, so it is blocked until owned attachment storage exists.
    if (Array.isArray(attachments) && attachments.length > 0) {
      return NextResponse.json({ error: 'Attachments cannot be scheduled yet. Send this email immediately or remove the attachment.' }, { status: 400 })
    }

    if (typeof to !== 'string' || typeof subject !== 'string' || typeof emailBody !== 'string' || typeof scheduled_at_local !== 'string' || typeof timezone !== 'string' ||
      !to.trim() || !subject.trim() || !emailBody.trim() || !validRecipients(to, cc, bcc) || [to, cc, bcc, subject].some(value => typeof value === 'string' && /[\r\n]/.test(value))) {
      return NextResponse.json({ error: 'Invalid email or schedule details' }, { status: 400 })
    }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 4 * 1024 * 1024) return NextResponse.json({ error: 'Scheduled message exceeds the size limit' }, { status: 413 })

    let scheduledAt: Date
    try { scheduledAt = localToUtc(scheduled_at_local, timezone) } catch { return NextResponse.json({ error: 'Choose a valid date, time and timezone' }, { status: 400 }) }
    const delay = scheduledAt.getTime() - Date.now()
    if (delay < 60_000 || delay > MAX_SCHEDULE_MS) return NextResponse.json({ error: 'Schedule between 1 minute and 29 days from now' }, { status: 400 })

    // The payload hash binds the id to the exact submission, including the
    // resolved schedule time so clock drift is a conflict rather than an update.
    const payloadHash = await sha256Hex(JSON.stringify({
      to: to.trim(), cc: cc ?? '', bcc: bcc ?? '', subject, emailBody,
      scheduled_at: scheduledAt.toISOString(), timezone,
      brand_name: brand_name ?? '', contact_name: contact_name ?? '', dossier: dossier ?? null,
    }))

    const { isVercel, getLocalDb } = await import('@/lib/db')
    await initialiseDb()

    // Replay or conflict before any Gmail work: a retry must replay the recorded
    // job even when token refresh would fail.
    const existing = await loadExisting()
    if (existing) return replayResponse(existing)

    // New schedule: seal Gmail credentials only now, after dedupe — a replay must
    // not spend a token refresh. ON CONFLICT fences concurrent duplicates.
    const credentials = await getGmailCredentials(auth.session)
    if (!credentials?.refreshToken) return NextResponse.json({ error: 'Re-authorise Gmail before scheduling', reauth: true }, { status: 401 })
    const refreshedAccessToken = await refreshGmailToken(credentials.refreshToken)
    if (!refreshedAccessToken) return NextResponse.json({ error: 'Gmail authorisation could not be verified. Re-authorise Gmail.', reauth: true }, { status: 401 })
    const credentialCiphertext = await sealGmailCredentials({ ...auth.session, accessToken: refreshedAccessToken, refreshToken: credentials.refreshToken })

    async function loadExisting(): Promise<{ status: string | null; payload_hash: string | null; scheduled_at: string | null; owner_google_sub: string | null } | undefined> {
      if (isVercel) {
        const { sql } = await import('@vercel/postgres')
        const result = await sql`SELECT delivery_status AS status, payload_hash, scheduled_at::text AS scheduled_at, owner_google_sub FROM scheduled_emails WHERE request_id = ${requestId}`
        return result.rows[0] as { status: string | null; payload_hash: string | null; scheduled_at: string | null; owner_google_sub: string | null } | undefined
      }
      const db = getLocalDb()
      try {
        return db.prepare('SELECT delivery_status AS status, payload_hash, scheduled_at, owner_google_sub FROM scheduled_emails WHERE request_id = ?').get(requestId) as { status: string | null; payload_hash: string | null; scheduled_at: string | null; owner_google_sub: string | null } | undefined
      } finally { db.close() }
    }

    function replayResponse(existing: { payload_hash: string | null; scheduled_at: string | null; owner_google_sub: string | null } | null | undefined): NextResponse {
      if (!existing || existing.owner_google_sub !== session.googleSub) {
        return NextResponse.json({ error: 'This request id was already used by another session. Refresh and schedule again.' }, { status: 409 })
      }
      if (existing.payload_hash !== payloadHash) {
        return NextResponse.json({ error: 'This request id was already used for a different schedule. Refresh and schedule again as a new send.' }, { status: 409 })
      }
      return NextResponse.json({ success: true, replayed: true, scheduled_at: existing.scheduled_at ?? scheduledAt.toISOString() })
    }

    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      const result = await sql`
        INSERT INTO scheduled_emails
          (to_email, cc, bcc, subject, body, brand_name, contact_name, scheduled_at, timezone, sent_by, dossier_json, owner_google_sub, owner_email, credential_ciphertext, delivery_status, request_id, payload_hash)
        VALUES (${to.trim()}, ${cc ?? ''}, ${bcc ?? ''}, ${subject}, ${emailBody}, ${brand_name ?? ''}, ${contact_name ?? ''}, ${scheduledAt.toISOString()}, ${timezone}, ${session.email}, ${dossier ? JSON.stringify(dossier) : ''}, ${session.googleSub}, ${session.email}, ${credentialCiphertext}, 'pending', ${requestId}, ${payloadHash})
        ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
        RETURNING id`
      if ((result.rowCount ?? 0) === 0) return replayResponse(await loadExisting())
    } else {
      const db = getLocalDb()
      try {
        try {
          db.prepare(`INSERT INTO scheduled_emails
            (to_email, cc, bcc, subject, body, brand_name, contact_name, scheduled_at, timezone, sent_by, dossier_json, owner_google_sub, owner_email, credential_ciphertext, delivery_status, request_id, payload_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
            .run(to.trim(), cc ?? '', bcc ?? '', subject, emailBody, brand_name ?? '', contact_name ?? '', scheduledAt.toISOString(), timezone, session.email, dossier ? JSON.stringify(dossier) : '', session.googleSub, session.email, credentialCiphertext, requestId, payloadHash)
        } catch (insertError) {
          if (!isUniqueViolation(insertError)) throw insertError
          return replayResponse(await loadExisting())
        }
      } finally { db.close() }
    }
    return NextResponse.json({ success: true, scheduled_at: scheduledAt.toISOString() })
  } catch (scheduleError) {
    console.error("Schedule email failed", scheduleError instanceof Error ? scheduleError.message : scheduleError)
    return NextResponse.json({ error: 'Failed to schedule email' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  try {
    await initialiseDb()
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      const result = await sql`SELECT id, to_email, cc, subject, brand_name, contact_name, scheduled_at, timezone, delivery_status, last_error_code, gmail_message_id
        FROM scheduled_emails WHERE owner_google_sub = ${auth.session.googleSub} AND delivery_status IN ('pending', 'claimed', 'sending', 'needs_reauth', 'needs_review') ORDER BY scheduled_at ASC`
      return NextResponse.json({ success: true, emails: result.rows, paused: false, owner_google_sub: auth.session.googleSub })
    }
    const db = getLocalDb()
    try {
      const emails = db.prepare(`SELECT id, to_email, cc, subject, brand_name, contact_name, scheduled_at, timezone, delivery_status, last_error_code, gmail_message_id
        FROM scheduled_emails WHERE owner_google_sub = ? AND delivery_status IN ('pending', 'claimed', 'sending', 'needs_reauth', 'needs_review') ORDER BY scheduled_at ASC`).all(auth.session.googleSub)
      return NextResponse.json({ success: true, emails, paused: false, owner_google_sub: auth.session.googleSub })
    } finally { db.close() }
  } catch {
    console.error('Fetch scheduled emails failed')
    return NextResponse.json({ error: 'Failed to fetch scheduled emails' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  if (request.nextUrl.searchParams.get('expectedGoogleSub') !== auth.session.googleSub) return NextResponse.json({ error: 'Your Google account changed. Reload before cancelling.' }, { status: 409 })
  const id = Number(request.nextUrl.searchParams.get('id'))
  if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: 'Valid id is required' }, { status: 400 })
  try {
    await initialiseDb()
    const cancelled = await cancelScheduledEmail(id, auth.session.googleSub)
    return cancelled ? NextResponse.json({ success: true }) : NextResponse.json({ error: 'Unable to cancel: the job is missing or Gmail may already have been called. Refresh to check its status.' }, { status: 409 })
  } catch {
    console.error('Cancel scheduled email failed')
    return NextResponse.json({ error: 'Failed to cancel scheduled email' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  try {
    const body = await request.json()
    if (body.expectedGoogleSub !== auth.session.googleSub) return NextResponse.json({ error: 'Your Google account changed. Reload before resuming.' }, { status: 409 })
    if (!Number.isSafeInteger(body.id) || body.id < 1 || body.action !== 'resume') return NextResponse.json({ error: 'Valid job and resume action required' }, { status: 400 })
    const credentials = await getGmailCredentials(auth.session)
    if (!credentials?.refreshToken) return NextResponse.json({ error: 'Reconnect Gmail first', reauth: true }, { status: 401 })
    const refresh = await refreshScheduledGmailToken(credentials.refreshToken)
    if (!refresh.accessToken) return NextResponse.json({ error: refresh.reauth ? 'Reconnect Gmail and try again.' : 'Gmail is temporarily unavailable. Try resuming again later.', reauth: refresh.reauth === true }, { status: refresh.reauth ? 401 : 503 })
    const ciphertext = await sealGmailCredentials({ ...auth.session, accessToken: refresh.accessToken, refreshToken: credentials.refreshToken })
    await initialiseDb()
    const resumed = await resumeScheduledEmail(body.id, auth.session.googleSub, ciphertext)
    return resumed ? NextResponse.json({ success: true }) : NextResponse.json({ error: 'This job cannot be safely resumed. Refresh its status.' }, { status: 409 })
  } catch { return NextResponse.json({ error: 'Failed to resume scheduled email' }, { status: 500 }) }
}
