import 'server-only'
import { randomUUID } from 'node:crypto'
import { getLocalDb, isVercel } from '@/lib/db'
import { appendOutreachRow, findOutreachRow } from '@/lib/sheets'

export type ExportStatus = 'pending' | 'claimed' | 'writing' | 'synced' | 'failed' | 'needs_review'
interface ExportJob { outreach_id: string; owner_google_sub: string; payload: string; status: ExportStatus; destination_id: string; claim_token: string; write_intent_at: string | null; accepted_at: string }
async function query(text: string, values: (string | number | null)[] = []) {
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    let i = 0
    return (await sql.query(text.replace(/\?/g, () => `$${++i}`), values)).rows
  }
  const db = getLocalDb()
  try { return db.prepare(text).all(...values) as Record<string, unknown>[] } finally { db.close() }
}

// Store only the existing pipeline fields plus the actual To address. BCC,
// attachments, credentials and the rest of the dossier never enter the outbox.
export function pipelineSnapshot(input: Record<string, unknown>) {
  const keys = ['brand_name','website','lead_source','revenue_estimate','retailers','category','icp_score','score_band','signals','target_role','contact_name','email_subject','email_body','sent_by','to_email']
  return JSON.stringify(Object.fromEntries(keys.map(key => {
    const value = input[key]
    if (key === 'retailers' || key === 'signals') {
      const field = key === 'retailers' ? 'name' : 'type'
      if (Array.isArray(value)) return [key, value.map(item => ({ [field]: typeof item === 'object' && item ? String(item[field] ?? '') : String(item) }))]
    }
    return [key, typeof value === 'string' || typeof value === 'number' ? value : '']
  })))
}
export async function preparePipelineExport(kind: 'immediate' | 'scheduled', id: number, owner: string, payload: string) {
  const table = kind === 'immediate' ? 'send_records' : 'scheduled_emails'
  const condition = kind === 'immediate' ? "status = 'sending'" : "delivery_status = 'claimed' AND send_intent_at IS NULL"
  const rows = await query(`UPDATE ${table} SET pipeline_payload = COALESCE(pipeline_payload, ?) WHERE id = ? AND owner_google_sub = ? AND ${condition} RETURNING id`, [payload, id, owner])
  if (rows.length !== 1) throw new Error('export_snapshot_not_recorded')
}
export async function exportStatus(outreachId: string, owner: string): Promise<ExportStatus | null> {
  const rows = await query('SELECT status FROM outreach_exports WHERE outreach_id = ? AND owner_google_sub = ?', [outreachId, owner])
  return (rows[0]?.status as ExportStatus) ?? null
}
export async function sourceExportStatus(sourceKey: string, owner: string): Promise<ExportStatus | null> {
  const rows = await query('SELECT status FROM outreach_exports WHERE source_key = ? AND owner_google_sub = ?', [sourceKey, owner])
  return (rows[0]?.status as ExportStatus) ?? null
}
export async function syncPipelineSource(sourceKey: string, owner: string) {
  const rows = await query('SELECT outreach_id FROM outreach_exports WHERE source_key = ? AND owner_google_sub = ?', [sourceKey, owner])
  if (!rows[0]) return null
  return syncPipelineExport(String(rows[0].outreach_id), owner)
}
export async function recoverPipelineExports(owner?: string) {
  const before = new Date(Date.now() - 5 * 60_000).toISOString()
  const expired = isVercel ? 'claimed_at < ?' : 'datetime(claimed_at) < datetime(?)'
  await query(`UPDATE outreach_exports SET status = CASE WHEN write_intent_at IS NULL THEN 'failed' ELSE 'needs_review' END,
    claim_token = NULL, last_error_code = 'worker_interrupted', next_attempt_at = NULL
    WHERE status IN ('claimed','writing') AND (${isVercel ? 'claimed_at IS NULL' : 'datetime(claimed_at) IS NULL'} OR ${expired})${owner === undefined ? '' : ' AND owner_google_sub = ?'} RETURNING outreach_id`, owner === undefined ? [before] : [before, owner])
}

