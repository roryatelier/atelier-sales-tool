import { normaliseBrandName, isVercel, getLocalDb } from './db'
import { researchWithOpenAI } from './openai-research'
import { isNonEmptyString, isRecord } from './validation'

const RATE_PER_MILLION_INPUT = 3.00
const RATE_PER_MILLION_OUTPUT = 15.00

type ResearchDossier = {
  score_breakdown?: Record<string, number>
  icp_score?: number
  score_band?: string
  [key: string]: unknown
}

export async function researchBrand(brandName: string) {
  const normalised = normaliseBrandName(brandName)

  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    const cached = await sql`SELECT dossier_json FROM dossiers WHERE brand_name_normalised = ${normalised}`
    if (cached.rows.length > 0) return JSON.parse(cached.rows[0].dossier_json)
  } else {
    const db = getLocalDb()
    const cached = db.prepare('SELECT dossier_json FROM dossiers WHERE brand_name_normalised = ?').get(normalised) as { dossier_json: string } | undefined
    if (cached) return JSON.parse(cached.dossier_json)
  }

  const prompt = buildResearchPrompt(brandName)

  const response = await researchWithOpenAI<ResearchDossier>({
    prompt,
    schemaName: 'brand_qualification_dossier',
    schema: BRAND_DOSSIER_SCHEMA,
    validate: isResearchDossier,
    maxOutputTokens: 4000
  })

  const inputTokens = response.usage.inputTokens
  const outputTokens = response.usage.outputTokens
  const estimatedCost =
    (inputTokens / 1_000_000) * RATE_PER_MILLION_INPUT +
    (outputTokens / 1_000_000) * RATE_PER_MILLION_OUTPUT

  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    await sql`INSERT INTO usage_log (brand_name, call_type, input_tokens, output_tokens, rate_per_million_input, rate_per_million_output, estimated_cost_usd) VALUES (${brandName}, 'research', ${inputTokens}, ${outputTokens}, ${RATE_PER_MILLION_INPUT}, ${RATE_PER_MILLION_OUTPUT}, ${estimatedCost})`
  } else {
    const db = getLocalDb()
    db.prepare('INSERT INTO usage_log (brand_name, call_type, input_tokens, output_tokens, rate_per_million_input, rate_per_million_output, estimated_cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)').run(brandName, 'research', inputTokens, outputTokens, RATE_PER_MILLION_INPUT, RATE_PER_MILLION_OUTPUT, estimatedCost)
  }

  const dossier = response.data

  const maxScores: Record<string, number> = {
    annual_revenue: 35,
    retail_distribution: 20,
    order_viability: 20,
    product_category: 15,
    market_presence: 10
  }

  if (dossier.score_breakdown) {
    let total = 0
    for (const key of Object.keys(maxScores)) {
      dossier.score_breakdown[key] = Math.min(dossier.score_breakdown[key] ?? 0, maxScores[key])
      total += dossier.score_breakdown[key]
    }
    dossier.icp_score = total
    if (total >= 80) dossier.score_band = 'Hot'
    else if (total >= 60) dossier.score_band = 'Warm'
    else if (total >= 40) dossier.score_band = 'Watch'
    else dossier.score_band = 'Pass'
  }

  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    await sql`INSERT INTO dossiers (brand_name, brand_name_normalised, dossier_json) VALUES (${brandName}, ${normalised}, ${JSON.stringify(dossier)}) ON CONFLICT(brand_name_normalised) DO UPDATE SET dossier_json = ${JSON.stringify(dossier)}, updated_at = NOW()`
  } else {
    const db = getLocalDb()
    db.prepare('INSERT INTO dossiers (brand_name, brand_name_normalised, dossier_json) VALUES (?, ?, ?) ON CONFLICT(brand_name_normalised) DO UPDATE SET dossier_json = excluded.dossier_json, updated_at = datetime(\'now\')').run(brandName, normalised, JSON.stringify(dossier))
  }

  return dossier
}

function isResearchDossier(value: unknown): value is ResearchDossier {
  if (!isRecord(value) || !isNonEmptyString(value.brand_name)) return false
  if (!isRecord(value.score_breakdown) || typeof value.icp_score !== 'number') return false
  return ['Hot', 'Warm', 'Watch', 'Pass'].includes(String(value.score_band))
    && Array.isArray(value.retailers)
    && Array.isArray(value.signals)
    && Array.isArray(value.competitors)
}

const nullableString = { type: ['string', 'null'] }

