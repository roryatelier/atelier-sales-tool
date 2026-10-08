'use client'
import { useRef, useState, useEffect, useCallback } from 'react'
import { activeStorageOwner, matchesDraftIdentity } from '@/lib/browser-storage'
import { mergeContacts, validContactEmail, type LushaContact, type RevealedEmail } from '@/lib/lusha-contact'

export function useLushaContacts(knownContact?: {contactId?: string;email:string} | null) {
  const [contacts, setContacts] = useState<LushaContact[]>([])
  const [domain, setDomain] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [nextPage, setNextPage] = useState<number | null>(null)
  const [revealing, setRevealing] = useState<string[]>([])
  const [revealErrors, setRevealErrors] = useState<Record<string,string>>({})
  const [choices, setChoices] = useState<Record<string,RevealedEmail[]>>({})
  const generation = useRef(0)
  const query = useRef({ domain: '', owner: '', fingerprint: '' })
  const busy = useRef(false)
  const revealBusy = useRef(new Set<string>())
  useEffect(() => () => { generation.current++ }, [])

  const reset = useCallback(() => {
    generation.current++; busy.current = false; revealBusy.current.clear()
    setContacts([]); setNextPage(null); setLoading(false); setRevealing([]); setChoices({}); setRevealErrors({}); setError('')
  }, [])
  const knownId = knownContact?.contactId, knownEmail = knownContact?.email
  const search = useCallback(async (value: string, page = 0) => {
    if (page > 0 && busy.current) return
    if (page === 0) {
      const sameDomain = value === query.current.domain
      generation.current++
      query.current = { domain: value, owner: activeStorageOwner() ?? '', fingerprint: '' }
      setDomain(value); if (!sameDomain) setContacts([]); setNextPage(null); setChoices({}); setRevealErrors({}); setRevealing([]); revealBusy.current.clear()
    }
    const version = generation.current
    const owner = query.current.owner
    const current = () => version === generation.current && matchesDraftIdentity(owner,owner)
    if (!current()) return
    busy.current = true; setLoading(true); setError('')
    try {
      const res = await fetch('/api/lookup-contacts', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'search',domain:query.current.domain,page}) })
      const data = await res.json()
      if (!current()) return
      if (!res.ok || !data.success) { setError(data.error ?? 'Contact lookup failed.'); return }
      const fingerprint = data.contacts.map((c: LushaContact) => c.contactId).join('|')
      const repeated = page > 0 && fingerprint === query.current.fingerprint
      query.current.fingerprint = fingerprint
      const incoming = data.contacts.map((c: LushaContact) => c.contactId === knownId && knownEmail && validContactEmail(knownEmail) ? {...c,email:knownEmail} : c)
      setContacts(old => mergeContacts(old,incoming))
      setNextPage(repeated ? null : data.nextPage)
      if (repeated) setError('Lusha repeated the previous page. Coverage may be incomplete; correct the domain or try again later.')
    } catch { if (current()) setError('Contact lookup could not complete. Try again.') }
    finally { if (current()) { busy.current = false; setLoading(false) } }
  }, [knownId,knownEmail])
  async function reveal(contact: LushaContact) {
    if (contact.email || choices[contact.contactId]?.length || revealBusy.current.has(contact.contactId)) return
    const version = generation.current, owner = query.current.owner
    const current = () => version === generation.current && matchesDraftIdentity(owner,owner)
    if (!current()) return
    revealBusy.current.add(contact.contactId)
    setRevealing(old => [...old,contact.contactId]); setRevealErrors(old => ({...old,[contact.contactId]:''}))
    try {
      const res = await fetch('/api/lookup-contacts', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'reveal',enrich_id:contact.contactId,expectedGoogleSub:owner}) })
      const data = await res.json()
      if (!current()) return
      if (!res.ok || !data.success) { setRevealErrors(old => ({...old,[contact.contactId]:data.error ?? 'Email unavailable. Enter a known address manually.'})); return }
      if (data.email && validContactEmail(data.email)) setContacts(old => old.map(c => c.contactId === contact.contactId ? {...c,email:data.email,verified:false} : c))
      else if (data.status === 'choose_email') setChoices(old => ({...old,[contact.contactId]:data.emails}))
      else setRevealErrors(old => ({...old,[contact.contactId]:'No email was revealed. Enter a known address manually.'}))
    } catch { if (current()) setRevealErrors(old => ({...old,[contact.contactId]:'Reveal outcome is unknown. Another attempt may use credits; check Lusha or enter an address manually.'})) }
    finally { if (current()) { revealBusy.current.delete(contact.contactId); setRevealing(old => old.filter(id => id !== contact.contactId)) } }
  }
  function chooseEmail(contactId: string, email: string) {
    if (!matchesDraftIdentity(query.current.owner,query.current.owner) || !validContactEmail(email) || revealBusy.current.has(contactId)) return false
    setContacts(old => old.map(c => c.contactId === contactId ? {...c,email,verified:false} : c))
    setChoices(old => ({...old,[contactId]:[]})); setRevealErrors(old => ({...old,[contactId]:''})); return true
  }
  return { reset,contacts,domain,setDomain,error,loading,nextPage,search,reveal,chooseEmail,revealing,revealErrors,choices }
}
