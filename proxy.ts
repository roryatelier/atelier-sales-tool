import { NextRequest, NextResponse } from 'next/server'
import { securityConfigured, verifySession } from '@/lib/auth-policy'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname === '/api/auth/gmail' || pathname === '/api/auth/callback') return NextResponse.next()
  if (pathname === '/api/cron/send-scheduled-emails') {
    if (!process.env.CRON_SECRET || request.headers.get('authorization') !== 'Bearer ' + process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.next()
  }
  if (!securityConfigured()) return NextResponse.json({ error: 'Security configuration unavailable' }, { status: 503 })
  const token = request.cookies.get('atelier_session')?.value
  const session = token ? await verifySession(token) : null
  if (!session) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    return NextResponse.redirect(new URL('/api/auth/gmail', request.url))
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get('origin') !== request.nextUrl.origin) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
  }
  return NextResponse.next()
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
