import 'server-only'
import { NextResponse } from 'next/server'
import { getSession } from './session'
import { securityConfigured, type UserSession } from './auth-policy'

export async function authorizeRequest(request?: Request): Promise<{ session: UserSession; error?: never } | { session?: never; error: NextResponse }> {
  if (!securityConfigured()) return { error: NextResponse.json({ error: 'Security configuration unavailable' }, { status: 503 }) }
  const session = await getSession()
  if (!session) return { error: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) }
  if (request && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    if (request.headers.get('origin') !== new URL(request.url).origin) return { error: NextResponse.json({ error: 'Invalid request origin' }, { status: 403 }) }
  }
  return { session }
}
