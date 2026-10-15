export const CANONICAL_EMAIL_ROLES = [
  'General',
  'CEO',
  'CFO',
  'COO',
  'CMO',
  'Head of NPD',
  'Retailer'
] as const

export type CanonicalEmailRole = typeof CANONICAL_EMAIL_ROLES[number]

export function canonicaliseEmailRole(role: string): CanonicalEmailRole {
  const value = role.trim().toLowerCase()

  if (/\b(cfo|chief financial officer)\b|(?:vp|vice president)[,\s]+(?:of\s+)?finance|(?:finance|financial) director|(?:director|head)[,\s]+(?:of\s+)?finance/.test(value)) return 'CFO'
  if (/\b(coo|chief operating officer)\b|(?:vp|vice president)[,\s]+(?:of\s+)?operations|operations director|operational director|(?:director|head)[,\s]+(?:of\s+)?operations|supply chain|logistics/.test(value)) return 'COO'
  if (/\b(cmo|chief marketing officer)\b|product marketing|(?:vp|vice president)[,\s]+(?:of\s+)?marketing|marketing director|(?:director|head)[,\s]+(?:of\s+)?marketing|brand director|growth director/.test(value)) return 'CMO'
  if (/\b(ceo|chief executive officer)\b|\bco-?founder\b|\bfounder\b|\bowner\b|managing director|general manager/.test(value) || value === 'president') return 'CEO'
  if (/new product development|\bnpd\b|product development|innovation director|head of innovation|(?:vp|vice president)[,\s]+(?:of\s+)?product|chief product officer|product director|director[,\s]+(?:of\s+)?product/.test(value)) return 'Head of NPD'
  if (/\bbuyer\b|category manager|merchandis|private label|private brand|retail director/.test(value)) return 'Retailer'

  return 'General'
}
