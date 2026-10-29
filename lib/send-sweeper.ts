import { initialiseDb, isVercel, getLocalDb } from '@/lib/db'

// A claimed send whose outcome was never written is invisible to its owner: the
// browser tab that started it is gone, and a replay only resolves the same
// request id. The sweeper moves those rows to needs_review so they are seen and
// reviewed rather than lost. It never calls Gmail and never returns a row to
// 'recorded' — a sweeper cannot know whether Gmail was called, so an ambiguous
// outcome stays ambiguous.
export const SEND_LEASE_MINUTES = 5

const INTERRUPTED_MESSAGE = 'Send interrupted before Gmail confirmed an outcome.'
const ACCEPTED_UNRECORDED_MESSAGE = 'Gmail accepted a message, but the outcome was not recorded. Review before sending again.'

// The caller (the cron route) has already initialised the schema. Skipping a
// second pass keeps the worker's budget for sends. Direct callers still initialise.
export async function sweepAbandonedSends(options?: { initialise?: boolean }): Promise<number> {
  if (options?.initialise !== false) await initialiseDb()
  // Five minutes is longer than the 90-second function limit, so a send that is
  // still inside its request is not marked abandoned. The database clock is the
  // same clock that stamped updated_at. SQLite stores both ISO and datetime()
  // text; datetime() understands both, a raw string compare does not.
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const result = await sql`
      UPDATE send_records
      SET status = 'needs_review',
          last_error_code = 'send_interrupted',
          last_error = CASE
            WHEN gmail_message_id IS NOT NULL AND length(trim(gmail_message_id)) > 0 THEN ${ACCEPTED_UNRECORDED_MESSAGE}
            ELSE ${INTERRUPTED_MESSAGE}
          END,
          updated_at = NOW()
      WHERE status = 'sending'
        AND updated_at < NOW() - (${SEND_LEASE_MINUTES}::int * interval '1 minute')
      RETURNING id`
    return result.rows.length
  }
  const db = getLocalDb()
  try {
    const result = db.prepare(`UPDATE send_records
      SET status = 'needs_review',
          last_error_code = 'send_interrupted',
          last_error = CASE
            WHEN gmail_message_id IS NOT NULL AND length(trim(gmail_message_id)) > 0 THEN ?
            ELSE ?
          END,
          updated_at = datetime('now')
      WHERE status = 'sending' AND datetime(updated_at) < datetime('now', ?)`).run(
      ACCEPTED_UNRECORDED_MESSAGE,
      INTERRUPTED_MESSAGE,
      `-${SEND_LEASE_MINUTES} minutes`,
    )
    return result.changes
  } finally {
    db.close()
  }
}
