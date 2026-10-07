import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { isAuthorizedEmail, securityConfigured, signSession, sealGmailCredentials } from '@/lib/auth-policy'

const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' }
function clearAuth(response: NextResponse) {
  for (const name of ['atelier_oauth_state', 'atelier_session', 'atelier_gmail', 'gmail_access_token', 'gmail_refresh_token']) response.cookies.set(name, '', { ...cookieOptions, maxAge: 0 })
  return response
}
export async function GET(request: NextRequest) {
  if (!securityConfigured()) return clearAuth(NextResponse.json({ error: 'Security configuration unavailable' }, { status: 503 }))
  const state = request.nextUrl.searchParams.get('state')
  const expected = request.cookies.get('atelier_oauth_state')?.value
  if (!state || !expected || state !== expected) return clearAuth(NextResponse.json({ error: 'Invalid OAuth state. Start sign-in again.' }, { status: 400 }))
  const code = request.nextUrl.searchParams.get('code')
  if (!code) return clearAuth(NextResponse.json({ error: 'No authorization code provided' }, { status: 400 }))
  try {
    const base = process.env.PRODUCTION_URL ?? 'http://localhost:3000'
    const client = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, base + '/api/auth/callback')
    const { tokens } = await client.getToken(code)
    client.setCredentials(tokens)
    const { data } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get()
    const email = (data.email ?? '').trim().toLowerCase()
    if (!data.id || data.verified_email !== true || !isAuthorizedEmail(email)) {
      return clearAuth(NextResponse.json({ error: 'This Google account is not authorized' }, { status: 403 }))
    }
    if (!tokens.access_token) throw new Error('No access token')
    const user = { googleSub: data.id, email, name: data.name ?? '', picture: data.picture ?? '' }
    const jwt = await signSession(user)
    const credentials = await sealGmailCredentials({ googleSub: user.googleSub, email, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? undefined })
    const response = clearAuth(NextResponse.redirect(base + '/'))
    response.cookies.set('atelier_session', jwt, { ...cookieOptions, maxAge: 60 * 60 * 24 * 30 })
    response.cookies.set('atelier_gmail', credentials, { ...cookieOptions, maxAge: 60 * 60 * 24 * 30 })
    return response
  } catch {
    console.error('OAuth callback failed')
    return clearAuth(NextResponse.json({ error: 'Authentication failed. Start sign-in again.' }, { status: 500 }))
  }
}
