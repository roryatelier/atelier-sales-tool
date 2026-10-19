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
  return signature.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/g, '')
}

export function safeSignatureHref(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') return url
  } catch {
    return null
  }
  return null
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

export function removeTrailingSignature(body: unknown, signature: unknown): string {
  const source = signatureFromUnknown(body).replace(/\r\n/g, '\n')
  const sig = normaliseSignature(signature)
  if (!sig) return signatureFromUnknown(body)
  const trimmed = source.replace(/\s+$/g, '')
  if (trimmed === sig) return ''
  const marker = `\n${sig}`
  if (!trimmed.endsWith(marker)) return source.replace(/\s+$/g, '')
  return trimmed.slice(0, trimmed.length - marker.length).replace(/\s+$/g, '')
}

export function appendSignature(body: unknown, signature: unknown): string {
  const source = signatureFromUnknown(body)
  const sig = normaliseSignature(signature)
  if (!sig) return source
  const base = removeTrailingSignature(source, sig)
  if (!base) return sig
  return `${base}\n\n${sig}`
}
