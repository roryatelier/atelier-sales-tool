import { getGmailCredentials } from '@/lib/session'
import { sealGmailCredentials } from '@/lib/auth-policy'
import { appendPipelineRow } from '@/lib/sheets'
import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'

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

interface Attachment {
  name: string
  type: string
  data: string // base64
}

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function markdownToHtml(text: string): string {
  const lines = text.split('\n')
  const processed: string[] = []
  let inList = false

  for (const line of lines) {
    const bulletMatch = line.match(/^\s*- (.+)/)
    if (bulletMatch) {
      if (!inList) { processed.push('<ul style="margin:8px 0;padding-left:20px;">'); inList = true }
      processed.push('<li>' + bulletMatch[1] + '</li>')
    } else {
      if (inList) { processed.push('</ul>'); inList = false }
      processed.push(line)
    }
  }
  if (inList) processed.push('</ul>')

  let html = processed.join('\n')

  // Bold before italic to avoid partial matches
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')

  // Markdown links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#050849;">$1</a>')

  // Newlines → <br>, but don't add <br> adjacent to block elements
  html = html.replace(/\n/g, '<br>')
  html = html.replace(/<br>(<\/?ul>|<li>)/g, '$1')
  html = html.replace(/(<\/ul>|<\/li>)<br>/g, '$1')

  return `<html><body style="font-family:sans-serif;font-size:14px;line-height:1.6;">${html}</body></html>`
}

function makeEmailBody(to: string, subject: string, body: string, attachments?: Attachment[], cc?: string, bcc?: string): string {
  const ccAddresses = cc ? cc.split(',').map(e => e.trim()).filter(Boolean).join(', ') : ''
  const bccAddresses = bcc ? bcc.split(',').map(e => e.trim()).filter(Boolean).join(', ') : ''
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`

  const htmlBody = markdownToHtml(body)
  const htmlBodyB64 = Buffer.from(htmlBody, 'utf-8').toString('base64').match(/.{1,76}/g)!.join('\r\n')

  if (!attachments || attachments.length === 0) {
    const lines = [
      `To: ${to}`,
      ...(ccAddresses ? [`Cc: ${ccAddresses}`] : []),
      ...(bccAddresses ? [`Bcc: ${bccAddresses}`] : []),
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      htmlBodyB64,
    ]
    return toBase64Url(Buffer.from(lines.join('\r\n')))
  }

  const boundary = `----=_Boundary_${Date.now().toString(36)}`
  const parts: string[] = [
    `To: ${to}`,
    ...(ccAddresses ? [`Cc: ${ccAddresses}`] : []),
    ...(bccAddresses ? [`Bcc: ${bccAddresses}`] : []),
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    htmlBodyB64,
  ]

  for (const att of attachments) {
    const safeName = `=?UTF-8?B?${Buffer.from(att.name, 'utf-8').toString('base64')}?=`
    const chunks = att.data.match(/.{1,76}/g)?.join('\r\n') ?? att.data
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.type || 'application/octet-stream'}; name="${safeName}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${safeName}"`,
      '',
      chunks,
    )
  }

  parts.push(`--${boundary}--`)
  return toBase64Url(Buffer.from(parts.join('\r\n')))
}

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
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
    if (!res.ok) return null
    const data = await res.json()
    return (data.access_token as string) ?? null
  } catch {
    return null
  }
}

function isAuthError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes('invalid_grant') ||
    error.message.includes('Invalid Credentials') ||
    error.message.includes('401')
  )
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
    const raw = makeEmailBody(to, subject, emailBody, attachments, cc, bcc)
    let newAccessToken: string | null = null

    // If no access token but refresh token exists, refresh before first attempt
    if (!accessToken) {
      newAccessToken = await refreshAccessToken(refreshToken!)
      if (!newAccessToken) {
        return NextResponse.json(
          { error: 'Gmail session expired — re-authorise Gmail', reauth: true },
          { status: 401 }
        )
      }
      accessToken = newAccessToken
    }

    let messageId: string
    try {
      messageId = await gmailSend(accessToken, raw)
    } catch (sendError) {
      if (isAuthError(sendError) && refreshToken) {
        // Token expired mid-session — refresh and retry once
        newAccessToken = await refreshAccessToken(refreshToken)
        if (!newAccessToken) {
          return NextResponse.json(
            { error: 'Gmail session expired — re-authorise Gmail', reauth: true },
            { status: 401 }
          )
        }
        messageId = await gmailSend(newAccessToken, raw)
      } else {
        throw sendError
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
      response.cookies.set('atelier_gmail', await sealGmailCredentials({ ...credentials!, accessToken: newAccessToken }), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30,
        path: '/',
      })
    }

    return response

  } catch (error: unknown) {
    console.error('Send email failed')

    if (isAuthError(error)) {
      return NextResponse.json(
        { error: 'Gmail session expired — re-authorise Gmail', reauth: true },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to send email' },
      { status: 500 }
    )
  }
}
