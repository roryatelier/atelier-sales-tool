import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import { securityConfigured } from '@/lib/auth-policy'

export async function GET() {
  if (!securityConfigured()) return NextResponse.json({ error: 'Security configuration unavailable' }, { status: 503 })
  const base = process.env.PRODUCTION_URL ?? 'http://localhost:3000'
  const client = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, base + '/api/auth/callback')
  const state = crypto.randomUUID()
  const url = client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent', state,
    scope: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
  })
  const response = NextResponse.redirect(url)
  const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' }
  for (const name of ['atelier_session', 'atelier_gmail', 'gmail_access_token', 'gmail_refresh_token']) response.cookies.set(name, '', { ...cookieOptions, maxAge: 0 })
  response.cookies.set('atelier_oauth_state', state, { ...cookieOptions, maxAge: 600 })
  return response
}
