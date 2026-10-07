import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextResponse } from 'next/server'
import { isVercel, getLocalDb } from '@/lib/db'

export async function GET(request: Request) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    let dossiers: { brand_name: string; dossier_json: string; updated_at: string }[] = []

    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      const result = await sql`SELECT brand_name, dossier_json, updated_at FROM dossiers ORDER BY updated_at DESC`
      dossiers = result.rows as { brand_name: string; dossier_json: string; updated_at: string }[]
    } else {
      const db = getLocalDb()
      dossiers = db.prepare('SELECT brand_name, dossier_json, updated_at FROM dossiers ORDER BY updated_at DESC').all() as { brand_name: string; dossier_json: string; updated_at: string }[]
    }

    const parsed = dossiers.map(d => ({
      ...JSON.parse(d.dossier_json),
      updated_at: d.updated_at
    }))

    return NextResponse.json({ success: true, dossiers: parsed })
  } catch (error) {
    logSafeError('Portfolio error:', error)
    return NextResponse.json({ error: 'Failed to fetch portfolio' }, { status: 500 })
  }
}