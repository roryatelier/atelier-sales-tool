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

function sendFailure(error: unknown) {
  const kind = classifyGmailError(error)
  logSafeError('Gmail send failed', error)
  if (kind === 'auth' || kind === 'permission') {
    return NextResponse.json({ error: 'Gmail access needs to be reconnected before sending.', reauth: true }, { status: 401 })
  }
  if (kind === 'policy') return NextResponse.json({ error: 'Your Google Workspace administrator has blocked Gmail access for this app.' }, { status: 403 })
  if (kind === 'quota') return NextResponse.json({ error: 'Gmail has temporarily limited sending. Please try again later.' }, { status: 429 })
  if (kind === 'temporary') return NextResponse.json({ error: 'Gmail did not confirm this send. Check Sent mail before trying again.' }, { status: 503 })
  return NextResponse.json({ error: 'Gmail did not confirm this send. Check Sent mail before trying again.' }, { status: 502 })
}

async function gmailSend(accessToken: string, raw: string): Promise<string> {
  const oauth2Client = getOAuthClient()
  oauth2Client.setCredentials({ access_token: accessToken })
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
  const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
  return result.data.id!
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const body = await request.json()
    if (body.expectedGoogleSub !== auth.session.googleSub) {
      return NextResponse.json({ error: 'Your Google account changed. Reload and review the draft before sending.' }, { status: 409 })
    }
    const credentials = await getGmailCredentials(auth.session)
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
    const raw = buildHtmlEmailRaw(to, subject, emailBody, cc, bcc, attachments)
    let newAccessToken: string | null = null

    // If no access token but refresh token exists, refresh before first attempt
    if (!accessToken) {
      const refreshed = await refreshAccessToken(refreshToken!)
      if ('error' in refreshed) return refreshFailure(refreshed)
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
        if ('error' in refreshed) return refreshFailure(refreshed)
        newAccessToken = refreshed.accessToken
        try {
          messageId = await gmailSend(newAccessToken, raw)
        } catch (retryError) {
          return sendFailure(retryError)
        }
      } else {
        return sendFailure(sendError)
      }
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
            sent_by: auth.session.email
        })
        pipelineSynced = true
      } catch {
        console.error('Sheets sync failed')
      }
    }

    try {
      const { isVercel, getLocalDb } = await import('@/lib/db')
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
