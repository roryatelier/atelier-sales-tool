import 'server-only'
import { validContactEmail, type LushaContact, type RevealedEmail } from './lusha-contact'

export class LushaError extends Error {
  constructor(public code: string, public httpStatus: number, message: string) { super(message) }
}
export function normalizeDomain(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new LushaError('invalid_domain', 400, 'Enter the company website or domain.')
  try {
    const url = new URL(value.trim().includes('://') ? value.trim() : 'https://' + value.trim())
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host) || host.endsWith('.localhost')) throw new Error('Invalid domain')
    return host
  } catch { throw new LushaError('invalid_domain', 400, 'Enter a valid public company domain.') }
}
async function provider(path: string, body: unknown, paid: boolean): Promise<Record<string, unknown>> {
  const key = process.env.LUSHA_API_KEY
  if (!key) throw new LushaError('configuration', 503, 'Contact lookup is not configured. Ask an administrator.')
  let response: Response
  try {
    response = await fetch('https://api.lusha.com/v3/contacts/' + path, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', api_key: key }, body: JSON.stringify(body) })
  } catch { throw new LushaError(paid ? 'ambiguous' : 'failed', 504, paid ? 'Reveal outcome is unknown. Another attempt may use credits again; enter an address manually or check Lusha before retrying.' : 'Contact lookup could not complete. Try again.') }
  if (!response.ok) {
    if (response.status === 402) throw new LushaError('needs_credits', 409, 'Lusha credits are exhausted. Ask an administrator.')
    if (response.status === 429) throw new LushaError('rate_limited', 429, 'Lusha is rate limited. Wait before trying again.')
    if ([401,403].includes(response.status)) throw new LushaError('provider_auth', 502, 'Lusha access needs administrator attention.')
    throw new LushaError('failed', 502, paid ? 'Lusha could not complete this reveal. Do not retry automatically; another attempt may use credits.' : 'Lusha contact lookup failed. Try again later.')
  }
  try { const data = await response.json(); if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error(); return data } catch { throw new LushaError(paid ? 'ambiguous' : 'failed', 502, 'Lusha returned an invalid response. Do not repeat a paid reveal automatically.') }
}
export async function searchContacts(domain: string, page: number, size: number) {
  const data = await provider('prospecting', { pagination: { page, size }, filters: { companies: { include: { domains: [domain] } } }, options: { includePartialProfiles: true } }, false)
  if (['OUT_OF_CREDITS','PARTIAL_OUT_OF_CREDITS'].includes(data.status as string)) throw new LushaError('needs_credits',409,'Lusha credits are unavailable. Ask an administrator.')
  if (!Array.isArray(data.results)) throw new LushaError('failed', 502, 'Lusha returned an invalid contact list.')
  const contacts: LushaContact[] = data.results.map((value: Record<string, unknown>) => {
    if (!value || typeof value.id !== 'string' || !value.id) throw new LushaError('failed',502,'Lusha returned a contact without an ID.')
    const title = (value.jobTitle ?? {}) as { title?: string; seniority?: string; departments?: string[] }
    return { contactId: value.id, name: [value.firstName,value.lastName].filter(v => typeof v === 'string').join(' '), role: title.title || title.seniority || '', email: '', phone: '', verified: false, linkedin: (value.socialLinks as { linkedin?: string })?.linkedin ?? '', department: title.departments?.[0] ?? 'Other', jobTitle: title.title, seniority: title.seniority, canReveal: Array.isArray(value.canReveal) ? value.canReveal : [] }
  })
  const meta = data.pagination as { total?: number; totalGuaranteed?: boolean } | undefined
  const total = typeof meta?.total === 'number' && Number.isFinite(meta.total) && meta.total >= 0 ? meta.total : undefined
  const hasMore = contacts.length > 0 && page < 1000 && (meta?.totalGuaranteed === true && total !== undefined ? (page + 1) * size < total : true)
  return { success: true, status: contacts.length ? 'complete' : 'empty', contacts, page, nextPage: hasMore ? page + 1 : null, hasMore, total, totalGuaranteed: meta?.totalGuaranteed === true, domain }
}
export async function revealContact(id: string) {
  const data = await provider('enrich', { ids: [id], reveal: ['emails'], waterfallEnabled: false }, true)
  const contact = Array.isArray(data.results) ? data.results.find((v: { id?: string }) => v?.id === id) : undefined
  const emails: RevealedEmail[] = Array.isArray(contact?.emails) ? contact.emails.filter((v: RevealedEmail) => v && typeof v.email === 'string' && validContactEmail(v.email)).map((v: RevealedEmail) => ({ email: v.email, type: ['work','private'].includes(v.type) ? v.type : 'unknown', ...(typeof v.confidence === 'string' ? { confidence: v.confidence } : {}) })) : []
  const work = emails.find(v => v.type === 'work')
  if (work) return { success: true, status: 'revealed', email: work.email, emails, phone: '', verified: false }
  if (emails.length) return { success: true, status: 'choose_email', email: '', emails, phone: '', verified: false }
  if (['OUT_OF_CREDITS','PARTIAL_OUT_OF_CREDITS'].includes(data.status as string) || contact?.missingDataPoints?.some((v: { status?: string }) => v.status === 'BILLING_FAILED')) throw new LushaError('needs_credits',409,'Lusha could not reveal this email because credits are unavailable.')
  if (data.job) return { success: false, status: 'pending', error: 'This contact needs asynchronous enrichment, which is not supported in this release. Enter an address manually; do not reveal again automatically.' }
  if (contact?.error) throw new LushaError('failed',502,'Lusha could not reveal this contact. Enter a known address manually.')
  if (!contact) throw new LushaError('failed',502,'Lusha did not return the requested contact.')
  return { success: false, status: 'unavailable', error: 'No email is available from Lusha. Enter a known address manually.' }
}
