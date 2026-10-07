import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'
import { initialiseDb, isVercel, getLocalDb } from '@/lib/db'

export async function GET(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    await initialiseDb()
    const { searchParams } = new URL(request.url)
    const brandName = searchParams.get('brand_name')
    if (!brandName) return NextResponse.json({ error: 'brand_name is required' }, { status: 400 })
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      const result = await sql`SELECT * FROM contact_history WHERE brand_name = ${brandName} ORDER BY sent_at DESC`
      return NextResponse.json({ success: true, history: result.rows })
    } else {
      const db = getLocalDb()
      const history = db.prepare('SELECT * FROM contact_history WHERE brand_name = ? ORDER BY sent_at DESC').all(brandName)
      return NextResponse.json({ success: true, history })
    }
  } catch (error) {
    logSafeError('Contact history error:', error)
    return NextResponse.json({ error: 'Failed to fetch contact history' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    await initialiseDb()
    const body = await request.json()
    const { brand_name, contact_role, contact_name, contact_email, method = 'email' } = body
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      await sql`INSERT INTO contact_history (brand_name, contact_role, contact_name, contact_email, method) VALUES (${brand_name}, ${contact_role}, ${contact_name}, ${contact_email}, ${method})`
    } else {
      const db = getLocalDb()
      db.prepare('INSERT INTO contact_history (brand_name, contact_role, contact_name, contact_email, method) VALUES (?, ?, ?, ?, ?)').run(brand_name, contact_role, contact_name, contact_email, method)
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    logSafeError('Contact history POST error:', error)
    return NextResponse.json({ error: 'Failed to save contact history' }, { status: 500 })
  }
}