import { NextRequest, NextResponse } from 'next/server'
import { authorizeRequest } from '@/lib/api-auth'
import { initialiseDb } from '@/lib/db'

// Server-owned email drafts (WP3 slice 1). Every query is filtered by the
// authenticated owner; another owner's draft is indistinguishable from a
// missing one (404). Saves are revision-checked so a stale client cannot
// silently overwrite a newer revision, and the stored payload is built from an
// explicit whitelist — credentials, tokens, and unknown fields are rejected,
// never persisted. Attachment bytes never live here; slice 2 stores them
// separately and only their ids appear in attachment_ids.

const PAYLOAD_STRING_FIELDS = [
  'to', 'cc', 'bcc', 'subject', 'body', 'brand_name', 'contact_name',
  'instruction', 'template_name', 'template_role_group', 'template_source',
  'guidance_source', 'guidance_revision',
] as const

const MAX_PAYLOAD_JSON_LENGTH = 256_000
const MAX_ATTACHMENT_IDS = 10
const MAX_ATTACHMENT_ID_LENGTH = 256

function sanitizePayload(input: unknown): { payload?: Record<string, string>; error?: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'payload must be an object' }
  }
  const record = input as Record<string, unknown>
  const payload: Record<string, string> = {}
  for (const key of Object.keys(record)) {
    if (!(PAYLOAD_STRING_FIELDS as readonly string[]).includes(key)) {
      return { error: `payload field not allowed: ${key}` }
    }
    const value = record[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') return { error: `payload field must be a string: ${key}` }
    payload[key] = value
  }
  if (JSON.stringify(payload).length > MAX_PAYLOAD_JSON_LENGTH) {
    return { error: 'payload too large' }
  }
  return { payload }
}

function sanitizeAttachmentIds(input: unknown): { ids?: string[]; error?: string } {
  if (input === undefined || input === null) return { ids: [] }
  if (!Array.isArray(input) || input.length > MAX_ATTACHMENT_IDS) {
    return { error: 'attachment_ids must be an array of at most 10 ids' }
  }
  for (const id of input) {
    if (typeof id !== 'string' || !id.trim() || id.length > MAX_ATTACHMENT_ID_LENGTH) {
      return { error: 'attachment ids must be nonempty strings of at most 256 characters' }
    }
  }
  return { ids: input as string[] }
}

export async function GET(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  const session = auth.session
  await initialiseDb()
  const { isVercel, getLocalDb } = await import('@/lib/db')
  const idParam = request.nextUrl.searchParams.get('id')

  if (idParam !== null) {
    const id = Number(idParam)
    if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: 'Invalid draft id' }, { status: 400 })
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      const result = await sql`SELECT id, revision, payload, attachment_ids, created_at::text AS created_at, updated_at::text AS updated_at
        FROM email_drafts WHERE id = ${id} AND owner_google_sub = ${session.googleSub}`
      if (result.rows.length === 0) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
      const row = result.rows[0]
      return NextResponse.json({ draft: { ...row, payload: JSON.parse(row.payload as string), attachment_ids: JSON.parse(row.attachment_ids as string) } })
    }
    const db = getLocalDb()
    try {
      const row = db.prepare(`SELECT id, revision, payload, attachment_ids, created_at, updated_at
        FROM email_drafts WHERE id = ? AND owner_google_sub = ?`).get(id, session.googleSub) as { id: number; revision: number; payload: string; attachment_ids: string; created_at: string; updated_at: string } | undefined
      if (!row) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
      return NextResponse.json({ draft: { ...row, payload: JSON.parse(row.payload), attachment_ids: JSON.parse(row.attachment_ids) } })
    } finally { db.close() }
  }

  // Listing returns identity and a small preview only; the recovery UI (slice 5)
  // builds on this. Rows are the owner's own drafts.
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const result = await sql`SELECT id, revision, payload, updated_at::text AS updated_at
      FROM email_drafts WHERE owner_google_sub = ${session.googleSub} ORDER BY updated_at DESC LIMIT 50`
    return NextResponse.json({ drafts: result.rows.map(row => preview(row.id as number, row.revision as number, row.payload as string, row.updated_at as string)) })
  }
  const db = getLocalDb()
  try {
    const rows = db.prepare(`SELECT id, revision, payload, updated_at FROM email_drafts
      WHERE owner_google_sub = ? ORDER BY updated_at DESC LIMIT 50`).all(session.googleSub) as Array<{ id: number; revision: number; payload: string; updated_at: string }>
    return NextResponse.json({ drafts: rows.map(row => preview(row.id, row.revision, row.payload, row.updated_at)) })
  } finally { db.close() }
}

