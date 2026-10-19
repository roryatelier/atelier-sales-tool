export const SIGNATURE_MAX_LENGTH = 4000

export interface SignaturePart {
  type: 'text' | 'link'
  text: string
  href?: string
}

const MARKDOWN_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g

export function signatureFromUnknown(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function normaliseSignature(signature: unknown): string {
  if (typeof signature !== 'string') return ''
  return signature.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\n+/, '').replace(/\s+$/g, '')
}

export function safeSignatureHref(url: string): string | null {
  if (!url || /[\u0000-\u0020\u007f-\u009f]/.test(url) || /\s/.test(url)) return null
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return null
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') return parsed.href
  } catch {
    return null
  }
  return null
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

export function renderEmailHtml(value: unknown): string {
  const text = signatureFromUnknown(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = escapeHtml(text).split('\n')
  const processed: string[] = []
  let inList = false

  for (const line of lines) {
    const bulletMatch = line.match(/^\s*- (.+)/)
    if (bulletMatch) {
      if (!inList) { processed.push('<ul style="margin:8px 0;padding-left:20px;">'); inList = true }
      processed.push(`<li>${bulletMatch[1]}</li>`)
    } else {
      if (inList) { processed.push('</ul>'); inList = false }
      processed.push(line)
    }
  }
  if (inList) processed.push('</ul>')

  let html = processed.join('\n')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
    const safe = safeSignatureHref(unescapeHtml(href))
    if (!safe) return match
    return `<a href="${escapeHtml(safe)}" style="color:#050849;">${label}</a>`
  })
  html = html.replace(/\n/g, '<br>')
  html = html.replace(/<br>(<\/?ul>|<li>)/g, '$1')
  html = html.replace(/(<\/ul>|<\/li>)<br>/g, '$1')
  return html
}

export function renderEmailDocument(value: unknown): string {
  return `<html><body style="font-family:sans-serif;font-size:14px;line-height:1.6;">${renderEmailHtml(value)}</body></html>`
}

export function signatureParts(value: unknown): SignaturePart[] {
  const text = signatureFromUnknown(value).replace(/\r\n/g, '\n')
  const parts: SignaturePart[] = []
  const re = new RegExp(MARKDOWN_LINK.source, 'g')
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) })
    const href = safeSignatureHref(match[2])
    parts.push(href ? { type: 'link', text: match[1], href } : { type: 'text', text: match[0] })
    last = match.index + match[0].length
  }
  if (last < text.length || parts.length === 0) parts.push({ type: 'text', text: text.slice(last) })
  return parts
}

function lineKey(line: string): string {
  return line.replace(/[\t \u00a0]+$/g, '')
}

export function removeTrailingSignature(body: unknown, signature: unknown): string {
  const source = signatureFromUnknown(body)
  const sigLines = normaliseSignature(signature).split('\n').map(lineKey)
  if (!source || sigLines.every(line => line === '')) return source
  const lines = source.split(/\r\n|\r|\n/)
  let end = lines.length
  while (end > 0 && lineKey(lines[end - 1]) === '') end -= 1
  let removed = false
  while (end >= sigLines.length) {
    const start = end - sigLines.length
    if (!sigLines.every((line, index) => lineKey(lines[start + index]) === line)) break
    end = start
    removed = true
    while (end > 0 && lineKey(lines[end - 1]) === '') end -= 1
  }
  if (!removed) return source
  return lines.slice(0, end).join('\n').replace(/\s+$/g, '')
}

export function appendSignature(body: unknown, signature: unknown): string {
  const source = signatureFromUnknown(body)
  const sig = normaliseSignature(signature)
  if (!sig) return source
  const base = removeTrailingSignature(source, sig)
  if (!base) return sig
  const normalisedBase = base.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/g, '')
  return `${normalisedBase}\n\n${sig}`
}
