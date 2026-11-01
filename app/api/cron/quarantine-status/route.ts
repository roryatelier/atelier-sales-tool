import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { initialiseDb, isVercel, getLocalDb } from '@/lib/db'

// Read-only status for the post-deploy check. It reports counts only: how many
// scheduled jobs are in each delivery state, and how many jobs still marked
// legacy_quarantined already carry a Gmail message id (which would mean a
// quarantined job was sent). It never sends, never updates, and never returns
// recipients, subjects, bodies, or message ids.
function secretMatches(presented: string | null, secret: string): boolean {
  const a = Buffer.from(presented ?? '')
  const b = Buffer.from(`Bearer ${secret}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || !secretMatches(request.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try { await initialiseDb() } catch { return NextResponse.json({ error: 'Database unavailable' }, { status: 503 }) }

  const counts: Record<string, number> = {}
  let quarantinedWithMessageId = 0
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const byStatus = await sql`SELECT COALESCE(delivery_status, 'unknown') AS status, COUNT(*)::int AS count FROM scheduled_emails GROUP BY 1`
    for (const row of byStatus.rows) counts[row.status as string] = row.count as number
    const quarantined = await sql`SELECT COUNT(*)::int AS count FROM scheduled_emails
      WHERE delivery_status = 'legacy_quarantined' AND gmail_message_id IS NOT NULL AND length(trim(gmail_message_id)) > 0`
    quarantinedWithMessageId = quarantined.rows[0]?.count ?? 0
  } else {
    const db = getLocalDb()
    try {
      const byStatus = db.prepare(`SELECT COALESCE(delivery_status, 'unknown') AS status, COUNT(*) AS count FROM scheduled_emails GROUP BY 1`).all() as Array<{ status: string; count: number }>
      for (const row of byStatus) counts[row.status] = row.count
      const quarantined = db.prepare(`SELECT COUNT(*) AS count FROM scheduled_emails
        WHERE delivery_status = 'legacy_quarantined' AND gmail_message_id IS NOT NULL AND length(trim(gmail_message_id)) > 0`).get() as { count: number }
      quarantinedWithMessageId = quarantined.count
    } finally { db.close() }
  }
  return NextResponse.json({ status_counts: counts, legacy_quarantined_with_message_id: quarantinedWithMessageId })
}