const BRAND_DOSSIER_SCHEMA = {
  type: 'object',
  properties: {
    brand_name: { type: 'string' },
    website: nullableString,
    revenue_estimate: nullableString,
    revenue_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    revenue_source: nullableString,
    retailers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          source: { type: 'string' }
        },
        required: ['name', 'confidence', 'source'],
        additionalProperties: false
      }
    },
    markets: { type: 'array', items: { type: 'string' } },
    category: { type: 'string' },
    sku_count_estimate: nullableString,
    signals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          description: { type: 'string' },
          source: { type: 'string' }
        },
        required: ['type', 'description', 'source'],
        additionalProperties: false
      }
    },
    icp_score: { type: 'number' },
    score_breakdown: {
      type: 'object',
      properties: {
        annual_revenue: { type: 'number' },
        retail_distribution: { type: 'number' },
        market_presence: { type: 'number' },
        product_category: { type: 'number' },
        order_viability: { type: 'number' }
      },
      required: ['annual_revenue', 'retail_distribution', 'market_presence', 'product_category', 'order_viability'],
      additionalProperties: false
    },
    score_explanations: {
      type: 'object',
      properties: {
        annual_revenue: { type: 'string' },
        retail_distribution: { type: 'string' },
        market_presence: { type: 'string' },
        product_category: { type: 'string' },
        order_viability: { type: 'string' }
      },
      required: ['annual_revenue', 'retail_distribution', 'market_presence', 'product_category', 'order_viability'],
      additionalProperties: false
    },
    score_band: { type: 'string', enum: ['Hot', 'Warm', 'Watch', 'Pass'] },
    data_quality: { type: 'string', enum: ['sufficient', 'insufficient'] },
    competitors: { type: 'array', items: { type: 'string' } }
  },
  required: ['brand_name', 'website', 'revenue_estimate', 'revenue_confidence', 'revenue_source', 'retailers', 'markets', 'category', 'sku_count_estimate', 'signals', 'icp_score', 'score_breakdown', 'score_explanations', 'score_band', 'data_quality', 'competitors'],
  additionalProperties: false
}

function buildResearchPrompt(brandName: string): string {
  return 'You are a sales intelligence analyst for Atelier, a GenAI platform that streamlines end-to-end NPD and manufacturing for prestige beauty, skincare, haircare and wellness brands — enabling brands to launch products 6x faster, increase R&D SKU capacity by 10x, reduce the cost of innovation to near $0, and 2x operating profit margins.\n\n' +
    'Research this brand and return a qualification dossier. Use web search to find current data.\n\n' +
    'Brand: ' + brandName + '\n\n' +
    'Search for: revenue, prestige retailers (Mecca, Sephora, David Jones, Net-a-Porter), funding, NPD hiring, recent launches, ANZ market presence, 2-3 direct competitor brands, and any celebrity/influencer/model founders or backers.\n\n' +
    'Only include retailers with direct evidence. Convert all revenue to AUD. If revenue unverifiable, return null.\n\n' +
    'SCORING (max points):\n' +
    '1. Annual Revenue (35): $200M+=35, $100-199M=28, $50-99M=21, $20-49M=10, under $20M=0\n' +
    '2. Retail Distribution (20): 3+ prestige retailers globally=20, 2 prestige retailers=14, 1 prestige retailer or strong mass market presence=7, DTC only or no confirmed retail=0. Prestige retailers include: Sephora, Mecca, Ulta, Net-a-Porter, Harrods, Selfridges, Space NK, David Jones, ADORE Beauty, Revolve, Nordstrom. Mass market retailers (Chemist Warehouse, Coles, Target) count as partial fit.\n' +
    '3. Order Viability (20): doors(8) + funding signals(7) + NPD/launches(5). Celebrity or influencer-founded brands with retail traction should score high on order viability.\n' +
    '4. Product Category (15): skincare/haircare/colour/body=15, wellness/fragrance=10, adjacent=5, other=0\n' +
    '5. Market Presence (10): Present in 4+ international markets=10, present in 2-3 international markets=7, present in 1 international market=4, domestic only or no confirmed presence=0\n\n' +
    'Bands: 80-100 Hot, 60-79 Warm, 40-59 Watch, 0-39 Pass\n\n' +
    'Return valid JSON only, no preamble:\n' +
    '{"brand_name":"string","website":"string|null","revenue_estimate":"string|null","revenue_confidence":"high|medium|low","revenue_source":"string|null","retailers":[{"name":"string","confidence":"high|medium|low","source":"string"}],"markets":["string"],"category":"string","sku_count_estimate":"string|null","signals":[{"type":"string","description":"string (use **asterisks** around key facts)","source":"string"}],"icp_score":number,"score_breakdown":{"annual_revenue":number,"retail_distribution":number,"market_presence":number,"product_category":number,"order_viability":number},"score_explanations":{"annual_revenue":"string","retail_distribution":"string","market_presence":"string","product_category":"string","order_viability":"string"},"score_band":"Hot|Warm|Watch|Pass","data_quality":"sufficient|insufficient","competitors":["string (2-3 direct competitor brand names)"]}'
}
