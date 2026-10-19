import { renderEmailDocument } from './email-signature'

export interface EmailAttachment {
  name: string
  type: string
  data: string
}

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function foldBase64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]/g, '')
}

function addressList(value: string | undefined): string {
  if (!value) return ''
  return value.split(',').map(address => singleLine(address).trim()).filter(Boolean).join(', ')
}

export function buildHtmlEmailRaw(
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
  attachments?: EmailAttachment[],
): string {
  const ccAddresses = addressList(cc)
  const bccAddresses = addressList(bcc)
  const encodedSubject = `=?UTF-8?B?${Buffer.from(singleLine(subject), 'utf-8').toString('base64')}?=`
  const htmlBodyB64 = foldBase64(renderEmailDocument(body))
  const headers = [
    `To: ${singleLine(to)}`,
    ...(ccAddresses ? [`Cc: ${ccAddresses}`] : []),
    ...(bccAddresses ? [`Bcc: ${bccAddresses}`] : []),
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
  ]

  if (!attachments || attachments.length === 0) {
    return toBase64Url(Buffer.from([
      ...headers,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      htmlBodyB64,
    ].join('\r\n')))
  }

  const boundary = `----=_Boundary_${Date.now().toString(36)}`
  const parts: string[] = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    htmlBodyB64,
  ]

  for (const att of attachments) {
    const safeName = `=?UTF-8?B?${Buffer.from(singleLine(att.name), 'utf-8').toString('base64')}?=`
    const safeType = singleLine(att.type) || 'application/octet-stream'
    parts.push(
      `--${boundary}`,
      `Content-Type: ${safeType}; name="${safeName}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${safeName}"`,
      '',
      att.data.match(/.{1,76}/g)?.join('\r\n') ?? att.data,
    )
  }

  parts.push(`--${boundary}--`)
  return toBase64Url(Buffer.from(parts.join('\r\n')))
}
