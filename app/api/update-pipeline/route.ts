import { NextRequest, NextResponse } from 'next/server'
import { authorizeRequest } from '@/lib/api-auth'
import { PipelineRowError } from '@/lib/pipeline-row'
import { updatePipelineStatus } from '@/lib/sheets'

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  try {
    await updatePipelineStatus(await request.json())
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof PipelineRowError ? error.message : 'Pipeline operation failed' }, { status: error instanceof PipelineRowError ? 409 : 503 })
  }
}
