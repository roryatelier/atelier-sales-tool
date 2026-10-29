import { NextRequest, NextResponse } from 'next/server'

// Public, provider-free liveness probe. The response carries the deployed
// commit and environment name so the post-deploy check can confirm the running
// build is the intended one. It must never call the database, Gmail, Sheets,
// Lusha, OpenAI, or Copper, and must never expose allowlists, identifiers, or
// error strings from other systems.
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    commit: process.env.VERCEL_GIT_COMMIT_SHA || 'unknown',
    env: process.env.VERCEL_ENV || 'local',
  })
}
