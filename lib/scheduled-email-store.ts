import { randomUUID } from 'node:crypto'
import { getLocalDb, isVercel } from '@/lib/db'

export interface ScheduledEmail {
  id: number; to_email: string; cc: string; bcc: string; subject: string; body: string
  brand_name: string; contact_name: string; owner_google_sub: string; owner_email: string
  credential_ciphertext: string; dossier_json: string; claim_token: string
  pipeline_payload?: string | null; gmail_message_id?: string | null
}

// Five minutes exceeds the worker's 90-second execution limit. A token fences
// an old worker after recovery or cancellation; timestamps alone cannot do that.
const cutoff = () => new Date(Date.now() - 5 * 60_000).toISOString()
async function query(text: string, values: (string | number | null)[] = []) {
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    let index = 0
    return (await sql.query(text.replace(/\?/g, () => `$${++index}`), values)).rows
  }
  const db = getLocalDb()
  try { return db.prepare(text).all(...values) as Record<string, unknown>[] } finally { db.close() }
}

export async function recoverScheduledEmails() {
  // Legacy sending rows also have an uncertain outcome, even without an intent.
  const review = await query(`UPDATE scheduled_emails SET delivery_status = 'needs_review', last_error_code = 'worker_interrupted'
    WHERE delivery_status IN ('sending', 'claimed') AND
    (${isVercel ? 'claimed_at IS NULL OR claimed_at < ?' : 'datetime(claimed_at) IS NULL OR datetime(claimed_at) < datetime(?)'})
    AND (delivery_status = 'sending' OR send_intent_at IS NOT NULL OR claim_token IS NULL OR ${isVercel ? 'claimed_at IS NULL' : 'datetime(claimed_at) IS NULL'})
    RETURNING id`, [cutoff()])
  const recovered = await query(`UPDATE scheduled_emails SET delivery_status = 'pending', claim_token = NULL, claimed_at = NULL, last_error_code = 'claim_recovered'
    WHERE delivery_status = 'claimed' AND send_intent_at IS NULL AND claim_token IS NOT NULL
    AND ${isVercel ? 'claimed_at < ?' : 'datetime(claimed_at) < datetime(?)'} RETURNING id`, [cutoff()])
  return { recovered: recovered.length, needs_review: review.length }
}

export async function claimNext(): Promise<ScheduledEmail | null> {
  const token = randomUUID()
  const now = new Date().toISOString()
  if (isVercel) {
    const rows = await query(`WITH candidate AS (
      SELECT id FROM scheduled_emails WHERE delivery_status = 'pending' AND scheduled_at <= NOW()
      AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY scheduled_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE scheduled_emails AS job SET delivery_status = 'claimed', claim_token = ?, claimed_at = ?, send_intent_at = NULL,
      attempt_count = COALESCE(attempt_count, 0) + 1 FROM candidate WHERE job.id = candidate.id RETURNING job.*`, [token, now])
    return (rows[0] as unknown as ScheduledEmail) ?? null
  }
  const db = getLocalDb()
  try {
    return db.transaction(() => db.prepare(`UPDATE scheduled_emails SET delivery_status = 'claimed', claim_token = ?, claimed_at = ?, send_intent_at = NULL,
      attempt_count = COALESCE(attempt_count, 0) + 1 WHERE id = (
        SELECT id FROM scheduled_emails WHERE delivery_status = 'pending' AND datetime(scheduled_at) <= datetime('now')
        AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now')) ORDER BY datetime(scheduled_at), id LIMIT 1
      ) AND delivery_status = 'pending' RETURNING *`).get(token, now) as ScheduledEmail | undefined)() ?? null
  } finally { db.close() }
}

