import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'
import { generateStructured, publicProviderError } from '@/lib/openai'
import { isNonEmptyString, isRecord } from '@/lib/validation'

const ALL_ROLES: Record<string, string> = {
  CEO: 'topline revenue growth, speed to market, and competitive positioning',
  CFO: 'operating margin, cost efficiency, and ROI of outsourced manufacturing',
  COO: 'operational capacity, supply chain reliability, and scaling without headcount',
  CMO: 'launch cadence, trend responsiveness, and brand building through product innovation',
  'VP Product': 'scaling product development capacity without building in-house manufacturing',
  'VP Operations': 'operational efficiency, lead times, and supply chain reliability',
  'Head of NPD': 'formulation capabilities, SKU complexity, and bringing new products to market faster',
  'Head of Marketing': 'campaign-led product launches and speed to market'
}

function selectRoles(signals: { type: string; description: string }[], retailers: { name: string }[]): { roles: string[]; recommended: string } {
  const signalTypes = signals.map(s => s.type.toLowerCase())
  const signalText = signals.map(s => s.description).join(' ').toLowerCase()
  const retailerText = retailers.map(r => r.name).join(' ').toLowerCase()

  const scores: Record<string, number> = {
    'CEO': 1,
    'CFO': 0,
    'COO': 0,
    'CMO': 0,
    'VP Product': 0,
    'VP Operations': 0,
    'Head of NPD': 0,
    'Head of Marketing': 0
  }

  // Match on signal types directly
  if (signalTypes.some(t => ['npd_launch', 'npd', 'launch', 'product_launch', 'innovation'].includes(t))) {
    scores['Head of NPD'] += 5
    scores['VP Product'] += 3
  }
  if (signalTypes.some(t => ['acquisition', 'acqui', 'investment', 'funding', 'fund'].includes(t))) {
    scores['CEO'] += 5
    scores['CFO'] += 4
  }
  if (signalTypes.some(t => ['retail_expansion', 'retail_distribution', 'retail', 'expansion', 'distribution'].includes(t))) {
    scores['CMO'] += 4
    scores['Head of Marketing'] += 3
    scores['VP Operations'] += 2
  }
  if (signalTypes.some(t => ['hiring', 'vp_field_sales_hiring', 'sales_hiring', 'field_sales'].includes(t))) {
    scores['COO'] += 3
    scores['VP Operations'] += 4
  }
  if (signalTypes.some(t => ['partnership', 'partner'].includes(t))) {
    scores['CMO'] += 3
    scores['CEO'] += 1
  }
  if (signalTypes.some(t => ['growth', 'revenue', 'revenue_growth'].includes(t))) {
    scores['CFO'] += 4
    scores['CEO'] += 2
  }
  if (signalTypes.some(t => ['investment_history', 'pe_backing', 'vc'].includes(t))) {
    scores['CFO'] += 3
    scores['CEO'] += 2
  }

  // Fallback description text matching
  if (signalText.includes('launch') || signalText.includes('formul') || signalText.includes('innovat') || signalText.includes('sku')) {
    scores['Head of NPD'] += 2
    scores['VP Product'] += 1
  }
  if (signalText.includes('acqui') || signalText.includes('stake') || signalText.includes('invest')) {
    scores['CEO'] += 2
    scores['CFO'] += 2
  }
  if (signalText.includes('retail') || signalText.includes('mecca') || signalText.includes('sephora') || retailerText.length > 5) {
    scores['CMO'] += 2
    scores['Head of Marketing'] += 1
  }
  if (signalText.includes('manufactur') || signalText.includes('supply') || signalText.includes('capacity')) {
    scores['COO'] += 2
    scores['VP Operations'] += 2
  }
  if (signalText.includes('growth') || signalText.includes('margin') || signalText.includes('revenue')) {
    scores['CFO'] += 2
    scores['CEO'] += 1
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const top3 = sorted.slice(0, 3).map(([role]) => role)
  const recommended = top3[0]

  return { roles: top3, recommended }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const body = await request.json()
    const { dossier } = body

    if (!dossier) {
      return NextResponse.json({ error: 'dossier is required' }, { status: 400 })
    }

    const signals = (dossier.signals ?? []) as { type: string; description: string }[]
    const retailers = (dossier.retailers ?? []) as { name: string }[]
    const { roles, recommended } = selectRoles(signals, retailers)

    const signalText = signals
      .slice(0, 5)
      .map(s => `${s.type}: ${s.description.replace(/\*\*/g, '')}`)
      .join('\n')

    const retailerText = retailers.map(r => r.name).join(', ')

    const pitchAngles: Record<string, string[]> = {}

    await Promise.all(roles.map(async role => {
      const result = await generateStructured<{ bullets: [string, string, string] }>({
        prompt: `You are a B2B sales strategist for Atelier, a GenAI platform that streamlines end-to-end NPD and manufacturing for prestige beauty brands — enabling brands to launch products 6x faster, increase R&D SKU capacity by 10x, reduce the cost of innovation to near $0, and 2x operating profit margins, powered by 8.5M+ supply chain permutations.

Write a pitch angle for reaching out to the ${role} of ${dossier.brand_name}. Their primary concern is ${ALL_ROLES[role]}.

Brand context:
- Revenue: ${dossier.revenue_estimate ?? 'unknown'}
- ICP Score: ${dossier.icp_score} (${dossier.score_band})
- Retailers: ${retailerText}
- Key signals:
${signalText}

Return exactly 3 specific, concrete talking points tailored to this role's concerns.`,
        purpose: 'email',
        schemaName: 'role_pitch_angle',
        schema: { type: 'object', properties: { bullets: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } } }, required: ['bullets'], additionalProperties: false },
        validate: (value): value is { bullets: [string, string, string] } => isRecord(value) && Array.isArray(value.bullets)
          && value.bullets.length === 3 && value.bullets.every(isNonEmptyString),
        maxOutputTokens: 500,
        maxAttempts: 1
      })
      pitchAngles[role] = result.data.bullets
    }))

    return NextResponse.json({ success: true, pitchAngles, roles, recommended })

  } catch (error) {
    logSafeError('Pitch angle error:', error)
    const failure = publicProviderError(error)
    return NextResponse.json(failure.body, { status: failure.status })
  }
}
