import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const body = await request.json()
    const { brands } = body

    if (!brands || brands.length === 0) {
      return NextResponse.json({ success: true, matches: [] })
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 3
        }],
        messages: [{
          role: 'user',
          content: `You are a beauty industry trend analyst for Atelier, a GenAI platform that streamlines end-to-end NPD and manufacturing for prestige beauty brands — enabling brands to launch products 6x faster and increase R&D SKU capacity by 10x, powered by 8.5M+ supply chain permutations.

Search for the top trending beauty and wellness categories right now in 2026 — ingredients, formulation trends, product formats, or emerging categories gaining momentum in prestige retail.

Then match these trends against the following pipeline brands and their categories:
${brands.map((b: {brand_name: string; category: string; key_signals: string}) => `- ${b.brand_name}: ${b.category}. Signals: ${b.key_signals}`).join('\n')}

Return 4-6 trend matches as valid JSON only. No preamble, no markdown fences. Begin with [ and end with ].
[
  {
    "trend": "string (trend name e.g. 'Peptide skincare', 'Barrier repair', 'Clean fragrance')",
    "trend_summary": "string (one sentence explaining the trend)",
    "brand": "string (matching pipeline brand name)",
    "match_reason": "string (one sentence: why this brand aligns with this trend)",
    "outreach_angle": "string (one sentence: specific pitch angle for Atelier based on this trend match)",
    "momentum": "rising | peak | established"
  }
]`
        }]
      })
    })

    const data = await res.json()
    const rawText = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('')

    const jsonMatch = rawText.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return NextResponse.json({ success: true, matches: [] })

    const matches = JSON.parse(jsonMatch[0])
    return NextResponse.json({ success: true, matches })

  } catch (error) {
    logSafeError('Trend matching error:', error)
    return NextResponse.json({ error: 'Failed to fetch trend matches' }, { status: 500 })
  }
}