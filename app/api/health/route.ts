import { NextResponse } from 'next/server'

// Public, provider-free liveness probe. The response carries the deployed
// commit and environment name so the post-deploy check can confirm the running
// build is the intended one. It must never call the database, Gmail, Sheets,
// Lusha, OpenAI, or Copper, and must never expose allowlists, identifiers, or
// error strings from other systems.
//
// Read at request time. A cached or build-time snapshot would let the canary
// observe a commit that is no longer the one serving the alias.
export const dynamic = 'force-dynamic'

const KNOWN_ENVIRONMENTS = new Set(['production', 'preview', 'development'])

function deploymentCommit(): string {
  const value = process.env.VERCEL_GIT_COMMIT_SHA ?? ''
  return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : 'unknown'
}

function deploymentEnv(): string {
  const value = process.env.VERCEL_ENV
  if (!value) return 'local'
  return KNOWN_ENVIRONMENTS.has(value) ? value : 'unknown'
}

export async function GET() {
  return NextResponse.json(
    { status: 'ok', commit: deploymentCommit(), env: deploymentEnv() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
