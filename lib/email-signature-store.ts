import { getLocalDb, initialiseDb, isVercel } from '@/lib/db'
import { normaliseSignature, SIGNATURE_MAX_LENGTH } from '@/lib/email-signature'

export async function readSignature(ownerGoogleSub: string): Promise<string> {
  await initialiseDb()
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const result = await sql`SELECT content FROM email_signatures WHERE owner_google_sub = ${ownerGoogleSub}`
    return typeof result.rows[0]?.content === 'string' ? result.rows[0].content : ''
  }
  const db = getLocalDb()
  try {
    const row = db.prepare('SELECT content FROM email_signatures WHERE owner_google_sub = ?').get(ownerGoogleSub) as { content?: string } | undefined
    return typeof row?.content === 'string' ? row.content : ''
  } finally {
    db.close()
  }
}

export async function writeSignature(ownerGoogleSub: string, ownerEmail: string, content: string): Promise<string> {
  const signature = normaliseSignature(content)
  if (signature.length > SIGNATURE_MAX_LENGTH) throw new Error('signature_too_long')
  await initialiseDb()
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    await sql`
      INSERT INTO email_signatures (owner_google_sub, owner_email, content, updated_at)
      VALUES (${ownerGoogleSub}, ${ownerEmail}, ${signature}, NOW())
      ON CONFLICT (owner_google_sub) DO UPDATE SET
        owner_email = EXCLUDED.owner_email,
        content = EXCLUDED.content,
        updated_at = NOW()`
    return signature
  }
  const db = getLocalDb()
  try {
    db.prepare(`INSERT INTO email_signatures (owner_google_sub, owner_email, content, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(owner_google_sub) DO UPDATE SET
        owner_email = excluded.owner_email,
        content = excluded.content,
        updated_at = datetime('now')`).run(ownerGoogleSub, ownerEmail, signature)
    return signature
  } finally {
    db.close()
  }
}
