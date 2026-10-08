import { authorizeRequest } from '@/lib/api-auth'
import { initialiseDb, isVercel, getLocalDb } from '@/lib/db'
import { sealGmailCredentials } from '@/lib/auth-policy'
import { getGmailCredentials } from '@/lib/session'
import { refreshGmailToken } from '@/lib/gmail'
import { NextRequest, NextResponse } from 'next/server'

const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/
const MAX_SCHEDULE_MS = 29 * 24 * 60 * 60 * 1000

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
  try {
    const body = await request.json()
    if (body.expectedGoogleSub !== auth.session.googleSub) return NextResponse.json({ error: 'Your Google account changed. Reload before scheduling.' }, { status: 409 })
    const { to, cc, bcc, subject, body: emailBody, brand_name, contact_name, scheduled_at_local, timezone = 'Australia/Sydney', dossier } = body
    if (typeof to !== 'string' || typeof subject !== 'string' || typeof emailBody !== 'string' || typeof scheduled_at_local !== 'string' || typeof timezone !== 'string' ||
      !to.trim() || !subject.trim() || !emailBody.trim() || !validRecipients(to, cc, bcc) || [to, cc, bcc, subject].some(value => typeof value === 'string' && /[\r\n]/.test(value))) {
      return NextResponse.json({ error: 'Invalid email or schedule details' }, { status: 400 })
    }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 4 * 1024 * 1024) return NextResponse.json({ error: 'Scheduled message exceeds the size limit' }, { status: 413 })

    let scheduledAt: Date
    try { scheduledAt = localToUtc(scheduled_at_local, timezone) } catch { return NextResponse.json({ error: 'Choose a valid date, time and timezone' }, { status: 400 }) }
    const delay = scheduledAt.getTime() - Date.now()
    if (delay < 60_000 || delay > MAX_SCHEDULE_MS) return NextResponse.json({ error: 'Schedule between 1 minute and 29 days from now' }, { status: 400 })

    const credentials = await getGmailCredentials(auth.session)
    if (!credentials?.refreshToken) return NextResponse.json({ error: 'Re-authorise Gmail before scheduling', reauth: true }, { status: 401 })
    const refreshedAccessToken = await refreshGmailToken(credentials.refreshToken)
    if (!refreshedAccessToken) return NextResponse.json({ error: 'Gmail authorisation could not be verified. Re-authorise Gmail.', reauth: true }, { status: 401 })
    const credentialCiphertext = await sealGmailCredentials({ ...auth.session, accessToken: refreshedAccessToken, refreshToken: credentials.refreshToken })
    const dossierJson = dossier ? JSON.stringify(dossier) : ''

    await initialiseDb()
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      await sql`INSERT INTO scheduled_emails
        (to_email, cc, bcc, subject, body, brand_name, contact_name, scheduled_at, timezone, sent_by, dossier_json, owner_google_sub, owner_email, credential_ciphertext, delivery_status)
        VALUES (${to.trim()}, ${cc ?? ''}, ${bcc ?? ''}, ${subject}, ${emailBody}, ${brand_name ?? ''}, ${contact_name ?? ''}, ${scheduledAt.toISOString()}, ${timezone}, ${auth.session.email}, ${dossierJson}, ${auth.session.googleSub}, ${auth.session.email}, ${credentialCiphertext}, 'pending')`
    } else {
      getLocalDb().prepare(`INSERT INTO scheduled_emails
        (to_email, cc, bcc, subject, body, brand_name, contact_name, scheduled_at, timezone, sent_by, dossier_json, owner_google_sub, owner_email, credential_ciphertext, delivery_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(to.trim(), cc ?? '', bcc ?? '', subject, emailBody, brand_name ?? '', contact_name ?? '', scheduledAt.toISOString(), timezone, auth.session.email, dossierJson, auth.session.googleSub, auth.session.email, credentialCiphertext)
    }
    return NextResponse.json({ success: true, scheduled_at: scheduledAt.toISOString() })
  } catch {
    console.error('Schedule email failed')
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
      const result = await sql`SELECT id, to_email, cc, subject, brand_name, contact_name, scheduled_at, timezone, delivery_status, last_error_code
        FROM scheduled_emails WHERE owner_google_sub = ${auth.session.googleSub} AND delivery_status IN ('pending', 'sending', 'needs_reauth', 'needs_review') ORDER BY scheduled_at ASC`
      return NextResponse.json({ success: true, emails: result.rows, paused: false })
    }
    const emails = getLocalDb().prepare(`SELECT id, to_email, cc, subject, brand_name, contact_name, scheduled_at, timezone, delivery_status, last_error_code
      FROM scheduled_emails WHERE owner_google_sub = ? AND delivery_status IN ('pending', 'sending', 'needs_reauth', 'needs_review') ORDER BY scheduled_at ASC`).all(auth.session.googleSub)
    return NextResponse.json({ success: true, emails, paused: false })
  } catch {
    console.error('Fetch scheduled emails failed')
    return NextResponse.json({ error: 'Failed to fetch scheduled emails' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  const id = Number(request.nextUrl.searchParams.get('id'))
  if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: 'Valid id is required' }, { status: 400 })
  try {
    await initialiseDb()
    let deleted = 0
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      const result = await sql`DELETE FROM scheduled_emails WHERE id = ${id} AND owner_google_sub = ${auth.session.googleSub} AND delivery_status = 'pending' RETURNING id`
      deleted = result.rowCount ?? 0
    } else {
      deleted = getLocalDb().prepare(`DELETE FROM scheduled_emails WHERE id = ? AND owner_google_sub = ? AND delivery_status = 'pending'`).run(id, auth.session.googleSub).changes
    }
    return deleted ? NextResponse.json({ success: true }) : NextResponse.json({ error: 'Scheduled email not found or already processing' }, { status: 404 })
  } catch {
    console.error('Cancel scheduled email failed')
    return NextResponse.json({ error: 'Failed to cancel scheduled email' }, { status: 500 })
  }
}
