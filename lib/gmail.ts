import { buildHtmlEmailRaw } from './email-mime'

const REDIRECT_URI = process.env.PRODUCTION_URL
  ? `${process.env.PRODUCTION_URL}/api/auth/callback`
  : 'http://localhost:3000/api/auth/callback'

export function makeEmailRaw(to: string, subject: string, body: string, cc?: string, bcc?: string): string {
  return buildHtmlEmailRaw(to, subject, body, cc, bcc)
}

export async function refreshGmailToken(refreshToken: string): Promise<string | null> {
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

export async function sendViaGmail(accessToken: string, raw: string): Promise<string> {
  const { google } = await import('googleapis')
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    REDIRECT_URI
  )
  oauth2.setCredentials({ access_token: accessToken })
  const gmail = google.gmail({ version: 'v1', auth: oauth2 })
  const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
  const messageId = result.data.id
  if (typeof messageId !== 'string' || !messageId) {
    // A send without a message id can never be recorded as accepted; the caller
    // treats this as an uncertain outcome that needs review, never a resend.
    throw Object.assign(new Error('Gmail did not return a message id (missing_message_id)'), { code: 'missing_message_id' })
  }
  return messageId
}

export function isGmailAuthError(error: unknown): boolean {
  return classifyGmailError(error) === 'auth'
}

export type GmailErrorKind = 'auth' | 'permission' | 'policy' | 'quota' | 'temporary' | 'unknown'

export function classifyGmailError(error: unknown): GmailErrorKind {
  const value = typeof error === 'object' && error !== null
    ? error as { status?: unknown; code?: unknown; message?: unknown; response?: { status?: unknown; data?: unknown } }
    : {}
  const status = typeof value.status === 'number' ? value.status
    : typeof value.code === 'number' ? value.code
    : typeof value.response?.status === 'number' ? value.response.status : undefined
  const data = typeof value.response?.data === 'object' && value.response.data !== null
    ? value.response.data as { error?: { errors?: Array<{ reason?: unknown }> } }
    : undefined
  const reasons = data?.error?.errors?.map(item => typeof item.reason === 'string' ? item.reason.toLowerCase() : '') ?? []
  const message = typeof value.message === 'string' ? value.message.toLowerCase() : ''

  if (status === 401 || message.includes('invalid_grant') || message.includes('invalid credentials')) return 'auth'
  if (reasons.includes('domainpolicy')) return 'policy'
  if (reasons.some(reason => ['autherror', 'insufficientpermissions', 'forbidden'].includes(reason)) ||
      message.includes('insufficient authentication scope') || message.includes('insufficient permission')) return 'permission'
  if (status === 429 || reasons.some(reason => reason.includes('ratelimit') || reason.includes('dailylimit') || reason.includes('quota'))) return 'quota'
  if (typeof status === 'number' && status >= 500) return 'temporary'
  return 'unknown'
}
