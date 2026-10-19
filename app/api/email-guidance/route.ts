import { authorizeRequest } from '@/lib/api-auth'
import { getEmailGuidanceInfo, updateEmailGuidance } from '@/lib/email-content'
import { logSafeError } from '@/lib/safe-log'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: Request) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const info = await getEmailGuidanceInfo()
    return NextResponse.json({ success: true, guidance: info.content, guidance_source: info.guidanceSource, guidance_revision: info.guidanceRevision })
  } catch (error) {
    logSafeError('Email guidance fetch error:', error)
    return NextResponse.json({ error: 'Failed to fetch email guidance' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const body = await request.json()
    const guidance = typeof body.guidance === 'string' ? body.guidance.trim() : ''
    if (!guidance) return NextResponse.json({ error: 'guidance is required' }, { status: 400 })
    if (guidance.length > 20_000) return NextResponse.json({ error: 'guidance is too long' }, { status: 400 })
    await updateEmailGuidance(guidance)
    return NextResponse.json({ success: true })
  } catch (error) {
    logSafeError('Email guidance update error:', error)
    return NextResponse.json({ error: 'Failed to update email guidance' }, { status: 500 })
  }
}
