import { NextRequest, NextResponse } from 'next/server'

// Quarantine the legacy worker: it can mark failed sends as sent and retry ambiguous sends.
// Resume only after the delivery-job migration and reconciliation in the repair specification.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ error: 'Scheduled sending is paused for a delivery safety upgrade' }, { status: 503 })
}