export async function syncPipelineExport(outreachId: string, owner: string): Promise<ExportStatus | null> {
  // Manual retries must recover expired leases even when cron is unavailable.
  await recoverPipelineExports(owner)
  const token = randomUUID()
  const rows = await query(`UPDATE outreach_exports SET status = 'claimed', claim_token = ?, claimed_at = ?, attempt_count = attempt_count + 1
    WHERE outreach_id = ? AND owner_google_sub = ? AND status IN ('pending','failed','needs_review') RETURNING *`, [token, new Date().toISOString(), outreachId, owner])
  const job = rows[0] as unknown as ExportJob | undefined
  if (!job) return exportStatus(outreachId, owner)
  const mark = async (status: ExportStatus, code: string | null, range: string | null = null) => {
    await query(`UPDATE outreach_exports SET status = ?, last_error_code = ?, sheet_range = COALESCE(?,sheet_range),
      synced_at = ?, next_attempt_at = ? WHERE outreach_id = ? AND claim_token = ? AND status IN ('claimed','writing','needs_review') RETURNING outreach_id`,
    [status, code, range, status === 'synced' ? new Date().toISOString() : null, new Date(Date.now() + 15 * 60_000).toISOString(), outreachId, token])
    return exportStatus(outreachId, owner)
  }
  try {
    if (!job.destination_id) {
      const destination = process.env.GOOGLE_SHEETS_ID
      if (!destination) return mark('failed', 'sheets_not_configured')
      await query(`UPDATE outreach_exports SET destination_id = ? WHERE outreach_id = ? AND claim_token = ? AND destination_id = '' AND write_intent_at IS NULL RETURNING outreach_id`, [destination, outreachId, token])
      job.destination_id = destination
    }
    // Always read by stable ID first. A lost append response can be reconciled
    // without making another append (and this module never imports Gmail).
    const existing = await findOutreachRow(outreachId, job.destination_id)
    if (existing) return mark('synced', null, existing)
    if (job.write_intent_at) return mark('needs_review', 'append_unconfirmed')
    const range = await appendOutreachRow(JSON.parse(job.payload), outreachId, job.destination_id, job.accepted_at, async () => {
      const intent = await query(`UPDATE outreach_exports SET status = 'writing', write_intent_at = ?
        WHERE outreach_id = ? AND claim_token = ? AND status = 'claimed' AND write_intent_at IS NULL RETURNING outreach_id`, [new Date().toISOString(), outreachId, token])
      if (intent.length !== 1) return false
      job.write_intent_at = new Date().toISOString()
      return true
    })
    if (!range) return exportStatus(outreachId, owner)
    return mark('synced', null, range)
  } catch (error) {
    // Reading/configuration failures are safe to retry. Once an append may have
    // happened, retries only look for its ID; absence is not proof of failure.
    const code = error instanceof Error && ['sheets_export_headers_required','sheets_destination_changed','duplicate_outreach_id','sheets_not_configured'].includes(error.message) ? error.message : 'sheets_unavailable'
    return mark(job.write_intent_at ? 'needs_review' : 'failed', job.write_intent_at ? 'append_unconfirmed' : code)
  }
}
export async function processPipelineExports(limit = 3) {
  await recoverPipelineExports()
  const now = new Date().toISOString()
  const due = isVercel ? 'next_attempt_at <= ?' : 'datetime(next_attempt_at) <= datetime(?)'
  const rows = await query(`SELECT outreach_id, owner_google_sub FROM outreach_exports WHERE status IN ('pending','failed','needs_review')
    AND (next_attempt_at IS NULL OR ${due}) ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, COALESCE(claimed_at, accepted_at), accepted_at, outreach_id LIMIT ?`, [now, limit])
  for (const row of rows) await syncPipelineExport(String(row.outreach_id), String(row.owner_google_sub))
}
export async function listPipelineExports(owner: string) {
  await recoverPipelineExports(owner)
  const rows = await query(`SELECT outreach_id, payload, status, last_error_code, accepted_at, synced_at FROM outreach_exports
    WHERE owner_google_sub = ? AND status != 'synced' ORDER BY accepted_at, outreach_id LIMIT 100`, [owner])
  return rows.map(row => {
    const payload = JSON.parse(String(row.payload))
    return { outreach_id: row.outreach_id, status: row.status, last_error_code: row.last_error_code, accepted_at: row.accepted_at,
      synced_at: row.synced_at, brand_name: payload.brand_name, to_email: payload.to_email, subject: payload.email_subject }
  })
}
