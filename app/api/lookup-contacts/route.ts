import { authorizeRequest } from '@/lib/api-auth'
import { LushaError, normalizeDomain, revealContact, searchContacts } from '@/lib/lusha'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) { auth.error.headers.set('Cache-Control','private, no-store'); return auth.error }
  const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } })
  let body
  try { body = await request.json() } catch { return json({ success: false, status: 'invalid_input', error: 'Invalid request JSON.' },400) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({success:false,error:'Invalid request.'},400)
  try {
    const { enrich_id, action } = body
    if (action && !['search','reveal'].includes(action)) throw new LushaError('invalid_input',400,'Invalid lookup action.')
    if ('enrich_id' in body || action === 'reveal') {
      if (action === 'search' || typeof enrich_id !== 'string' || !enrich_id.trim() || enrich_id.length > 256) throw new LushaError('invalid_input',400,'A valid contact ID is required.')
      if (!body.expectedGoogleSub || body.expectedGoogleSub !== auth.session.googleSub) throw new LushaError('account_changed',409,'Account changed. Reload before revealing this email.')
      const result = await revealContact(enrich_id)
      return json(result, result.status === 'pending' ? 202 : 200)
    }
    const page = body.page ?? 0, size = body.size ?? 50
    if (!Number.isInteger(page) || page < 0 || page > 1000 || !Number.isInteger(size) || size < 10 || size > 100) throw new LushaError('invalid_input',400,'Invalid contact page or size.')
    return json(await searchContacts(normalizeDomain(body.domain), page, size))
  } catch (error) {
    if (error instanceof LushaError) return json({ success:false,status:error.code,error:error.message },error.httpStatus)
    return json({ success:false,status:'failed',error:'Contact lookup failed.' },502)
  }
}
