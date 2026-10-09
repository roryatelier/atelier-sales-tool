import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextResponse } from 'next/server'
import { publicProviderError, researchStructured } from '@/lib/openai'
import { isNonEmptyString, isRecord } from '@/lib/validation'

export async function GET(request: Request) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const result = await researchStructured<{ signals: Array<Record<string, string>> }>({
      prompt: `You are a supply chain and trade analyst for Atelier, a GenAI platform that streamlines end-to-end NPD and manufacturing for prestige beauty brands — with 8.5M+ supply chain permutations matching product specs to manufacturer capabilities globally.

Search for the latest global signals from the last 30 days that are relevant to beauty manufacturing and supply chains.

Look for:
- US/China/EU tariff changes affecting beauty or consumer goods manufacturing
- Shipping disruptions, port strikes, or logistics cost changes
- Raw material shortages or price changes (packaging, ingredients, plastics)
- Regulatory changes affecting cosmetics manufacturing (TGA, FDA, EU)
- Currency fluctuations affecting import/export costs for AU brands
- Any major supply chain disruptions affecting global beauty brands

For each signal explain why it creates an outreach opportunity for Atelier — specifically how Atelier's platform can help brands launch faster, reduce innovation costs, or scale SKU capacity in response to the disruption.

Return exactly 4 signals.`,
      schemaName: 'market_pulse_signals',
      schema: { type: 'object', properties: { signals: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'object', properties: {
        title: { type: 'string' }, signal_type: { type: 'string', enum: ['tariff', 'shipping', 'materials', 'regulatory', 'currency', 'disruption'] }, summary: { type: 'string' }, outreach_angle: { type: 'string' }, urgency: { type: 'string', enum: ['high', 'medium', 'low'] }, date: { type: 'string' }
      }, required: ['title', 'signal_type', 'summary', 'outreach_angle', 'urgency', 'date'], additionalProperties: false } } }, required: ['signals'], additionalProperties: false },
      validate: (value): value is { signals: Array<Record<string, string>> } => isRecord(value) && Array.isArray(value.signals)
        && value.signals.length === 4
        && value.signals.every(signal => isRecord(signal) && ['title', 'signal_type', 'summary', 'outreach_angle', 'urgency', 'date'].every(key => isNonEmptyString(signal[key]))),
      maxOutputTokens: 1500
    })
    return NextResponse.json({ success: true, signals: result.data.signals })

  } catch (error) {
    logSafeError('Market pulse error:', error)
    const failure = publicProviderError(error)
    return NextResponse.json(failure.body, { status: failure.status })
  }
}
