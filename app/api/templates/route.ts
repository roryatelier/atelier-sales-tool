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
      const result = await sql`SELECT * FROM templates ORDER BY created_at DESC`
      return NextResponse.json({ success: true, templates: result.rows })
    } else {
      const db = getLocalDb()
      const templates = db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all()
      return NextResponse.json({ success: true, templates })
    }
  } catch (error) {
    logSafeError('Templates fetch error:', error)
    return NextResponse.json({ error: 'Failed to fetch templates' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    await initialiseDb()
    const body = await request.json()
    const { name, role, subject, body: emailBody, target_role = '' } = body
    if (!name || !role || !subject || !emailBody) {
      return NextResponse.json({ error: 'name, role, subject, and body are required' }, { status: 400 })
    }
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      const result = await sql`INSERT INTO templates (name, role, subject, body, target_role) VALUES (${name}, ${role}, ${subject}, ${emailBody}, ${target_role}) RETURNING id`
      return NextResponse.json({ success: true, id: result.rows[0].id })
    } else {
      const db = getLocalDb()
      const result = db.prepare('INSERT INTO templates (name, role, subject, body, target_role) VALUES (?, ?, ?, ?, ?)').run(name, role, subject, emailBody, target_role)
      return NextResponse.json({ success: true, id: result.lastInsertRowid })
    }
  } catch (error) {
    logSafeError('Template save error:', error)
    return NextResponse.json({ error: 'Failed to save template' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    await initialiseDb()
    const body = await request.json()
    const { id, name, role, subject, body: emailBody, target_role = '' } = body
    if (!id || !name || !role || !subject || !emailBody) {
      return NextResponse.json({ error: 'id, name, role, subject, and body are required' }, { status: 400 })
    }
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      await sql`UPDATE templates SET name = ${name}, role = ${role}, subject = ${subject}, body = ${emailBody}, target_role = ${target_role}, updated_at = NOW() WHERE id = ${id}`
    } else {
      const db = getLocalDb()
      db.prepare('UPDATE templates SET name = ?, role = ?, subject = ?, body = ?, target_role = ?, updated_at = datetime(\'now\') WHERE id = ?').run(name, role, subject, emailBody, target_role, id)
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    logSafeError('Template update error:', error)
    return NextResponse.json({ error: 'Failed to update template' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      await sql`DELETE FROM templates WHERE id = ${id}`
    } else {
      const db = getLocalDb()
      db.prepare('DELETE FROM templates WHERE id = ?').run(id)
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    logSafeError('Template delete error:', error)
    return NextResponse.json({ error: 'Failed to delete template' }, { status: 500 })
  }
}