export async function beginScheduledSend(email: ScheduledEmail) {
  return (await query(`UPDATE scheduled_emails SET delivery_status = 'sending', send_intent_at = ?
    WHERE id = ? AND claim_token = ? AND delivery_status = 'claimed' AND send_intent_at IS NULL
    AND ${isVercel ? 'claimed_at >= ?' : 'datetime(claimed_at) >= datetime(?)'} RETURNING id`,
  [new Date().toISOString(), email.id, email.claim_token, cutoff()])).length === 1
}

export async function failScheduledSend(email: ScheduledEmail, status: 'needs_reauth' | 'needs_review' | 'pending', code: string) {
  // Only pre-intent failures may be retried or resumed.
  return query(`UPDATE scheduled_emails SET delivery_status = ?, last_error_code = ?, next_attempt_at = ?
    WHERE id = ? AND claim_token = ? AND ${status === 'needs_review' ? "delivery_status = 'sending'" : "delivery_status = 'claimed' AND send_intent_at IS NULL"} RETURNING id`,
  [status, code, status === 'pending' ? new Date(Date.now() + 5 * 60_000).toISOString() : null, email.id, email.claim_token])
}

export async function acceptScheduledSend(email: ScheduledEmail, messageId: string) {
  if (!messageId.trim()) throw new Error('missing_message_id')
  // A late response can resolve recovery's uncertainty for this same attempt.
  // Retrying this write never retries Gmail, including commit-with-lost-ack.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const rows = await query(`UPDATE scheduled_emails SET delivery_status = 'sent', sent = ${isVercel ? 'true' : '1'}, sent_at = ?, gmail_message_id = ?, last_error_code = NULL
        WHERE id = ? AND claim_token = ? AND send_intent_at IS NOT NULL
        AND (delivery_status IN ('sending', 'needs_review') OR (delivery_status = 'sent' AND gmail_message_id = ?)) RETURNING id`,
      [new Date().toISOString(), messageId, email.id, email.claim_token, messageId])
      if (rows.length !== 1) throw new Error('acceptance_not_recorded')
      return
    } catch (error) { if (attempt === 2) throw error }
  }
}

export async function recordAcceptedMessageId(email: ScheduledEmail, messageId: string) {
  // Best-effort durable proof that Gmail accepted this attempt. The message id is
  // stored and the export row queued even when the full acceptance write cannot
  // complete, so review never turns into a hand resend. Retrying this write never
  // retries Gmail.
  if (!messageId.trim()) throw new Error('missing_message_id')
  await query(`UPDATE scheduled_emails SET gmail_message_id = ?, last_error_code = 'acceptance_write_lost', next_attempt_at = NULL
    WHERE id = ? AND claim_token = ? AND send_intent_at IS NOT NULL RETURNING id`, [messageId, email.id, email.claim_token])
  await query(`INSERT INTO outreach_exports(source_key, owner_google_sub, payload, gmail_message_id, accepted_at)
    SELECT 'scheduled:' || ?, ?, COALESCE(?, '{}'), ?, ${isVercel ? 'NOW()' : "datetime('now')"}
    ON CONFLICT (source_key) DO NOTHING RETURNING source_key`,
    [String(email.id), email.owner_google_sub, email.pipeline_payload ?? null, messageId])
}

export async function cancelScheduledEmail(id: number, owner: string) {
  return (await query(`UPDATE scheduled_emails SET delivery_status = 'cancelled', claim_token = NULL
    WHERE id = ? AND owner_google_sub = ? AND delivery_status IN ('pending', 'claimed', 'needs_reauth')
    AND send_intent_at IS NULL RETURNING id`, [id, owner])).length === 1
}

export async function resumeScheduledEmail(id: number, owner: string, ciphertext: string) {
  return (await query(`UPDATE scheduled_emails SET delivery_status = 'pending', credential_ciphertext = ?, claim_token = NULL,
    claimed_at = NULL, next_attempt_at = NULL, last_error_code = NULL
    WHERE id = ? AND owner_google_sub = ? AND delivery_status = 'needs_reauth' AND send_intent_at IS NULL RETURNING id`,
  [ciphertext, id, owner])).length === 1
}
