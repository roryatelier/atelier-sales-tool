import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'
import { publicProviderError, researchStructured } from '@/lib/openai'
import { isNonEmptyString, isRecord } from '@/lib/validation'

type RecentNews = { has_recent_news: boolean; news_summary: string | null; news_urgency: 'high' | 'medium' | 'low'; days_old: number | null }

function getBestDay(): { day: string; date: string; reason: string } {
  const today = new Date()
  const dayOfWeek = today.getDay()

  let daysToAdd = 0
  if (dayOfWeek === 0) daysToAdd = 2
  else if (dayOfWeek === 1) daysToAdd = 1
  else if (dayOfWeek === 2) daysToAdd = 0
  else if (dayOfWeek === 3) daysToAdd = 0
  else if (dayOfWeek === 4) daysToAdd = 0
  else if (dayOfWeek === 5) daysToAdd = 4
  else if (dayOfWeek === 6) daysToAdd = 3

  const bestDay = new Date(today)
  bestDay.setDate(today.getDate() + daysToAdd)

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  const dayName = daysToAdd === 0 ? 'Today' : daysToAdd === 1 ? 'Tomorrow' : dayNames[bestDay.getDay()]
  const dateStr = `${dayNames[bestDay.getDay()]} ${bestDay.getDate()} ${monthNames[bestDay.getMonth()]}`
  const reason = daysToAdd === 0
    ? 'Today is a high-performing B2B outreach day'
    : daysToAdd === 1
    ? 'Tomorrow is a high-performing B2B outreach day'
    : 'Tuesday–Thursday have 40% higher B2B email open rates'

  return { day: dayName, date: dateStr, reason }
}

function getDaysSinceContact(lastContacted?: string): number {
  if (!lastContacted) return 999
  const parts = lastContacted.split('/')
  if (parts.length !== 3) return 999
  const date = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`)
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const body = await request.json()
    const { dossier, last_contacted } = body

    if (!dossier) return NextResponse.json({ error: 'dossier is required' }, { status: 400 })

    const signals = (dossier.signals ?? []) as { type: string; description: string }[]
    const { day, date, reason } = getBestDay()
    const daysSinceContact = getDaysSinceContact(last_contacted)

    let recentNews: RecentNews = {
      has_recent_news: false,
      news_summary: null,
      news_urgency: 'low',
      days_old: null
    }
    let researchStatus: 'complete' | 'unavailable' = 'complete'
    let warning: ReturnType<typeof publicProviderError>['body']['error'] | undefined
    try {
      const result = await researchStructured<RecentNews>({
        prompt: `Search for any news about ${dossier.brand_name} in the last 14 days. Look for product launches, funding announcements, retail partnerships, leadership changes, or supply chain news. Report the most recent relevant item, or state that none was found.`,
        schemaName: 'recent_brand_news',
        schema: { type: 'object', properties: {
          has_recent_news: { type: 'boolean' }, news_summary: { type: ['string', 'null'] }, news_urgency: { type: 'string', enum: ['high', 'medium', 'low'] }, days_old: { type: ['number', 'null'] }
        }, required: ['has_recent_news', 'news_summary', 'news_urgency', 'days_old'], additionalProperties: false },
        validate: (value): value is RecentNews => isRecord(value)
          && typeof value.has_recent_news === 'boolean'
          && (value.news_summary === null || isNonEmptyString(value.news_summary))
          && ['high', 'medium', 'low'].includes(String(value.news_urgency))
          && (value.days_old === null || (typeof value.days_old === 'number' && value.days_old >= 0)),
        maxOutputTokens: 500
      })
      recentNews = result.data
    } catch (error) {
      logSafeError('Outreach news research degraded:', error)
      researchStatus = 'unavailable'
      warning = publicProviderError(error).body.error
    }

    // Determine urgency combining signals + recent news + days since contact
    const hasStrongSignal = signals.some(s =>
      ['acquisition', 'funding', 'npd_launch', 'retail_expansion', 'investment'].includes(s.type)
    )

    let urgency: 'high' | 'medium' | 'low' = 'low'
    let urgency_reason = 'No urgent triggers — standard outreach timing applies'
    let within_hours: number | null = null

    if (recentNews.has_recent_news && recentNews.news_urgency === 'high') {
      urgency = 'high'
      urgency_reason = `Recent news detected — ${recentNews.news_summary ?? 'act while signals are fresh'}`
      within_hours = 48
    } else if (recentNews.has_recent_news && recentNews.news_urgency === 'medium') {
      urgency = 'high'
      urgency_reason = `Recent activity detected — ${recentNews.news_summary ?? 'good moment to reach out'}`
      within_hours = 72
    } else if (hasStrongSignal) {
      urgency = 'medium'
      urgency_reason = 'Active buying signals in dossier — strong outreach opportunity'
    } else if (daysSinceContact > 14) {
      urgency = 'medium'
      urgency_reason = `Not contacted in ${daysSinceContact} days — good time to re-engage`
    }

    const strongSignalTypes = ['acquisition', 'funding', 'npd_launch', 'retail_expansion', 'investment']
    const strongSignal = signals.find(s => strongSignalTypes.includes(s.type))
    const signalContext = recentNews.news_summary ?? (strongSignal
      ? strongSignal.description.replace(/\*\*/g, '').split('.')[0].trim()
      : null)

    return NextResponse.json({
      success: true,
      timing: {
        recommended_day: day,
        recommended_date: date,
        day_reason: reason,
        urgency,
        urgency_reason,
        signal_context: signalContext,
        within_hours,
        recent_news: recentNews.has_recent_news ? recentNews.news_summary : null,
        research_status: researchStatus
      },
      ...(warning ? { warning } : {})
    })

  } catch (error) {
    logSafeError('Outreach timing error:', error)
    const failure = publicProviderError(error)
    return NextResponse.json(failure.body, { status: failure.status })
  }
}
