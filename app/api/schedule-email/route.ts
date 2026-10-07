import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'

// Legacy sent_by values are client-authored and cannot establish ownership.
// Retain rows as evidence until the delivery-job migration assigns verified owners.
export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  return NextResponse.json({ error: 'Scheduled sending is paused for a delivery safety upgrade' }, { status: 503 })
}

export async function GET(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  return NextResponse.json({ success: true, emails: [], paused: true, legacy_jobs_quarantined: true })
}

export async function DELETE(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  return NextResponse.json({ error: 'Legacy scheduled jobs are quarantined pending ownership reconciliation' }, { status: 409 })
}
