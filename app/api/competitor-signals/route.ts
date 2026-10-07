import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5
      }],
      messages: [{
        role: 'user',
        content: `Search for 5 recent beauty industry news stories from the last 30 days. For each story return a JSON object. Respond with a JSON array only — no markdown, no explanation, just the raw JSON array.

[
  {
    "brand": "brand name",
    "signal_type": "launch | funding | retail | expansion | celebrity | leadership | trend",
    "headline": "one sentence summary",
    "why_it_matters": "why this matters for a GenAI-powered NPD and manufacturing platform serving prestige beauty brands",
    "date": "Month Year"
  }
]`
      }]
    }

    console.log('[competitor-signals] Sending request to Claude API')

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    })

    console.log('[competitor-signals] Claude API status:', res.status)

    const data = await res.json()
    console.log('[competitor-signals] Claude API response:', JSON.stringify(data).slice(0, 500))

    if (!res.ok) {
      logSafeError('[competitor-signals] API error:', data)
      return NextResponse.json({ error: 'Claude API error', detail: data }, { status: 500 })
    }

    const rawText = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('')

    console.log('[competitor-signals] Raw text from Claude:', rawText.slice(0, 1000))

    const jsonMatch = rawText.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      console.warn('[competitor-signals] No JSON array found in response, returning raw text for debugging')
      return NextResponse.json({ success: false, signals: [], rawText })
    }

    let signals
    try {
      signals = JSON.parse(jsonMatch[0])
    } catch (parseError) {
      logSafeError('[competitor-signals] JSON parse error:', parseError)
      return NextResponse.json({ success: false, signals: [], rawText, parseError: String(parseError) })
    }

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

    console.log('[competitor-signals] Returning', signals.length, 'signals')
    return NextResponse.json({ success: true, signals })

  } catch (error) {
    logSafeError('[competitor-signals] Unexpected error:', error)
    return NextResponse.json({ error: 'Failed to fetch industry signals', detail: String(error) }, { status: 500 })
  }
}
