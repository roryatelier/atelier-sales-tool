import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { researchWithOpenAI } from '@/lib/openai-research'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const result = await researchWithOpenAI<{ signals: Array<{ date?: string; source: string }> }>({
      prompt: `Search for 5 recent beauty industry news stories from the last 30 days. Return current, verifiable stories relevant to outreach for Atelier.

For each story provide:
{
    "brand": "brand name",
    "signal_type": "launch | funding | retail | expansion | celebrity | leadership | trend",
    "headline": "one sentence summary",
    "why_it_matters": "why this matters for a GenAI-powered NPD and manufacturing platform serving prestige beauty brands",
    "date": "Month Year",
    "source": "direct https URL for the story"
}`,
      schemaName: 'beauty_industry_signals',
      schema: {
        type: 'object',
        properties: {
          signals: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                brand: { type: 'string' },
                signal_type: { type: 'string', enum: ['launch', 'funding', 'retail', 'expansion', 'celebrity', 'leadership', 'trend'] },
                headline: { type: 'string' },
                why_it_matters: { type: 'string' },
                date: { type: 'string' },
                source: { type: 'string' }
              },
              required: ['brand', 'signal_type', 'headline', 'why_it_matters', 'date', 'source'],
              additionalProperties: false
            }
          }
        },
        required: ['signals'],
        additionalProperties: false
      },
      maxOutputTokens: 2000
    })

    const signals = result.data.signals

    signals.sort((a: { date?: string }, b: { date?: string }) => {
      const parse = (d?: string) => {
        if (!d) return null
        const dt = new Date(`1 ${d}`)
        return isNaN(dt.getTime()) ? null : dt
      }
      const da = parse(a.date)
      const db = parse(b.date)
      if (da && db) return db.getTime() - da.getTime()
      if (da) return -1
      if (db) return 1
      return 0
    })

    return NextResponse.json({ success: true, signals })

  } catch (error) {
    logSafeError('[competitor-signals] Unexpected error:', error)
    return NextResponse.json({ error: 'Failed to fetch industry signals', detail: String(error) }, { status: 500 })
  }
}
