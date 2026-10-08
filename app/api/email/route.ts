import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { generateEmailWithOpenAI, generatePitchWithOpenAI, type OpenAIUsage } from '@/lib/openai-email'
import { NextRequest, NextResponse } from 'next/server'

const MESSAGE_MATRIX: Record<string, { focus: string; proofPoints: string }> = {
  CFO: {
    focus: 'Cost reduction, margin improvement, and unit economics',
    proofPoints: '2x operating profit margins, reduce the cost of innovation to near $0'
  },
  COO: {
    focus: 'Operational efficiency, supply chain reliability, and scaling without headcount',
    proofPoints: 'Launch products 6x faster with no incremental headcount, bring unlimited products to market with no internal resource drain'
  },
  CMO: {
    focus: 'Speed to market, launch cadence, and trend responsiveness',
    proofPoints: 'Launch products 6x faster, increase product output by 10x'
  },
  CEO: {
    focus: 'Topline growth, competitive advantage, and speed and scale',
    proofPoints: 'Launch products 6x faster, increase product output by 10x, 2x operating profit margins'
  },
  'VP Product': {
    focus: 'Scaling product output without building internal manufacturing capacity',
    proofPoints: 'Increase product output by 10x, bring unlimited products to market with no internal resource drain'
  },
  'VP Marketing': {
    focus: 'Speed to market and launch cadence to stay ahead of trends',
    proofPoints: 'Launch products 6x faster, increase product output by 10x'
  },
  'VP Operations': {
    focus: 'Operational efficiency, supply chain reliability, and no headcount increase',
    proofPoints: 'Launch products 6x faster with no incremental headcount, bring unlimited products to market with no internal resource drain'
  },
  'Head of NPD': {
    focus: 'Formulation speed, SKU complexity, and manufacturing capabilities',
    proofPoints: 'Increase product output by 10x, launch products 6x faster, reduce the cost of innovation to near $0'
  },
  'Head of Marketing': {
    focus: 'Campaign-led product launches and speed to market',
    proofPoints: 'Launch products 6x faster, increase product output by 10x'
  }
}

