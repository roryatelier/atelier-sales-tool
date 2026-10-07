import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'
import { initialiseDb, isVercel, getLocalDb } from '@/lib/db'

export async function GET(request: Request) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    await initialiseDb()
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      const result = await sql`SELECT * FROM saved_suggestions ORDER BY created_at DESC`
      return NextResponse.json({ success: true, suggestions: result.rows })
    } else {
      const db = getLocalDb()
      const suggestions = db.prepare('SELECT * FROM saved_suggestions ORDER BY created_at DESC').all()
      return NextResponse.json({ success: true, suggestions })
    }
  } catch (error) {
    logSafeError('Saved suggestions fetch error:', error)
    return NextResponse.json({ error: 'Failed to fetch saved suggestions' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    await initialiseDb()
    const body = await request.json()
    const { brand_name, category, reason, signal } = body
    if (!brand_name || !category || !reason || !signal) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      await sql`INSERT INTO saved_suggestions (brand_name, category, reason, signal) VALUES (${brand_name}, ${category}, ${reason}, ${signal}) ON CONFLICT (brand_name) DO NOTHING`
    } else {
      const db = getLocalDb()
      db.prepare('INSERT OR IGNORE INTO saved_suggestions (brand_name, category, reason, signal) VALUES (?, ?, ?, ?)').run(brand_name, category, reason, signal)
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    logSafeError('Save suggestion error:', error)
    return NextResponse.json({ error: 'Failed to save suggestion' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const { searchParams } = new URL(request.url)
    const brand_name = searchParams.get('brand_name')
    if (!brand_name) return NextResponse.json({ error: 'brand_name is required' }, { status: 400 })
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      await sql`DELETE FROM saved_suggestions WHERE brand_name = ${brand_name}`
    } else {
      const db = getLocalDb()
      db.prepare('DELETE FROM saved_suggestions WHERE brand_name = ?').run(brand_name)
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    logSafeError('Delete suggestion error:', error)
    return NextResponse.json({ error: 'Failed to delete suggestion' }, { status: 500 })
  }
}