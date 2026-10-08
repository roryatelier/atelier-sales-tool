export interface LushaContact {
  contactId: string
  name: string
  role: string
  email: string
  phone: string
  linkedin: string
  verified: boolean
  department?: string
  jobTitle?: string
  seniority?: string
  canReveal?: { field: string; credits: number }[]
}
export interface RevealedEmail { email: string; type: string; confidence?: string }
export function validContactEmail(value: string): boolean {
  return /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(value)
}
export function mergeContacts<T extends { contactId?: string; email: string }>(previous: T[], incoming: T[]): T[] {
  const merged = new Map(previous.map(c => [c.contactId, c]))
  for (const contact of incoming) {
    const old = merged.get(contact.contactId)
    merged.set(contact.contactId, { ...old, ...contact, email: contact.email || old?.email || '' })
  }
  return [...merged.values()]
}
