import { authorizeRequest } from '@/lib/api-auth'
import { updatePipelineNotes } from '@/lib/sheets'
import { PipelineRowError } from '@/lib/pipeline-row'
import { NextRequest, NextResponse } from 'next/server'
export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error
  try {
    await updatePipelineNotes(await request.json())
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof PipelineRowError ? error.message : 'Failed to update notes' }, { status: error instanceof PipelineRowError ? 409 : 503 })
  }
}
