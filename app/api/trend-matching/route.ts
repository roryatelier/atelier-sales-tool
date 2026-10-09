import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'
import { publicProviderError, researchStructured } from '@/lib/openai'
import { isNonEmptyString, isRecord } from '@/lib/validation'

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const body = await request.json()
    const { brands } = body

    if (!brands || brands.length === 0) {
      return NextResponse.json({ success: true, matches: [] })
    }

    const result = await researchStructured<{ matches: Array<Record<string, string>> }>({
      prompt: `You are a beauty industry trend analyst for Atelier, a GenAI platform that streamlines end-to-end NPD and manufacturing for prestige beauty brands — enabling brands to launch products 6x faster and increase R&D SKU capacity by 10x, powered by 8.5M+ supply chain permutations.

Search for the top trending beauty and wellness categories right now in 2026 — ingredients, formulation trends, product formats, or emerging categories gaining momentum in prestige retail.

Then match these trends against the following pipeline brands and their categories:
${brands.map((b: {brand_name: string; category: string; key_signals: string}) => `- ${b.brand_name}: ${b.category}. Signals: ${b.key_signals}`).join('\n')}

Return 4-6 trend matches.`,
      schemaName: 'pipeline_trend_matches',
      schema: { type: 'object', properties: { matches: { type: 'array', minItems: 4, maxItems: 6, items: { type: 'object', properties: {
        trend: { type: 'string' }, trend_summary: { type: 'string' }, brand: { type: 'string' }, match_reason: { type: 'string' }, outreach_angle: { type: 'string' }, momentum: { type: 'string', enum: ['rising', 'peak', 'established'] }
      }, required: ['trend', 'trend_summary', 'brand', 'match_reason', 'outreach_angle', 'momentum'], additionalProperties: false } } }, required: ['matches'], additionalProperties: false },
      validate: (value): value is { matches: Array<Record<string, string>> } => isRecord(value) && Array.isArray(value.matches)
        && value.matches.length >= 4 && value.matches.length <= 6
        && value.matches.every(match => isRecord(match) && ['trend', 'trend_summary', 'brand', 'match_reason', 'outreach_angle', 'momentum'].every(key => isNonEmptyString(match[key]))),
      maxOutputTokens: 3000
    })
    return NextResponse.json({ success: true, matches: result.data.matches })

  } catch (error) {
    logSafeError('Trend matching error:', error)
    const failure = publicProviderError(error)
    return NextResponse.json(failure.body, { status: failure.status })
  }
}
