import { initialiseDb, isVercel, getLocalDb } from '@/lib/db'

// A claimed send whose outcome was never written is invisible to its owner: the
// browser tab that started it is gone, and a replay only resolves the same
// request id. The sweeper moves those rows to needs_review so they are seen and
// reviewed rather than lost. It never calls Gmail and never returns a row to
// 'recorded' — a sweeper cannot know whether Gmail was called, so an ambiguous
// outcome stays ambiguous.
export const SEND_LEASE_MINUTES = 5

const INTERRUPTED_MESSAGE = 'Send interrupted before Gmail confirmed an outcome.'

export async function sweepAbandonedSends(): Promise<number> {
  await initialiseDb()
  const cutoff = new Date(Date.now() - SEND_LEASE_MINUTES * 60_000).toISOString()
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const result = await sql`
      UPDATE send_records
      SET status = 'needs_review',
          last_error_code = 'send_interrupted',
          last_error = ${INTERRUPTED_MESSAGE},
          updated_at = NOW()
      WHERE status = 'sending' AND updated_at < ${cutoff}::timestamptz
      RETURNING id`
    return result.rowCount ?? 0
  }
  const db = getLocalDb()
  try {
    const result = db.prepare(`UPDATE send_records
      SET status = 'needs_review',
          last_error_code = 'send_interrupted',
          last_error = ?,
          updated_at = datetime('now')
      WHERE status = 'sending' AND updated_at < datetime('now', ?)`).run(INTERRUPTED_MESSAGE, `-${SEND_LEASE_MINUTES} minutes`)
    return result.changes
  } finally {
    db.close()
  }
}
