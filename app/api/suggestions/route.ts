import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { initialiseDb, isVercel, getLocalDb } from '@/lib/db'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const REENGAGE_MONTHS = 6

export async function POST(request: Request) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    await initialiseDb()
    const body = await request.json()
    const { excludeBrands = [] } = body

    const cutoffDate = new Date()
    cutoffDate.setMonth(cutoffDate.getMonth() - REENGAGE_MONTHS)

    let reengageRows: { brand_name: string; last_contacted: string }[] = []

    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      const result = await sql`
        SELECT DISTINCT brand_name, MAX(sent_at) as last_contacted
        FROM contact_history
        WHERE sent_at <= ${cutoffDate.toISOString()}
        GROUP BY brand_name
      `
      reengageRows = result.rows as { brand_name: string; last_contacted: string }[]
    } else {
      const db = getLocalDb()
      reengageRows = db.prepare(`
        SELECT brand_name, MAX(sent_at) as last_contacted
        FROM contact_history
        WHERE sent_at <= ?
        GROUP BY brand_name
      `).all(cutoffDate.toISOString()) as { brand_name: string; last_contacted: string }[]
    }

    const reengageBrands = reengageRows.filter(
      r => !excludeBrands.includes(r.brand_name)
    )

    const excludeList = excludeBrands.length > 0
      ? 'Exclude these brands as they are already in the active pipeline: ' + excludeBrands.join(', ') + '.'
      : ''

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: 'You are a sales intelligence analyst for Atelier, a GenAI platform that streamlines end-to-end NPD and manufacturing for prestige beauty brands — enabling brands to launch products 6x faster, increase R&D SKU capacity by 10x, reduce the cost of innovation to near $0, and 2x operating profit margins.\n\n' +
            'Suggest 8 global prestige beauty/wellness brands that would be strong prospects for Atelier. Focus on brands that would benefit from faster NPD cycles, greater SKU capacity, or lower cost of innovation:\n' +
            '- Prestige beauty, skincare, haircare, or wellness brands\n' +
            '- Revenue of AUD $50M+ or showing strong growth signals\n' +
            '- Sold through Sephora, Mecca, David Jones, or equivalent prestige retailers\n' +
            '- Active product development (recent launches, NPD hiring, funding)\n' +
            '- Scaling their product range or entering new categories\n\n' +
            excludeList + '\n\n' +
            'Return exactly 8 brand suggestions.\n\n' +
            'Return valid JSON only. No preamble, no markdown fences. Begin with [ and end with ].\n' +
            '[\n' +
            '  {\n' +
            '    "brand_name": "string",\n' +
            '    "category": "string",\n' +
            '    "reason": "string (one sentence why this brand would benefit from Atelier\'s NPD and manufacturing platform)",\n' +
            '    "signal": "string (one key signal e.g. Recently launched at Mecca AU)"\n' +
            '  }\n' +
            ']'
        }
      ]
    })

    const rawText = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join('')

    const jsonMatch = rawText.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      return NextResponse.json({ error: 'Failed to generate suggestions' }, { status: 500 })
    }

    const newSuggestions = JSON.parse(jsonMatch[0])

    const reengageSuggestions = reengageBrands.map(r => ({
      brand_name: r.brand_name,
      category: 'Re-engagement',
      reason: `Last contacted ${Math.floor((Date.now() - new Date(r.last_contacted).getTime()) / (1000 * 60 * 60 * 24 * 30))} months ago — worth reaching out again.`,
      signal: 'Previously contacted · Due for follow-up',
      reengage: true,
      last_contacted: r.last_contacted
    }))

    return NextResponse.json({
      success: true,
      suggestions: newSuggestions,
      reengageSuggestions
    })

  } catch (error) {
    logSafeError('Suggestions error:', error)
    return NextResponse.json({ error: 'Failed to generate suggestions' }, { status: 500 })
  }
}