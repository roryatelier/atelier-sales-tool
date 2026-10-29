import { initialiseDb, isVercel, getLocalDb } from '@/lib/db'

// Count-only operational signals for the scheduled-send and export queues. The
// alert never contains recipients, subjects, bodies, message ids, or row
// contents — counts, ages, and error codes are enough to notice that something
// is stuck. It observes; it does not append, send, or reset anything.
export const OVERDUE_JOB_MINUTES = 30
export const EXPORT_LEASE_MINUTES = 5

export interface QueueAlerts {
  overduePendingJobs: number
  oldestOverdueJobSeconds: number | null
  exportsNeedsReview: number
  exportsFailedRetryable: number
  exportsStaleClaim: number
}

export async function collectQueueAlerts(): Promise<QueueAlerts> {
  await initialiseDb()
  const overdueCutoff = new Date(Date.now() - OVERDUE_JOB_MINUTES * 60_000).toISOString()
  const leaseCutoff = new Date(Date.now() - EXPORT_LEASE_MINUTES * 60_000).toISOString()
  const alerts: QueueAlerts = {
    overduePendingJobs: 0, oldestOverdueJobSeconds: null,
    exportsNeedsReview: 0, exportsFailedRetryable: 0, exportsStaleClaim: 0,
  }
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const jobs = await sql`
      SELECT COUNT(*)::int AS count, FLOOR(EXTRACT(EPOCH FROM (NOW() - MIN(scheduled_at))))::int AS oldest_seconds
      FROM scheduled_emails
      WHERE delivery_status = 'pending' AND scheduled_at < ${overdueCutoff}::timestamptz`
    alerts.overduePendingJobs = jobs.rows[0]?.count ?? 0
    alerts.oldestOverdueJobSeconds = jobs.rows[0]?.oldest_seconds ?? null
    const exports = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'needs_review')::int AS needs_review,
        COUNT(*) FILTER (WHERE status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))::int AS failed_retryable,
        COUNT(*) FILTER (WHERE status IN ('claimed', 'writing') AND COALESCE(write_intent_at, claimed_at) < ${leaseCutoff}::timestamptz)::int AS stale_claim
      FROM outreach_exports`
    alerts.exportsNeedsReview = exports.rows[0]?.needs_review ?? 0
    alerts.exportsFailedRetryable = exports.rows[0]?.failed_retryable ?? 0
    alerts.exportsStaleClaim = exports.rows[0]?.stale_claim ?? 0
    return alerts
  }
  const db = getLocalDb()
  try {
    const jobs = db.prepare(`SELECT COUNT(*) AS count, MIN(scheduled_at) AS oldest
      FROM scheduled_emails
      WHERE delivery_status = 'pending' AND scheduled_at < ?`).get(overdueCutoff) as { count: number; oldest: string | null }
    alerts.overduePendingJobs = jobs.count
    alerts.oldestOverdueJobSeconds = jobs.oldest ? Math.floor((Date.now() - Date.parse(jobs.oldest + (jobs.oldest.endsWith('Z') ? '' : 'Z'))) / 1000) : null
    const exports = db.prepare(`SELECT
        SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
        SUM(CASE WHEN status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) THEN 1 ELSE 0 END) AS failed_retryable,
        SUM(CASE WHEN status IN ('claimed','writing') AND COALESCE(write_intent_at, claimed_at) < ? THEN 1 ELSE 0 END) AS stale_claim
      FROM outreach_exports`).get(overdueCutoff, leaseCutoff) as { needs_review: number | null; failed_retryable: number | null; stale_claim: number | null }
    alerts.exportsNeedsReview = exports.needs_review ?? 0
    alerts.exportsFailedRetryable = exports.failed_retryable ?? 0
    alerts.exportsStaleClaim = exports.stale_claim ?? 0
    return alerts
  } finally {
    db.close()
  }
}

// One safe-log line per run when anything is stuck. Expired export claims are
// recovered elsewhere (recoverPipelineExports); this only reports what remains.
export async function reportQueueAlerts(): Promise<QueueAlerts> {
  const alerts = await collectQueueAlerts()
  const stuck = alerts.overduePendingJobs > 0 || alerts.exportsNeedsReview > 0
    || alerts.exportsFailedRetryable > 0 || alerts.exportsStaleClaim > 0
  if (stuck) {
    console.error('Outreach queue alert', {
      overdue_pending_jobs: alerts.overduePendingJobs,
      oldest_overdue_job_seconds: alerts.oldestOverdueJobSeconds,
      exports_needs_review: alerts.exportsNeedsReview,
      exports_failed_retryable: alerts.exportsFailedRetryable,
      exports_stale_claim: alerts.exportsStaleClaim,
    })
  }
  return alerts
}