function buildEmailPrompt(dossier: Record<string, unknown>, role: string, contactName: string, template?: { subject: string; body: string }, pitchBullet?: string, followUp?: { original_subject?: string; contact_name?: string; date_sent?: string }, senderName?: string): string {
  const matrix = MESSAGE_MATRIX[role] ?? MESSAGE_MATRIX['CEO']
  const retailers = (dossier.retailers as { name: string }[])?.map(r => r.name).join(', ') ?? 'Unknown'
  const signals = (dossier.signals as { type: string; description: string }[])
    ?.slice(0, 3)
    .map(s => s.type + ': ' + s.description.replace(/\*\*/g, ''))
    .join('\n') ?? ''

  const atelierDesc = "Atelier's GenAI platform streamlines the end-to-end NPD and manufacturing process, leveraging 8.5M+ supply chain permutations to match product specs with perfectly aligned manufacturer capabilities. For a single unit cost, brands receive finished product delivered directly into their DC, ready to sell."

  if (template) {
    return 'You are personalising a saved email template for a specific brand and contact on behalf of Atelier.\n\n' +
      'ABOUT ATELIER\n' +
      atelierDesc + '\n\n' +
      'SAVED TEMPLATE TO USE AS STYLE GUIDE:\n' +
      'Subject: ' + template.subject + '\n' +
      'Body:\n' + template.body + '\n\n' +
      'RECIPIENT\n' +
      'Name: ' + contactName + '\n' +
      'Role: ' + role + '\n' +
      'Brand: ' + dossier.brand_name + '\n' +
      'Revenue (estimated): ' + (dossier.revenue_estimate ?? 'Unknown') + '\n' +
      'Retail presence: ' + retailers + '\n\n' +
      'BRAND SIGNALS (weave at least two into the email)\n' +
      signals + '\n\n' +
      (pitchBullet ? 'PRIORITY TALKING POINT — weave this specific point naturally into the email:\n"' + pitchBullet + '"\n\n' : '') +
      'INSTRUCTIONS\n' +
      'Rewrite the template above for this specific brand and contact. Keep the same tone, structure, and length as the template — do not add or remove paragraphs, do not change the style. Replace any generic placeholders with real brand-specific facts from the signals above. Open with a specific buying signal from the brand. Address the recipient by first name. End with a soft CTA asking for a call. You MUST mention the brand name ' + dossier.brand_name + ' at least once in the email body.\n' +
      (senderName ? 'Sign off with "Thanks," or "Best," followed by the sender\'s name: ' + senderName + '. Do not include a position or title.' : 'Sign off with just "Thanks," with no name.') + '\n\n' +
      'OUTPUT FORMAT\n' +
      'Return valid JSON only. No preamble, no markdown fences. Begin with { and end with }.\n' +
      '{ "subject": "string", "body": "string" }'
  }

  return 'You are writing a cold outreach email on behalf of Atelier.\n\n' +
    'ABOUT ATELIER\n' +
    atelierDesc + '\n\n' +
    'RECIPIENT\n' +
    'Name: ' + contactName + '\n' +
    'Role: ' + role + '\n' +
    'Brand: ' + dossier.brand_name + '\n' +
    'Revenue (estimated): ' + (dossier.revenue_estimate ?? 'Unknown') + '\n' +
    'Retail presence: ' + retailers + '\n\n' +
    'BRAND SIGNALS (open with the strongest one as the reason for reaching out)\n' +
    signals + '\n\n' +
    'ROLE-SPECIFIC FOCUS\n' +
    'This executive\'s primary concern is: ' + matrix.focus + '\n' +
    'Use the most relevant 1-2 proof points from: ' + matrix.proofPoints + '\n\n' +
    (pitchBullet ? 'PRIORITY TALKING POINT — weave this specific point naturally into the email:\n"' + pitchBullet + '"\n\n' : '') +
    (followUp ? 'FOLLOW-UP CONTEXT — this is a follow-up email. The original email was sent on ' + (followUp.date_sent ?? 'a few days ago') + ' with subject "' + (followUp.original_subject ?? 'our previous email') + '". Do NOT repeat the same pitch. Reference the previous outreach briefly and offer a new angle or insight.\n\n' : '') +
    'EMAIL WRITING RULES:\n' +
    '1. Open with a specific buying signal — a recent launch, acquisition, campaign, retail expansion, or role change. Make it feel like you\'ve done your homework.\n' +
    '2. Tailor the message to the recipient\'s role — speak to what they care about: ' + matrix.focus + '\n' +
    '3. Weave in 1-2 relevant proof points naturally.\n' +
    '4. Address recipient by first name.\n' +
    '5. End with a soft CTA asking for a call.\n' +
    (senderName ? '6. Sign off with "Thanks," or "Best," followed by the sender\'s name: ' + senderName + '. Do not include a position or title.\n' : '6. Sign off with just "Thanks," with no name.\n') + '\n' +
    'TONE: Conversational but professional. Write like a human, not a press release. No bullet points. No jargon.\n' +
    'SUBJECT LINE: Specific and curiosity-driven. Reference the brand or a signal. Under 8 words.\n' +
    'REQUIREMENT: You MUST mention the brand name ' + dossier.brand_name + ' at least once in the email body.\n\n' +
    'OUTPUT FORMAT\n' +
    'Return valid JSON only. No preamble, no markdown fences. Begin with { and end with }.\n' +
    '{ "subject": "string", "body": "string" }'
}

