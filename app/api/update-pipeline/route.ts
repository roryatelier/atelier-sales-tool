import { NextRequest, NextResponse } from 'next/server'
import { authorizeRequest } from '@/lib/api-auth'
import { updatePipelineStatus } from '@/lib/sheets'

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  try {
    await updatePipelineStatus(await request.json())
    return NextResponse.json({ success: true })
  } catch {
    console.error('update-pipeline failed')
    return NextResponse.json({ error: 'Pipeline operation failed' }, { status: 500 })
  }
}
