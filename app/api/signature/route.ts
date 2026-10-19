import { authorizeRequest } from '@/lib/api-auth'
import { SIGNATURE_MAX_LENGTH } from '@/lib/email-signature'
import { readSignature, writeSignature } from '@/lib/email-signature-store'
import { logSafeError } from '@/lib/safe-log'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: Request) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const signature = await readSignature(auth.session.googleSub)
    return NextResponse.json({ success: true, signature })
  } catch (error) {
    logSafeError('Signature fetch error:', error)
    return NextResponse.json({ error: 'Failed to fetch signature' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const body = await request.json()
    if (!body || typeof body !== 'object' || typeof body.signature !== 'string') {
      return NextResponse.json({ error: 'signature is required' }, { status: 400 })
    }
    if (body.signature.length > SIGNATURE_MAX_LENGTH) {
      return NextResponse.json({ error: 'signature is too long' }, { status: 400 })
    }
    const signature = await writeSignature(auth.session.googleSub, auth.session.email, body.signature)
    return NextResponse.json({ success: true, signature })
  } catch (error) {
    logSafeError('Signature update error:', error)
    return NextResponse.json({ error: 'Failed to update signature' }, { status: 500 })
  }
}