function runTrustGate(body: string, dossier: Record<string, unknown>): boolean {
  const bodyLower = body.toLowerCase()
  const brandName = (dossier.brand_name as string)?.toLowerCase() ?? ''
  if (brandName.length <= 2) return true

  // Full brand name present
  if (bodyLower.includes(brandName)) return true

  // First word of brand name if longer than 4 chars
  const firstWord = brandName.split(/\s+/)[0]
  if (firstWord.length > 4 && bodyLower.includes(firstWord)) return true

  // Any retailer name from the dossier
  const retailers = (dossier.retailers as { name: string }[]) ?? []
  if (retailers.some(r => r.name && bodyLower.includes(r.name.toLowerCase()))) return true

  return false
}

async function generateOnce(prompt: string, dossier: Record<string, unknown>): Promise<{
  email: { subject: string; body: string } | null
  passed: boolean
  usage: OpenAIUsage
  error?: string
}> {
  try {
    const { email, usage } = await generateEmailWithOpenAI(prompt)
    return { email, passed: runTrustGate(email.body, dossier), usage }
  } catch (error) {
    logSafeError('OpenAI email generation error:', error)
    return {
      email: null,
      passed: false,
      usage: { inputTokens: 0, outputTokens: 0 },
      error: 'provider response unavailable'
    }
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const body = await request.json()

    if (body.pitch_only) {
      const dossier = body.dossier
      const signals = (dossier.signals ?? []).slice(0, 3).map((s: {description: string}) => s.description).join(' ')
      const pitch = await generatePitchWithOpenAI(`You are a B2B sales strategist for Atelier, a GenAI platform that streamlines end-to-end NPD and manufacturing for prestige beauty brands — enabling brands to launch products 6x faster, increase R&D SKU capacity by 10x, reduce the cost of innovation to near $0, and 2x operating profit margins. Based on this brand research, write 2-3 sentences suggesting the best pitch angle for outreach. Be specific — reference actual signals, retailers, and growth indicators. Write in second person as if briefing a sales rep. Brand: ${dossier.brand_name}. ICP Score: ${dossier.icp_score} (${dossier.score_band}). Revenue: ${dossier.revenue_estimate ?? 'unknown'}. Retailers: ${(dossier.retailers ?? []).map((r: {name: string}) => r.name).join(', ')}. Key signals: ${signals}. Write only the pitch angle sentences. No preamble.`)
      return NextResponse.json({ success: true, pitch_angle: pitch })
    }

    const { dossier, role, contact_name, template, pitch_bullet, follow_up, sender_name } = body

    if (!dossier || !role || !contact_name) {
      return NextResponse.json(
        { error: 'dossier, role, and contact_name are required' },
        { status: 400 }
      )
    }

    const prompt = buildEmailPrompt(dossier, role, contact_name, template, pitch_bullet, follow_up, sender_name || undefined)

    let result = await generateOnce(prompt, dossier)
    let totalInputTokens = result.usage.inputTokens
    let totalOutputTokens = result.usage.outputTokens
    console.log('Email generation attempt 1 tokens:', result.usage, 'trust gate passed:', result.passed)

    if (result.error) {
      return NextResponse.json({ error: 'Email generation failed — ' + result.error }, { status: 500 })
    }

    if (!result.passed) {
      console.log('Trust gate failed on attempt 1, retrying silently...')
      const retry = await generateOnce(prompt, dossier)
      totalInputTokens += retry.usage.inputTokens
      totalOutputTokens += retry.usage.outputTokens
      console.log('Email generation attempt 2 tokens:', retry.usage, 'trust gate passed:', retry.passed)
      if (!retry.error) result = retry
    }

    console.log('Total email generation tokens:', { inputTokens: totalInputTokens, outputTokens: totalOutputTokens })

    if (!result.passed) {
      return NextResponse.json({
        success: false,
        warning: 'Insufficient brand data to personalise — verify research and retry.'
      })
    }

    return NextResponse.json({ success: true, email: result.email })

  } catch (error) {
    logSafeError('Email route error:', error)
    return NextResponse.json(
      { error: 'Email generation failed' },
      { status: 500 }
    )
  }
}