function preview(id: number, revision: number, payloadJson: string, updatedAt: string) {
  let subject = ''
  let to = ''
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>
    if (typeof payload.subject === 'string') subject = payload.subject
    if (typeof payload.to === 'string') to = payload.to
  } catch {}
  return { id, revision, subject, to, updated_at: updatedAt }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  const session = auth.session
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const { payload, error: payloadError } = sanitizePayload(body.payload)
  if (payloadError) return NextResponse.json({ error: payloadError }, { status: 400 })
  if (!payload) return NextResponse.json({ error: 'payload is required' }, { status: 400 })
  const { ids: attachmentIds, error: attachmentError } = sanitizeAttachmentIds(body.attachment_ids)
  if (attachmentError) return NextResponse.json({ error: attachmentError }, { status: 400 })

  const draftId = body.draft_id
  const isRevise = draftId !== undefined && draftId !== null
  if (isRevise && (!Number.isSafeInteger(draftId) || (draftId as number) < 1)) {
    return NextResponse.json({ error: 'Invalid draft id' }, { status: 400 })
  }
  const expectedRevision = body.expected_revision
  if (isRevise && (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1)) {
    return NextResponse.json({ error: 'expected_revision is required to revise a draft' }, { status: 400 })
  }

  await initialiseDb()
  const { isVercel, getLocalDb } = await import('@/lib/db')
  const payloadJson = JSON.stringify(payload)
  const attachmentJson = JSON.stringify(attachmentIds)

  if (!isRevise) {
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      const result = await sql`INSERT INTO email_drafts (owner_google_sub, owner_email, revision, payload, attachment_ids)
        VALUES (${session.googleSub}, ${session.email}, 1, ${payloadJson}, ${attachmentJson})
        RETURNING id, revision`
      return NextResponse.json({ draft: result.rows[0] })
    }
    const db = getLocalDb()
    try {
      const info = db.prepare(`INSERT INTO email_drafts (owner_google_sub, owner_email, revision, payload, attachment_ids)
        VALUES (?, ?, 1, ?, ?)`).run(session.googleSub, session.email, payloadJson, attachmentJson)
      return NextResponse.json({ draft: { id: Number(info.lastInsertRowid), revision: 1 } })
    } finally { db.close() }
  }

  // Revise with optimistic concurrency: the update only lands when the client
  // is on the revision it read. Anything else is a conflict, never a silent
  // overwrite, so a frozen (id, revision) confirmation can trust the bytes.
  const id = draftId as number
  const expected = expectedRevision as number
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const result = await sql`UPDATE email_drafts
      SET payload = ${payloadJson}, attachment_ids = ${attachmentJson}, revision = revision + 1, updated_at = NOW()
      WHERE id = ${id} AND owner_google_sub = ${session.googleSub} AND revision = ${expected}
      RETURNING id, revision`
    if (result.rows.length === 1) return NextResponse.json({ draft: result.rows[0] })
    return reviseConflict(sql, id, session.googleSub)
  }
  const db = getLocalDb()
  try {
    const info = db.prepare(`UPDATE email_drafts
      SET payload = ?, attachment_ids = ?, revision = revision + 1, updated_at = datetime('now')
      WHERE id = ? AND owner_google_sub = ? AND revision = ?`).run(payloadJson, attachmentJson, id, session.googleSub, expected)
    if (info.changes === 1) {
      const row = db.prepare('SELECT id, revision FROM email_drafts WHERE id = ?').get(id) as { id: number; revision: number }
      return NextResponse.json({ draft: row })
    }
    const existing = db.prepare('SELECT revision FROM email_drafts WHERE id = ? AND owner_google_sub = ?').get(id, session.googleSub) as { revision: number } | undefined
    if (!existing) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
    return NextResponse.json({ error: 'Draft changed since you loaded it. Reload the latest revision before saving.', current_revision: existing.revision }, { status: 409 })
  } finally { db.close() }
}

async function reviseConflict(sql: Awaited<typeof import('@vercel/postgres')>['sql'], id: number, owner: string) {
  const existing = await sql`SELECT revision FROM email_drafts WHERE id = ${id} AND owner_google_sub = ${owner}`
  if (existing.rows.length === 0) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  return NextResponse.json({ error: 'Draft changed since you loaded it. Reload the latest revision before saving.', current_revision: existing.rows[0].revision }, { status: 409 })
}
