import { NextRequest, NextResponse } from 'next/server'
import { authorizeRequest } from '@/lib/api-auth'
import { initialiseDb } from '@/lib/db'
import { listPipelineExports, syncPipelineExport } from '@/lib/outreach-outbox'

export async function GET(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  try {
    await initialiseDb()
    return NextResponse.json({ success: true, owner_google_sub: auth.session.googleSub, exports: await listPipelineExports(auth.session.googleSub) })
  } catch { return NextResponse.json({ error: 'Could not load pipeline sync status' }, { status: 503 }) }
}
export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  try {
    const body = await request.json()
    if (body.expectedGoogleSub !== auth.session.googleSub) return NextResponse.json({ error: 'Your account changed. Reload before retrying.' }, { status: 409 })
    if (typeof body.outreach_id !== 'string' || !/^(outreach:[a-f0-9]{32}|(?:immediate|scheduled):[1-9]\d*)$/.test(body.outreach_id)) return NextResponse.json({ error: 'Valid outreach ID required' }, { status: 400 })
    await initialiseDb()
    const status = await syncPipelineExport(body.outreach_id, auth.session.googleSub)
    if (!status) return NextResponse.json({ error: 'Export not found' }, { status: 404 })
    return NextResponse.json({ success: true, status })
  } catch { return NextResponse.json({ error: 'Could not retry pipeline sync. The email will not be resent.' }, { status: 503 }) }
}
