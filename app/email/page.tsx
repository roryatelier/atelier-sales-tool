'use client'

import { useLushaContacts } from '@/app/components/useLushaContacts'
import ContactEmailActions from '@/app/components/ContactEmailActions'
import { validContactEmail } from '@/lib/lusha-contact'
import { userStorage, activeStorageOwner, matchesDraftIdentity } from '@/lib/browser-storage'

import React, { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'

interface Contact {
  role: string
  name: string
  email: string
  phone?: string
  verified?: boolean
  placeholder?: boolean
  contactId?: string
  linkedin?: string
}

interface Dossier {
  brand_name: string
  [key: string]: unknown
}

const MANUAL_DRAFT_WARNING = 'AI draft unavailable — a basic editable draft has been created. Review and personalise it before sending.'

function buildManualDraft(dossier: Dossier, contactName: string, senderName: string) {
  const brandName = String(dossier.brand_name || 'your brand')
  const firstName = contactName.trim().split(/\s+/)[0] || 'there'
  const signOff = senderName.trim() ? `Thanks,\n${senderName.trim()}` : 'Thanks,'
  return {
    subject: `Atelier × ${brandName}`,
    body: `Hi ${firstName},\n\nI wanted to introduce Atelier and explore whether we can support ${brandName}'s product development and manufacturing plans.\n\nWould you be open to a brief call?\n\n${signOff}`,
  }
}

interface Email {
  subject: string
  body: string
}

interface Template {
  id: number
  name: string
  role: string
  subject: string
  body: string
  target_role?: string
}

interface TabSnapshot {
  id: string
  dossier: Dossier | null
  contact: Contact | null
  selectedRole: string
  email: Email | null
  loading: boolean
  warning: string
  error: string
  trustGatePassed: boolean | null
  sent: boolean
  needsAuth: boolean
  toEmail: string
  ccEmail: string
  bccEmail: string
  showCc: boolean
  showBcc: boolean
  activeTemplate: { subject: string; body: string } | null
  followUpContext: {original_subject?: string; contact_name?: string; date_sent?: string} | null
  selectedBullet: string
  outreachTiming: {recommended_day: string; recommended_date: string; day_reason: string; urgency: string; urgency_reason: string; signal_context: string | null; within_hours: number | null} | null
  pitchAngles: Record<string, string[]>
  pitchRoles: string[]
  recommendedRole: string
  selectedPitchRole: string
}

export default function EmailPage() {
  const [dossier, setDossier] = useState<Dossier | null>(null)
  const [contact, setContact] = useState<Contact | null>(null)
  const lookup = useLushaContacts(contact)
  const { contacts: allContacts, loading: loadingContacts, reset: resetContacts } = lookup
  const [selectedRole, setSelectedRole] = useState<string>('CEO')
  const [email, setEmail] = useState<Email | null>(null)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [warning, setWarning] = useState('')
  const [error, setError] = useState('')
  const [trustGatePassed, setTrustGatePassed] = useState<boolean | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [sent, setSent] = useState(false)
  const [needsAuth, setNeedsAuth] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [savedTemplates, setSavedTemplates] = useState<Template[]>([])
  const [activeTemplate, setActiveTemplate] = useState<{ subject: string; body: string } | null>(null)
  const [roleSwitchedTo, setRoleSwitchedTo] = useState<string | null>(null)
  const [showContactDropdown, setShowContactDropdown] = useState(false)
  const [contactHistory, setContactHistory] = useState<{contact_role: string; sent_at: string}[]>([])
  const [userName, setUserName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userGoogleSub, setUserGoogleSub] = useState('')
  const [ccEmail, setCcEmail] = useState('')
  const [bccEmail, setBccEmail] = useState('')
  const [toEmail, setToEmail] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [pitchAngles, setPitchAngles] = useState<Record<string, string[]>>({})
  const [pitchRoles, setPitchRoles] = useState<string[]>(['CEO', 'CMO', 'Head of NPD'])
  const [recommendedRole, setRecommendedRole] = useState<string>('')
  const [loadingPitch, setLoadingPitch] = useState(false)
  const [selectedPitchRole, setSelectedPitchRole] = useState('CEO')
  const [showPitch, setShowPitch] = useState(false)
  const [followUpContext, setFollowUpContext] = useState<{original_subject?: string; contact_name?: string; date_sent?: string} | null>(null)
  const [outreachTiming, setOutreachTiming] = useState<{recommended_day: string; recommended_date: string; day_reason: string; urgency: string; urgency_reason: string; signal_context: string | null; within_hours: number | null} | null>(null)
  const [showTimingDetail, setShowTimingDetail] = useState(false)
  const [selectedBullet, setSelectedBullet] = useState<string>('')
  const [copied, setCopied] = useState(false)
  const [hasCopied, setHasCopied] = useState(false)
  const [copiedBullet, setCopiedBullet] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<{ name: string; type: string; data: string }[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [linkedInSending, setLinkedInSending] = useState(false)
  const [linkedInSent, setLinkedInSent] = useState(false)
  const [showScheduleModal, setShowScheduleModal] = useState(false)
  const [scheduledAt, setScheduledAt] = useState('')
  const [scheduleTimezone, setScheduleTimezone] = useState('Australia/Sydney')
  const [scheduling, setScheduling] = useState(false)
  const [scheduledTabIds, setScheduledTabIds] = useState<Set<string>>(new Set())
  const dropdownRef = useRef<HTMLDivElement>(null)
  const pitchRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const [checked, setChecked] = useState(false)
  const [tabIds, setTabIds] = useState<string[]>(['tab-0'])
  const [activeTabId, setActiveTabId] = useState<string>('tab-0')
  const activeTabIdRef = useRef<string>('tab-0')
  const tabCounterRef = useRef<number>(0)
  const pendingGenerateRef = useRef<{ role: string; explicitDossier: Dossier; explicitContactName: string } | null>(null)
  // Snapshots live in a ref (not state) so reads/writes are always synchronous and
  // never stale regardless of React's batching behaviour.
  const tabDataRef = useRef<Map<string, TabSnapshot>>(new Map())
  const tabsRestoredRef = useRef(false)
  const pendingContactForTabRef = useRef<Contact | null>(null)
  // Set only from localStorage load — never cleared by tab switching — used as send-time fallback
  const followUpContextRef = useRef<{original_subject?: string; contact_name?: string; date_sent?: string} | null>(null)
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingSelectionRef = useRef<[number, number] | null>(null)
  const linkInputRef = useRef<HTMLInputElement>(null)
  const savedLinkSelectionRef = useRef<[number, number] | null>(null)
  const [showLinkInput, setShowLinkInput] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')

  function getTabLabel(id: string): string {
    if (id === activeTabId) {
      if (!dossier) return 'New Email'
      const brand = dossier.brand_name as string
      if (contact?.name) return `${brand} · ${contact.name.split(' ')[0]}`
      return brand
    }
    const snap = tabDataRef.current.get(id)
    if (!snap?.dossier) return 'New Email'
    const brand = snap.dossier.brand_name as string
    if (snap.contact?.name) return `${brand} · ${snap.contact.name.split(' ')[0]}`
    return brand
  }

  function saveCurrentTab(): void {
    tabDataRef.current.set(activeTabIdRef.current, {
      id: activeTabIdRef.current, dossier, contact, selectedRole, email, loading, warning, error,
      trustGatePassed, sent, needsAuth, toEmail, ccEmail, bccEmail, showCc, showBcc,
      activeTemplate, followUpContext, selectedBullet, outreachTiming,
      pitchAngles, pitchRoles, recommendedRole, selectedPitchRole
    })
  }

  const applyTabSnapshot = useCallback((snap: TabSnapshot): void => {
    setDossier(snap.dossier)
    setContact(snap.contact)
    setSelectedRole(snap.selectedRole)
    setEmail(snap.email)
    setLoading(snap.loading)
    setWarning(snap.warning)
    setError(snap.error)
    setTrustGatePassed(snap.trustGatePassed)
    setSent(snap.sent)
    setNeedsAuth(snap.needsAuth)
    setToEmail(snap.toEmail)
    setCcEmail(snap.ccEmail)
    setBccEmail(snap.bccEmail)
    setShowCc(snap.showCc)
    setShowBcc(snap.showBcc)
    setActiveTemplate(snap.activeTemplate)
    setFollowUpContext(snap.followUpContext)
    setSelectedBullet(snap.selectedBullet)
    setOutreachTiming(snap.outreachTiming)
    setPitchAngles(snap.pitchAngles)
    setPitchRoles(snap.pitchRoles)
    setRecommendedRole(snap.recommendedRole)
    setSelectedPitchRole(snap.selectedPitchRole)
    setShowModal(false)
    setShowTemplates(false)
    setShowContactDropdown(false)
    setShowPitch(false)
    setShowTimingDetail(false)
    resetContacts()
    setContactHistory([])
    setLoadingPitch(false)
    setCopied(false)
    setHasCopied(false)
    setLinkedInSent(false)
    setLinkedInSending(false)
  }, [resetContacts])

  function switchTab(id: string): void {
    if (id === activeTabIdRef.current) return
    saveCurrentTab()
    const target = tabDataRef.current.get(id)
    if (target) applyTabSnapshot(target)
    activeTabIdRef.current = id
    setActiveTabId(id)
  }

  function addTab(): void {
    const newId = `tab-${++tabCounterRef.current}`
    saveCurrentTab()
    const newSnap: TabSnapshot = {
      id: newId, dossier, contact: null, selectedRole: 'CEO',
      email: null, loading: false, warning: '', error: '',
      trustGatePassed: null, sent: false, needsAuth: false,
      toEmail: '', ccEmail: '', bccEmail: '', showCc: false, showBcc: false,
      activeTemplate: null, followUpContext: null, selectedBullet: '',
      outreachTiming, pitchAngles: {}, pitchRoles: ['CEO', 'CMO', 'Head of NPD'],
      recommendedRole: '', selectedPitchRole: 'CEO'
    }
    tabDataRef.current.set(newId, newSnap)
    applyTabSnapshot(newSnap)
    activeTabIdRef.current = newId
    setTabIds(prev => [...prev, newId])
    setActiveTabId(newId)
    pendingGenerateRef.current = { role: 'CEO', explicitDossier: dossier!, explicitContactName: '' }
  }

  function addTabForContact(c: Contact): void {
    const newId = `tab-${++tabCounterRef.current}`
    saveCurrentTab()
    const newSnap: TabSnapshot = {
      id: newId, dossier, contact: c, selectedRole: c.role,
      email: null, loading: false, warning: '', error: '',
      trustGatePassed: null, sent: false, needsAuth: false,
      toEmail: c.email ?? '', ccEmail: '', bccEmail: '', showCc: false, showBcc: false,
      activeTemplate: null, followUpContext: null, selectedBullet: '',
      outreachTiming, pitchAngles: {}, pitchRoles: ['CEO', 'CMO', 'Head of NPD'],
      recommendedRole: '', selectedPitchRole: c.role
    }
    tabDataRef.current.set(newId, newSnap)
    applyTabSnapshot(newSnap)
    activeTabIdRef.current = newId
    setTabIds(prev => [...prev, newId])
    setActiveTabId(newId)
    pendingGenerateRef.current = { role: c.role, explicitDossier: dossier!, explicitContactName: c.name }
  }

  function closeTab(id: string): void {
    if (tabIds.length <= 1) return
    if (id === activeTabIdRef.current) {
      const idx = tabIds.indexOf(id)
      const nextId = tabIds[idx + 1] ?? tabIds[idx - 1]
      if (nextId) {
        const target = tabDataRef.current.get(nextId)
        if (target) applyTabSnapshot(target)
        activeTabIdRef.current = nextId
        setActiveTabId(nextId)
      }
    }
    tabDataRef.current.delete(id)
    setTabIds(prev => prev.filter(tid => tid !== id))
  }

  useEffect(() => {
    const draftOwner = activeStorageOwner()
    const storedDossier = userStorage.getItem('current_dossier')
    const storedContact = userStorage.getItem('selected_contact')
    const storedTemplate = userStorage.getItem('email_template')
    if (!storedDossier) { setChecked(true); return }
    const parsedDossier: Dossier = JSON.parse(storedDossier)
    document.title = `Email — ${parsedDossier.brand_name} — Atelier`

    fetch('/api/me').then(r => r.json()).then(data => {
      if (data.user && matchesDraftIdentity(draftOwner, data.user.google_sub)) {
        setUserName(data.user.name)
        setUserEmail(data.user.email)
        setUserGoogleSub(draftOwner!)
        userStorage.setItem('atelier_user_name', data.user.name)
      } else {
        setUserGoogleSub('')
        setError('Account changed. Reload before continuing with this draft.')
      }
    }).catch(() => { setUserGoogleSub(''); setError('Unable to verify the draft owner. Reload before sending.') })
    const lastContacted = userStorage.getItem('last_contacted_date') ?? undefined
    fetch('/api/outreach-timing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dossier: parsedDossier, last_contacted: lastContacted })
    }).then(r => r.json()).then(data => {
      if (data.success) setOutreachTiming(data.timing)
    }).catch(() => {})

    // Try to restore persisted tabs for the same brand
    let didRestore = false
    try {
      const storedEmailTabs = userStorage.getItem('email_tabs')
      if (storedEmailTabs) {
        const persisted = JSON.parse(storedEmailTabs)
        if (
          persisted.brandName === (parsedDossier.brand_name as string) &&
          Array.isArray(persisted.tabs) && persisted.tabs.length > 0
        ) {
          const tabs: TabSnapshot[] = (persisted.tabs as TabSnapshot[]).map(t => ({ ...t, loading: false }))
          tabs.forEach(t => tabDataRef.current.set(t.id, t))
          setTabIds(tabs.map(t => t.id))
          tabCounterRef.current = Math.max(0, ...tabs.map(t => {
            const n = parseInt((t.id || '').split('-')[1] || '0')
            return isNaN(n) ? 0 : n
          }))
          const activeSnap = tabs.find(t => t.id === persisted.activeTabId) ?? tabs[tabs.length - 1]
          applyTabSnapshot(activeSnap)
          activeTabIdRef.current = activeSnap.id
          setActiveTabId(activeSnap.id)
          // If the restored tab already has a generated email, skip re-generation
          if (activeSnap.email) tabsRestoredRef.current = true
          didRestore = true
        }
      }
    } catch {}

    if (!didRestore) {
      // Fresh start — normal setup
      setDossier(parsedDossier)
      setPitchAngles({})
      setPitchRoles(['CEO', 'CMO', 'Head of NPD'])
      setRecommendedRole('')
      setSelectedPitchRole('CEO')
      if (storedContact) {
        const c = JSON.parse(storedContact)
        setContact(c)
        setSelectedRole(c.role)
        setToEmail(c.email ?? '')
      }
    } else if (storedContact) {
      // Tabs restored + new contact selected — add as a new tab after render
      pendingContactForTabRef.current = JSON.parse(storedContact)
    }

    if (storedTemplate) {
      setActiveTemplate(JSON.parse(storedTemplate))
      userStorage.removeItem('email_template')
    }
    const followUpContextRaw = userStorage.getItem('follow_up_context')
    console.log('[follow-up] localStorage follow_up_context at load:', followUpContextRaw)
    if (followUpContextRaw) {
      const parsed = JSON.parse(followUpContextRaw)
      followUpContextRef.current = parsed
      setFollowUpContext(parsed)
      // Keep in localStorage — used as fallback at send time in case tab switching clears state
    }
    const pitchBullet = userStorage.getItem('pitch_bullet')
    if (pitchBullet) {
      setSelectedBullet(pitchBullet)
      userStorage.removeItem('pitch_bullet')
    }

    setChecked(true)
  }, [router,applyTabSnapshot])

  useEffect(() => {
    if (!dossier) return
    if (tabsRestoredRef.current) { tabsRestoredRef.current = false; return }
    generateEmail(selectedRole)
  }, [dossier])

  useEffect(() => {
    if (pendingGenerateRef.current) {
      const { role, explicitDossier, explicitContactName } = pendingGenerateRef.current
      pendingGenerateRef.current = null
      generateEmail(role, undefined, undefined, { dossier: explicitDossier, contactName: explicitContactName })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId])

  // After restore: if a new contact was selected from the contacts page, open it as a new tab
  useEffect(() => {
    if (!checked || !dossier || !pendingContactForTabRef.current) return
    const c = pendingContactForTabRef.current
    pendingContactForTabRef.current = null
    addTabForContact(c)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, dossier])

  // Persist open tabs to localStorage so they survive navigation away and back
  useEffect(() => {
    if (!checked || !dossier) return
    tabDataRef.current.set(activeTabIdRef.current, {
      id: activeTabIdRef.current,
      dossier, contact, selectedRole, email,
      loading: false, warning, error,
      trustGatePassed, sent, needsAuth,
      toEmail, ccEmail, bccEmail, showCc, showBcc,
      activeTemplate, followUpContext, selectedBullet, outreachTiming,
      pitchAngles, pitchRoles, recommendedRole, selectedPitchRole,
    })
    const allSnaps = tabIds
      .map(id => tabDataRef.current.get(id))
      .filter((s): s is TabSnapshot => s != null)
    try {
      userStorage.setItem('email_tabs', JSON.stringify({
        brandName: dossier.brand_name as string,
        activeTabId: activeTabIdRef.current,
        tabs: allSnaps,
      }))
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, tabIds, activeTabId])

  // Restore textarea cursor position after React commits the new email body to DOM.
  // requestAnimationFrame is unreliable in concurrent mode — useLayoutEffect fires
  // synchronously after commit, before the browser paints.
  useLayoutEffect(() => {
    if (pendingSelectionRef.current && bodyTextareaRef.current) {
      const [s, e] = pendingSelectionRef.current
      bodyTextareaRef.current.setSelectionRange(s, e)
      pendingSelectionRef.current = null
    }
  }, [email?.body])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowContactDropdown(false)
      }
      if (pitchRef.current && !pitchRef.current.contains(e.target as Node)) {
        setShowPitch(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function fetchAllContacts() {
    if (!dossier) return
    void lookup.search((dossier as {website?: string}).website ?? '')
    try {
      const historyRes = await fetch(`/api/contact-history?brand_name=${encodeURIComponent(dossier.brand_name as string)}`)
      const historyData = await historyRes.json()
      if (historyData.success) setContactHistory(historyData.history)
    } catch {
      console.error('Failed to fetch contacts')
    }
  }

  async function fetchTemplates() {
    try {
      const res = await fetch('/api/templates')
      const data = await res.json()
      if (data.success) setSavedTemplates(data.templates)
    } catch {
      console.error('Failed to fetch templates')
    }
  }

  async function fetchPitchAngles() {
    if (!dossier || loadingPitch || Object.keys(pitchAngles).length > 0) return
    setLoadingPitch(true)
    try {
      const res = await fetch('/api/pitch-angle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dossier })
      })
      const data = await res.json()
      if (data.success) {
        setPitchAngles(data.pitchAngles)
        setPitchRoles(data.roles)
        setRecommendedRole(data.recommended)
        setSelectedPitchRole(data.recommended ?? data.roles[0])
      }
    } catch {
      console.error('Failed to fetch pitch angles')
    } finally {
      setLoadingPitch(false)
    }
  }

  async function generateEmail(
    role: string,
    template?: { subject: string; body: string },
    bullet?: string,
    explicit?: { dossier: Dossier; contactName: string }
  ) {
    const activeDossier = explicit?.dossier ?? dossier
    if (!activeDossier) return
    const tabId = activeTabIdRef.current
    setLoading(true)
    setWarning('')
    setError('')
    setEmail(null)
    setTrustGatePassed(null)

    const contactName = explicit
      ? (explicit.contactName || 'there')
      : (contact?.name ?? 'there')
    const manualDraft = buildManualDraft(
      activeDossier,
      contactName,
      userStorage.getItem('atelier_user_name') ?? ''
    )

    try {
      const res = await fetch('/api/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dossier: activeDossier,
          role,
          contact_name: contactName,
          template: template ?? activeTemplate ?? undefined,
          pitch_bullet: bullet ?? selectedBullet ?? undefined,
          follow_up: followUpContext ?? undefined,
          sender_name: userStorage.getItem('atelier_user_name') ?? ''
        })
      })

      const data = await res.json()

      if (activeTabIdRef.current !== tabId) {
        const stale = tabDataRef.current.get(tabId)
        if (stale) {
          tabDataRef.current.set(tabId, {
            ...stale, loading: false,
            ...(res.ok && data.success
              ? { email: data.email, trustGatePassed: true, warning: '', error: '' }
              : { email: manualDraft, trustGatePassed: false, warning: data.warning ? `${data.warning} ${MANUAL_DRAFT_WARNING}` : MANUAL_DRAFT_WARNING, error: '' })
          })
        }
        return
      }

      if (!res.ok || !data.success) {
        setEmail(manualDraft)
        setWarning(data.warning ? `${data.warning} ${MANUAL_DRAFT_WARNING}` : MANUAL_DRAFT_WARNING)
        setError('')
        setTrustGatePassed(false)
        return
      }

      setEmail(data.email)
      setTrustGatePassed(true)
    } catch {
      if (activeTabIdRef.current !== tabId) {
        const stale = tabDataRef.current.get(tabId)
        if (stale) tabDataRef.current.set(tabId, { ...stale, loading: false, email: manualDraft, warning: MANUAL_DRAFT_WARNING, error: '', trustGatePassed: false })
        return
      }
      setEmail(manualDraft)
      setWarning(MANUAL_DRAFT_WARNING)
      setError('')
      setTrustGatePassed(false)
    } finally {
      if (activeTabIdRef.current === tabId) setLoading(false)
    }
  }

  async function handleContactSelect(c: Contact) {
    if (!validContactEmail(c.email) || !matchesDraftIdentity(userGoogleSub,userGoogleSub)) return
    setShowContactDropdown(false)
    addTabForContact(c)
    // Explicitly set To field — don't rely on snapshot batching
    setToEmail(c.email ?? '')
    // Null out pending ref and call generateEmail directly with the live contact
    // so we never use stale contact state from a previous tab
    pendingGenerateRef.current = null
    if (dossier) generateEmail(c.role, undefined, undefined, { dossier, contactName: c.name || 'there' })
  }

  async function handleCopyMessage() {
    if (!email) return
    await navigator.clipboard.writeText(email.body)
    setCopied(true)
    setHasCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleMarkLinkedIn() {
    if (!dossier || !email) return
    setLinkedInSending(true)
    try {
      const today = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })
      await Promise.all([
        fetch('/api/save-to-sheets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            brand_name: dossier.brand_name,
            website: (dossier as Record<string, unknown>).website ?? '',
            lead_source: userStorage.getItem('lead_source') ?? 'Outbound',
            revenue_estimate: (dossier as Record<string, unknown>).revenue_estimate ?? '',
            retailers: (dossier as Record<string, unknown>).retailers ?? [],
            category: (dossier as Record<string, unknown>).category ?? '',
            icp_score: (dossier as Record<string, unknown>).icp_score ?? 0,
            score_band: (dossier as Record<string, unknown>).score_band ?? '',
            signals: (dossier as Record<string, unknown>).signals ?? [],
            target_role: contact?.role ?? selectedRole,
            contact_name: contact?.name ?? '',
            email_subject: email.subject,
            email_body: email.body,
            status: 'Sent',
          }),
        }),
        fetch('/api/contact-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            brand_name: dossier.brand_name,
            contact_role: contact?.role ?? selectedRole,
            contact_name: contact?.name ?? '',
            contact_email: contact?.email ?? '',
            method: 'linkedin',
            sent_at: today,
          }),
        }),
        fetch('/api/update-pipeline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brand_name: dossier.brand_name, status: 'Sent' }),
        }),
      ])
      setLinkedInSent(true)
    } catch {
      // fail silently — the user can retry
    } finally {
      setLinkedInSending(false)
    }
  }

  function applyInlineFormat(prefix: string, suffix: string) {
    const ta = bodyTextareaRef.current
    if (!ta || !email) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    // Read from the DOM value — avoids any state/DOM sync lag on rapid edits
    const body = ta.value
    const newBody = body.slice(0, start) + prefix + body.slice(start, end) + suffix + body.slice(end)
    // Store target selection so useLayoutEffect can restore it after React commits
    pendingSelectionRef.current = [start + prefix.length, end + prefix.length]
    setEmail(prev => prev ? { ...prev, body: newBody } : prev)
  }

  function applyLineFormat(marker: string) {
    const ta = bodyTextareaRef.current
    if (!ta || !email) return
    const pos = ta.selectionStart
    const body = ta.value
    const lineStart = body.lastIndexOf('\n', pos - 1) + 1
    if (body.slice(lineStart).startsWith(marker)) return
    const newBody = body.slice(0, lineStart) + marker + body.slice(lineStart)
    pendingSelectionRef.current = [pos + marker.length, pos + marker.length]
    setEmail(prev => prev ? { ...prev, body: newBody } : prev)
  }

  function clearFormatting() {
    const ta = bodyTextareaRef.current
    if (!ta || !email) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const body = ta.value
    const hasSelection = end > start
    const target = hasSelection ? body.slice(start, end) : body
    const offset = hasSelection ? start : 0
    const cleaned = target
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/^#{1,6} /gm, '')
      .replace(/^ *- /gm, '')
    const newBody = body.slice(0, offset) + cleaned + body.slice(offset + target.length)
    pendingSelectionRef.current = [offset, offset + cleaned.length]
    setEmail(prev => prev ? { ...prev, body: newBody } : prev)
  }

  function handleLinkButtonMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const ta = bodyTextareaRef.current
    if (!ta || !email) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    if (end > start) {
      savedLinkSelectionRef.current = [start, end]
      setLinkUrl('')
      setShowLinkInput(true)
      setTimeout(() => linkInputRef.current?.focus(), 0)
    } else {
      const body = ta.value
      const insert = '[link text](url)'
      const newBody = body.slice(0, start) + insert + body.slice(start)
      pendingSelectionRef.current = [start + 1, start + 10]
      setEmail(prev => prev ? { ...prev, body: newBody } : prev)
      setTimeout(() => { ta.focus(); ta.setSelectionRange(start + 1, start + 10) }, 0)
    }
  }

  function insertLink() {
    const ta = bodyTextareaRef.current
    if (!ta || !email || !savedLinkSelectionRef.current) return
    const [start, end] = savedLinkSelectionRef.current
    const body = ta.value
    const selectedText = body.slice(start, end)
    const url = linkUrl.trim() || 'url'
    const replacement = `[${selectedText}](${url})`
    const newBody = body.slice(0, start) + replacement + body.slice(end)
    pendingSelectionRef.current = [start + replacement.length, start + replacement.length]
    setEmail(prev => prev ? { ...prev, body: newBody } : prev)
    setShowLinkInput(false)
    setLinkUrl('')
    savedLinkSelectionRef.current = null
    setTimeout(() => ta.focus(), 0)
  }

  function getDefaultScheduledAt(): string {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`
  }

  function getTimezoneForMarkets(markets?: string[]): string {
    if (!markets || markets.length === 0) return 'Australia/Sydney'
    const m = markets[0].toLowerCase()
    if (m.includes('us') || m.includes('united states') || m.includes('america')) return 'America/New_York'
    if (m.includes('uk') || m.includes('united kingdom') || m.includes('britain')) return 'Europe/London'
    if (m.includes('eu') || m.includes('europe')) return 'Europe/London'
    return 'Australia/Sydney'
  }

  function openScheduleModal() {
    setScheduledAt(getDefaultScheduledAt())
    setScheduleTimezone(getTimezoneForMarkets((dossier as {markets?: string[]}).markets))
    setShowScheduleModal(true)
  }

  async function handleSchedule() {
    if (!email || !scheduledAt) return
    setScheduling(true)
    try {
      const res = await fetch('/api/schedule-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: toEmail,
          cc: ccEmail || undefined,
          bcc: bccEmail || undefined,
          subject: email.subject,
          body: email.body,
          brand_name: dossier?.brand_name,
          contact_name: contact?.name ?? '',
          scheduled_at_local: scheduledAt,
          timezone: scheduleTimezone,
          sent_by: userStorage.getItem('atelier_user_name') ?? '',
          dossier: dossier ?? undefined,
        }),
      })
      const data = await res.json()
      if (data.reauth) { setNeedsAuth(true); setShowScheduleModal(false); return }
      if (!res.ok || !data.success) {
        setError(data.error ?? 'Failed to schedule email. Please try again.')
        setShowScheduleModal(false)
        return
      }
      setScheduledTabIds(prev => new Set([...prev, activeTabId]))
      setShowScheduleModal(false)
    } catch {
      setError('Something went wrong. Please try again.')
      setShowScheduleModal(false)
    } finally {
      setScheduling(false)
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    files.forEach(file => {
      if (file.size > 10 * 1024 * 1024) return
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.split(',')[1]
        setAttachments(prev => [...prev, { name: file.name, type: file.type, data: base64 }])
      }
      reader.readAsDataURL(file)
    })
    e.target.value = ''
  }

  async function handleSend() {
    if (!email) return
    if (!matchesDraftIdentity(userGoogleSub, userGoogleSub)) {
      setError('Account changed. Reload before sending this draft.')
      return
    }
    setSending(true)
    setError('')

    try {
      const res = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: toEmail,
          cc: ccEmail,
          bcc: bccEmail,
          subject: email.subject,
          emailBody: email.body,
          expectedGoogleSub: userGoogleSub,
          contactName: contact?.name ?? '',
          role: selectedRole,
          leadSource: userStorage.getItem('lead_source') ?? 'Outbound',
          senderName: userStorage.getItem('atelier_user_name') ?? '',
          dossier,
          attachments: attachments.length > 0 ? attachments : undefined
        })
      })

      const data = await res.json()

      if (data.reauth) { setNeedsAuth(true); setShowModal(false); return }
      if (!res.ok || !data.success) { setError('Failed to send email. Please try again.'); setShowModal(false); return }

      setSent(true)
      setShowModal(false)

      const lsRaw = userStorage.getItem('follow_up_context')
      const effectiveFollowUp = followUpContextRef.current ?? followUpContext ?? (lsRaw ? JSON.parse(lsRaw) : null)
      console.log('[follow-up] at send time — ref:', followUpContextRef.current, 'state:', followUpContext, 'localStorage:', lsRaw, 'effective:', effectiveFollowUp)

      if (effectiveFollowUp && dossier) {
        console.log('[follow-up] calling /api/update-pipeline with:', { brand_name: dossier.brand_name, status: 'Follow-up 1' })
        userStorage.removeItem('follow_up_context')
        followUpContextRef.current = null
        fetch('/api/update-pipeline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brand_name: dossier.brand_name, status: 'Follow-up 1' }),
        })
          .then(r => r.json().then(body => console.log('[follow-up] update-pipeline response:', r.status, body)))
          .catch(err => console.error('[follow-up] update-pipeline fetch error:', err))
      } else {
        console.log('[follow-up] skipping update-pipeline — no follow-up context or no dossier')
      }
    } catch {
      setError('Something went wrong. Please try again.')
      setShowModal(false)
    } finally {
      setSending(false)
    }
  }

  if (!checked) return null

  if (!dossier) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 320, textAlign: 'center', gap: 16 }}>
      <svg width="40" height="40" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--slate-300)' }}>
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" strokeWidth="1.5"/>
        <polyline points="22,6 12,13 2,6" strokeWidth="1.5"/>
      </svg>
      <div>
        <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--text-default)', marginBottom: 6 }}>No brand selected</div>
        <div style={{ fontSize: 13, color: 'var(--slate-400)' }}>Search for a brand first, then come back to draft an email.</div>
      </div>
      <a href="/portfolio" className="btn btn-primary btn-sm">Browse brands</a>
    </div>
  )

  return (
    <div style={{ zoom: 0.8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--black-100)' }}>
        {tabIds.map(id => (
          <div
            key={id}
            onClick={() => switchTab(id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px',
              fontSize: 12, fontWeight: id === activeTabId ? 500 : 400,
              color: id === activeTabId ? 'var(--text-default)' : 'var(--slate-400)',
              background: id === activeTabId ? '#fff' : 'transparent',
              border: '1px solid',
              borderColor: id === activeTabId ? 'var(--black-100)' : 'transparent',
              borderBottom: id === activeTabId ? '1px solid #fff' : '1px solid transparent',
              borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
              cursor: id === activeTabId ? 'default' : 'pointer',
              marginBottom: id === activeTabId ? -1 : 0,
              userSelect: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            <span>{getTabLabel(id)}</span>
            {tabIds.length > 1 && (
              <button
                onClick={e => { e.stopPropagation(); closeTab(id) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--slate-400)', fontSize: 14, padding: '0 2px', lineHeight: 1, marginLeft: 2 }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          onClick={addTab}
          style={{ marginBottom: 6, marginLeft: 4, padding: '3px 9px', background: 'none', border: '1px solid var(--black-100)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 16, color: 'var(--slate-400)', lineHeight: 1 }}
        >
          +
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div className="page-eyebrow" style={{ margin: 0 }}>Email Generator</div>
        <div style={{ fontSize: 13, color: 'var(--slate-400)' }}>→</div>
        <div style={{ fontSize: 13, color: 'var(--slate-400)' }}>{dossier.brand_name as string}</div>
        {contact && (
          <>
            <div style={{ fontSize: 13, color: 'var(--slate-400)' }}>→</div>
            <div style={{ fontSize: 13, color: 'var(--slate-400)' }}>{contact.name}</div>
          </>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h1 style={{ fontSize: 28, fontWeight: 500, letterSpacing: '-0.5px', margin: 0 }}>
          Outreach to {dossier.brand_name as string}
        </h1>
        <button onClick={() => router.push('/contacts')} className="btn btn-ghost btn-sm">
          ← Back to contacts
        </button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--slate-500)', marginBottom: 28 }}>
        Personalised from {dossier.brand_name as string}&apos;s research dossier. Review every detail before it leaves your inbox.
      </p>

      {sent && (
        <div style={{ background: 'var(--green-100)', border: '1px solid var(--green-300)', borderRadius: 'var(--radius-md)', padding: '24px', marginBottom: 24, textAlign: 'center' }}>
          <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--green-400)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
            <svg width="22" height="22" fill="none" stroke="#fff" viewBox="0 0 24 24">
              <polyline points="20,6 9,17 4,12" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div style={{ fontWeight: 600, fontSize: 16, color: 'var(--green-500)', marginBottom: 4 }}>Email sent successfully</div>
          <div style={{ fontSize: 13, color: 'var(--green-400)', marginBottom: 20 }}>
            Sent to {contact?.name ? `${contact.name}${contact.role ? ` · ${contact.role}` : ''} · ${toEmail}` : toEmail}
          </div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button onClick={() => router.push('/portfolio')} className="btn btn-primary btn-sm">Research another brand</button>
            <button onClick={() => router.push('/pipeline')} className="btn btn-secondary btn-sm">View pipeline</button>
          </div>
        </div>
      )}

      {needsAuth && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--orange-100)', border: '1px solid var(--orange-300)', borderRadius: 'var(--radius-md)', padding: '14px 18px', marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: 'var(--orange-500)' }}>Gmail authorisation required before sending.</div>
          <a href="/api/auth/gmail" className="btn btn-primary btn-sm">Authorise Gmail</a>
        </div>
      )}

      {selectedBullet && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#050849', borderRadius: 'var(--radius-md)', padding: '10px 16px', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="14" height="14" fill="none" stroke="#fff" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
              <polygon points="13,2 3,14 12,14 11,22 21,10 12,10 13,2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', lineHeight: 1.4 }}>
              <span style={{ fontWeight: 600, color: '#fff' }}>Pitch point in use: </span>{selectedBullet}
            </div>
          </div>
          <button
            onClick={() => { setSelectedBullet(''); generateEmail(selectedRole) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.6)', fontSize: 12, flexShrink: 0, marginLeft: 12 }}
          >
            Remove ×
          </button>
        </div>
      )}

      {outreachTiming && (
        <div style={{
          background: outreachTiming.urgency === 'high' ? '#050849' : outreachTiming.urgency === 'medium' ? 'var(--orange-100)' : 'var(--slate-100)',
          border: '1px solid',
          borderColor: outreachTiming.urgency === 'high' ? '#050849' : outreachTiming.urgency === 'medium' ? 'var(--orange-200)' : 'var(--black-100)',
          borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: 12, cursor: 'pointer'
        }}
          onClick={() => setShowTimingDetail(!showTimingDetail)}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14 }}>📅</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: outreachTiming.urgency === 'high' ? '#fff' : 'var(--text-default)' }}>
                Best time to reach out: {outreachTiming.recommended_day === 'Today' || outreachTiming.recommended_day === 'Tomorrow' ? outreachTiming.recommended_day : outreachTiming.recommended_date}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em',
                padding: '2px 8px', borderRadius: 4,
                background: outreachTiming.urgency === 'high' ? 'rgba(255,255,255,0.15)' : outreachTiming.urgency === 'medium' ? 'var(--orange-200)' : 'var(--slate-200)',
                color: outreachTiming.urgency === 'high' ? '#fff' : outreachTiming.urgency === 'medium' ? 'var(--orange-400)' : 'var(--slate-400)'
              }}>
                {outreachTiming.urgency} urgency
              </span>
            </div>
            <svg width="14" height="14" fill="none" stroke={outreachTiming.urgency === 'high' ? '#fff' : 'currentColor'} viewBox="0 0 24 24" style={{ transform: showTimingDetail ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }}>
              <polyline points="6,9 12,15 18,9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          {showTimingDetail && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${outreachTiming.urgency === 'high' ? 'rgba(255,255,255,0.15)' : 'var(--black-100)'}` }}>
              <div style={{ fontSize: 12, color: outreachTiming.urgency === 'high' ? 'rgba(255,255,255,0.8)' : 'var(--slate-500)', lineHeight: 1.5 }}>
                {outreachTiming.urgency_reason}
                {outreachTiming.signal_context && ` — "${outreachTiming.signal_context.slice(0, 80)}${outreachTiming.signal_context.length > 80 ? '...' : ''}"`}
              </div>
              {outreachTiming.within_hours && (
                <div style={{ fontSize: 11, fontWeight: 600, color: outreachTiming.urgency === 'high' ? 'rgba(255,255,255,0.6)' : 'var(--orange-400)', marginTop: 6 }}>
                  ⚡ Act within {outreachTiming.within_hours} hours for best results
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {followUpContext && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--orange-100)', border: '1px solid var(--orange-200)', borderRadius: 'var(--radius-md)', padding: '10px 16px', marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--orange-500)', fontWeight: 500 }}>
            ⏰ Follow-up mode — original email sent {followUpContext.date_sent}
            {followUpContext.original_subject ? ` · "${followUpContext.original_subject}"` : ''}
          </div>
          <button
            onClick={() => setFollowUpContext(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--orange-400)', fontSize: 12 }}
          >
            Dismiss ×
          </button>
        </div>
      )}

      {activeTemplate && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--brand-100)', border: '1px solid var(--brand-200)', borderRadius: 'var(--radius-md)', padding: '10px 16px', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, color: 'var(--brand-400)', fontWeight: 500 }}>Using saved template as style guide</span>
            {roleSwitchedTo && (
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', background: '#050849', color: '#fff', padding: '2px 8px', borderRadius: 4 }}>
                → Role switched to {roleSwitchedTo}
              </span>
            )}
          </div>
          <button onClick={() => { setActiveTemplate(null); generateEmail(selectedRole) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--brand-400)', fontSize: 12 }}>Remove ×</button>
        </div>
      )}


      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--slate-400)' }}>Trust gate</span>
          {trustGatePassed === null && <span style={{ fontSize: 12, color: 'var(--slate-400)', background: 'var(--slate-200)', padding: '3px 10px', borderRadius: 'var(--radius-xs)' }}>—</span>}
          {trustGatePassed === true && <span style={{ fontSize: 12, fontWeight: 500, color: '#fff', background: 'var(--green-400)', padding: '3px 10px', borderRadius: 'var(--radius-xs)' }}>Pass</span>}
          {trustGatePassed === false && <span style={{ fontSize: 12, fontWeight: 500, color: '#fff', background: 'var(--red-500)', padding: '3px 10px', borderRadius: 'var(--radius-xs)' }}>Fail</span>}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginBottom: 24 }}>
        <div ref={dropdownRef} style={{ position: 'relative' }}>
          <button
            onClick={() => {
              setShowContactDropdown(!showContactDropdown)
              if (!showContactDropdown && allContacts.length === 0) fetchAllContacts()
            }}
            className="btn btn-secondary btn-sm"
          >
            Additional contacts ▾
          </button>
          {showContactDropdown && (
            <div style={{
              position: 'absolute', right: 0, top: '100%', marginTop: 4,
              background: '#fff', border: '1px solid var(--black-100)',
              borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-400)',
              minWidth: 280, zIndex: 50, maxHeight: 360, overflowY: 'auto'
            }}>
              <form onSubmit={e => {e.preventDefault(); void lookup.search(lookup.domain)}} style={{padding:12}}>
                <input aria-label="Company domain" value={lookup.domain} onChange={e => lookup.setDomain(e.target.value)} placeholder="Company website or domain" />
                <button type="submit" className="btn btn-secondary btn-sm">Search contacts</button>
              </form>
              {lookup.error && <p role="alert" style={{padding:12}}>{lookup.error}</p>}
              <p style={{padding:12}}>{allContacts.length} contacts loaded</p>
              {lookup.nextPage !== null && <button className="btn btn-secondary btn-sm" disabled={loadingContacts} onClick={() => lookup.search(lookup.domain,lookup.nextPage!)}>Load more</button>}
              {loadingContacts && (
                <div style={{ padding: '12px 16px', fontSize: 13, color: 'var(--slate-400)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="spinner" /> Loading contacts...
                </div>
              )}
              {!loadingContacts && !lookup.error && allContacts.length === 0 && (
                <div style={{ padding: '12px 16px', fontSize: 13, color: 'var(--slate-400)' }}>No contacts found</div>
              )}
              {!loadingContacts && allContacts.map((c, i) => {
                const history = contactHistory.find(h => h.contact_role === c.role)
                const isRevealing = lookup.revealing.includes(c.contactId)
                const isBlocked = !validContactEmail(c.email) || isRevealing
                return (
                  <div
                    key={c.contactId}
                    onClick={() => !isBlocked && handleContactSelect(c)}
                    style={{
                      padding: '10px 16px',
                      cursor: isBlocked ? 'default' : 'pointer',
                      borderBottom: i < allContacts.length - 1 ? '1px solid var(--black-100)' : 'none',
                      background: contact?.role === c.role ? 'var(--slate-100)' : history ? 'var(--green-100)' : '#fff',
                      opacity: isBlocked && !isRevealing ? 0.5 : 1,
                    }}
                    onMouseEnter={e => { if (!isBlocked) e.currentTarget.style.background = 'var(--slate-100)' }}
                    onMouseLeave={e => { if (!isBlocked) e.currentTarget.style.background = contact?.role === c.role ? 'var(--slate-100)' : history ? 'var(--green-100)' : '#fff' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--slate-400)' }}>{c.role}</span>
                          {history && <span style={{ fontSize: 10, color: 'var(--green-400)', fontWeight: 500 }}>Contacted {new Date(history.sent_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</span>}
                          {!c.verified && !history && <span style={{ fontSize: 10, color: 'var(--orange-400)' }}>Unverified</span>}
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{c.name}</div>
                        <ContactEmailActions contact={c} busy={isRevealing} error={lookup.revealErrors[c.contactId]} choices={lookup.choices[c.contactId]} onReveal={() => lookup.reveal(c)} onChoose={email => lookup.chooseEmail(c.contactId,email)} />
                        {isRevealing ? (
                          <div style={{ fontSize: 12, color: 'var(--slate-400)', display: 'flex', alignItems: 'center', gap: 5, marginTop: 1 }}>
                            <div className="spinner" style={{ width: 10, height: 10 }} /> Revealing...
                          </div>
                        ) : c.email ? (
                          <div style={{ fontSize: 12, color: 'var(--slate-500)' }}>{c.email}</div>
                        ) : (
                          <div style={{ fontSize: 12, color: 'var(--slate-400)', fontStyle: 'italic' }}>
                            Email not revealed
                          </div>
                        )}
                      </div>
                      {contact?.role === c.role && (
                        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--green-400)' }}>
                          <polyline points="20,6 9,17 4,12" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <button onClick={() => { setShowTemplates(!showTemplates); fetchTemplates() }} className="btn btn-secondary btn-sm">
          {showTemplates ? 'Hide templates' : 'Use saved template'}
        </button>
      </div>

      {showTemplates && (
        <div className="card-hair" style={{ padding: '16px 20px', marginBottom: 24 }}>
          <div className="section-label" style={{ marginBottom: 12 }}>Saved templates</div>
          {savedTemplates.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--slate-400)' }}>
              No saved templates yet. <a href="/templates" style={{ color: 'var(--brand-400)' }}>Create one in the Templates tab.</a>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {savedTemplates.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: '#fff', border: '1px solid var(--black-100)', borderRadius: 'var(--radius-sm)' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', background: 'var(--brand-100)', color: 'var(--brand-400)', padding: '2px 8px', borderRadius: 4 }}>{t.role}</span>
                    {t.target_role && (
                      <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', background: '#050849', color: '#fff', padding: '2px 8px', borderRadius: 4 }}>{t.target_role}</span>
                    )}
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{t.name}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--slate-400)' }}>{t.subject}</div>
                </div>
                <button
                  onClick={() => {
                    const tmpl = { subject: t.subject, body: t.body }
                    setActiveTemplate(tmpl)
                    setShowTemplates(false)
                    const roleToUse = t.target_role && t.target_role !== '' ? t.target_role : selectedRole
                    if (t.target_role && t.target_role !== '') {
                      setSelectedRole(t.target_role)
                      setRoleSwitchedTo(t.target_role)
                      setTimeout(() => setRoleSwitchedTo(null), 3000)
                    }
                    generateEmail(roleToUse, tmpl)
                  }}
                  className="btn btn-primary btn-sm"
                >
                  Use
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--black-100)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 52, fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--slate-400)', flexShrink: 0 }}>From</div>
            <div style={{ fontSize: 13, color: 'var(--slate-500)' }}>{userEmail || userName || 'Your Gmail account'}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 52, fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--slate-400)', flexShrink: 0 }}>To</div>
            <input
              type="text"
              value={toEmail}
              onChange={e => setToEmail(e.target.value)}
              placeholder={contact?.name ? `Enter email for ${contact.name}` : 'Recipient email'}
              style={{ fontSize: 13, color: 'var(--text-default)', border: 'none', borderBottom: '1px solid var(--black-100)', outline: 'none', background: 'transparent', flex: 1, padding: '2px 0' }}
            />
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => setShowCc(!showCc)}
                style={{ fontSize: 11, fontWeight: 500, color: showCc ? '#fff' : 'var(--brand-400)', background: showCc ? '#050849' : 'transparent', border: '1px solid', borderColor: showCc ? '#050849' : 'var(--brand-200)', borderRadius: 4, cursor: 'pointer', padding: '2px 8px' }}
              >
                CC
              </button>
              <button
                onClick={() => setShowBcc(!showBcc)}
                style={{ fontSize: 11, fontWeight: 500, color: showBcc ? '#fff' : 'var(--brand-400)', background: showBcc ? '#050849' : 'transparent', border: '1px solid', borderColor: showBcc ? '#050849' : 'var(--brand-200)', borderRadius: 4, cursor: 'pointer', padding: '2px 8px' }}
              >
                BCC
              </button>
            </div>
          </div>
          {showCc && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 52, fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--slate-400)', flexShrink: 0 }}>CC</div>
              <input
                type="text"
                value={ccEmail}
                onChange={e => setCcEmail(e.target.value)}
                placeholder="Add CC email(s), comma separated"
                style={{ fontSize: 13, color: 'var(--text-default)', border: 'none', borderBottom: '1px solid var(--black-100)', outline: 'none', background: 'transparent', flex: 1, padding: '2px 0' }}
                autoFocus
              />
            </div>
          )}
          {showBcc && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 52, fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--slate-400)', flexShrink: 0 }}>BCC</div>
              <input
                type="text"
                value={bccEmail}
                onChange={e => setBccEmail(e.target.value)}
                placeholder="Add BCC email(s), comma separated"
                style={{ fontSize: 13, color: 'var(--text-default)', border: 'none', borderBottom: '1px solid var(--black-100)', outline: 'none', background: 'transparent', flex: 1, padding: '2px 0' }}
                autoFocus
              />
            </div>
          )}
        </div>

        {contact && contact.verified === false && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
            background: 'var(--orange-100)', border: '1px solid var(--orange-200)',
            borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 12,
          }}>
            <span style={{ fontSize: 12, color: 'var(--orange-500)', lineHeight: 1.5 }}>
              ⚠️ Unverified email — delivery not guaranteed. Consider reaching out via LinkedIn instead.
            </span>
            {contact.linkedin && (
              <a
                href={contact.linkedin}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontSize: 12, fontWeight: 500, color: 'var(--orange-500)',
                  whiteSpace: 'nowrap', textDecoration: 'none', flexShrink: 0,
                }}
              >
                View on LinkedIn ↗
              </a>
            )}
          </div>
        )}

        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '32px 0', color: 'var(--slate-500)', fontSize: 14 }}>
            <div className="spinner" />
            {activeTemplate ? 'Personalising your template...' : 'Generating personalised email...'}
          </div>
        )}

        {warning && (
          <div className="data-warning">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" strokeWidth="2"/>
              <line x1="12" y1="9" x2="12" y2="13" strokeWidth="2" strokeLinecap="round"/>
              <line x1="12" y1="17" x2="12.01" y2="17" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            {warning}
          </div>
        )}

        {error && (
          <div style={{ background: 'var(--red-100)', border: '1px solid var(--red-300)', borderRadius: 'var(--radius-md)', padding: '14px 16px', color: 'var(--red-500)', fontSize: 13 }}>
            {error}
          </div>
        )}

        {email && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label className="field-label">Subject</label>
              <input
                type="text"
                value={email.subject}
                onChange={e => setEmail({ ...email, subject: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <label className="field-label" style={{ margin: 0 }}>Body</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 500,
                    color: email.body.split(/\s+/).filter(Boolean).length > 100 ? 'var(--red-500)' : 'var(--slate-400)'
                  }}>
                    {email.body.split(/\s+/).filter(Boolean).length} / 100 words
                  </span>
                  <button
                    onClick={handleCopyMessage}
                    style={{
                      fontSize: 11, fontWeight: 500, padding: '3px 10px',
                      borderRadius: 'var(--radius-xs)', cursor: 'pointer',
                      border: '1px solid',
                      background: copied ? 'var(--green-100)' : '#fff',
                      color: copied ? 'var(--green-400)' : 'var(--slate-500)',
                      borderColor: copied ? 'var(--green-300)' : 'var(--black-100)',
                    }}
                  >
                    {copied ? 'Copied ✓' : 'Copy message'}
                  </button>
                </div>
              </div>
              <div ref={pitchRef} style={{ position: 'relative' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 1, padding: '3px 6px', background: 'var(--slate-100)', border: '1px solid var(--black-100)', borderRadius: 'var(--radius-xs)', marginBottom: 6 }}>
                  {showLinkInput ? (
                    <>
                      <span style={{ fontSize: 11, color: 'var(--slate-400)', marginRight: 4, flexShrink: 0 }}>URL:</span>
                      <input
                        ref={linkInputRef}
                        value={linkUrl}
                        onChange={e => setLinkUrl(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); insertLink() }
                          if (e.key === 'Escape') { setShowLinkInput(false); setLinkUrl(''); setTimeout(() => bodyTextareaRef.current?.focus(), 0) }
                        }}
                        placeholder="https://…"
                        style={{
                          flex: 1, height: 22, fontSize: 12, padding: '0 8px',
                          border: '1px solid var(--black-100)', borderRadius: 4,
                          outline: 'none', background: '#fff', minWidth: 0,
                        }}
                      />
                      <button
                        onMouseDown={e => { e.preventDefault(); insertLink() }}
                        title="Insert link"
                        style={{ width: 26, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#050849', border: 'none', borderRadius: 4, cursor: 'pointer', color: '#fff', fontSize: 12, marginLeft: 4, flexShrink: 0 }}
                      >✓</button>
                      <button
                        onMouseDown={e => { e.preventDefault(); setShowLinkInput(false); setLinkUrl(''); setTimeout(() => bodyTextareaRef.current?.focus(), 0) }}
                        title="Cancel"
                        style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', borderRadius: 4, cursor: 'pointer', color: 'var(--slate-400)', fontSize: 13, flexShrink: 0 }}
                      >✕</button>
                    </>
                  ) : (
                    <>
                      {([
                        { label: 'B', title: 'Bold', extra: { fontWeight: 700 }, action: () => applyInlineFormat('**', '**') },
                        { label: 'I', title: 'Italic', extra: { fontStyle: 'italic' as const }, action: () => applyInlineFormat('*', '*') },
                        { label: '•', title: 'Bullet', extra: {}, action: () => applyLineFormat('  - ') },
                        { label: '↳', title: 'Sub-bullet', extra: { fontSize: 12 }, action: () => applyLineFormat('    - ') },
                        { label: 'H', title: 'Header', extra: { letterSpacing: '-0.02em' }, action: () => applyLineFormat('## ') },
                        { label: '✕', title: 'Clear formatting', extra: { fontSize: 10 }, action: clearFormatting },
                      ] as { label: string; title: string; extra: React.CSSProperties; action: () => void }[]).map((btn, i) => (
                        <button
                          key={btn.label}
                          title={btn.title}
                          onMouseDown={e => { e.preventDefault(); btn.action() }}
                          style={{
                            width: 28, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: 'none', border: 'none', cursor: 'pointer', borderRadius: 4,
                            fontSize: 13, color: 'var(--slate-500)', transition: 'background 0.1s, color 0.1s',
                            ...(i === 5 ? { marginLeft: 4 } : {}),
                            ...btn.extra,
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#050849'; e.currentTarget.style.color = '#fff' }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--slate-500)' }}
                        >
                          {btn.label}
                        </button>
                      ))}
                      <div style={{ width: 1, height: 14, background: 'var(--black-100)', margin: '0 4px' }} />
                      <button
                        title="Insert link"
                        onMouseDown={handleLinkButtonMouseDown}
                        style={{
                          width: 28, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: 'none', border: 'none', cursor: 'pointer', borderRadius: 4,
                          fontSize: 14, color: 'var(--slate-500)', transition: 'background 0.1s, color 0.1s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#050849'; e.currentTarget.style.color = '#fff' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--slate-500)' }}
                      >
                        🔗
                      </button>
                      <div style={{ width: 1, height: 14, background: 'var(--black-100)', margin: '0 6px 0 2px' }} />
                      <span style={{ fontSize: 11, color: 'var(--slate-300)', userSelect: 'none' }}>Format</span>
                    </>
                  )}
                </div>
                <textarea
                  ref={bodyTextareaRef}
                  value={email.body}
                  onChange={e => setEmail({ ...email, body: e.target.value })}
                  rows={12}
                  className="textarea"
                />
                <button
                  onClick={() => { setShowPitch(!showPitch); if (!showPitch) fetchPitchAngles() }}
                  style={{
                    position: 'absolute', bottom: 10, right: 10,
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    fontSize: 11, fontWeight: 500, padding: '4px 10px',
                    background: showPitch ? '#050849' : 'rgba(255,255,255,0.92)',
                    color: showPitch ? '#fff' : 'var(--text-default)',
                    border: '1px solid var(--black-100)', borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer', backdropFilter: 'blur(4px)',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.08)'
                  }}
                >
                  💡 Pitch angles
                </button>
                {showPitch && (
                  <div style={{
                    position: 'absolute', bottom: 'calc(100% - 28px)', right: 10, marginBottom: 4,
                    background: '#fff', border: '1px solid var(--black-100)',
                    borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-400)',
                    padding: '10px 12px', zIndex: 40, minWidth: 340, maxWidth: 480,
                    maxHeight: 280, overflowY: 'auto'
                  }}>
                    {loadingPitch && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--slate-400)', fontSize: 13 }}>
                        <div className="spinner" /> Generating pitch angles...
                      </div>
                    )}
                    {!loadingPitch && recommendedRole && pitchAngles[recommendedRole] && (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--slate-400)', marginBottom: 10 }}>
                          {recommendedRole}
                        </div>
                        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {pitchAngles[recommendedRole].map((bullet, i) => (
                            <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, lineHeight: 1.5 }}>
                              <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#050849', color: '#fff', fontSize: 10, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 }}>{i + 1}</span>
                              <span style={{ color: 'var(--text-default)', flex: 1 }}>{bullet}</span>
                              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText(bullet)
                                    setCopiedBullet(bullet)
                                    setTimeout(() => setCopiedBullet(b => b === bullet ? null : b), 2000)
                                  }}
                                  style={{
                                    fontSize: 11, fontWeight: 500,
                                    padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
                                    background: 'transparent',
                                    color: copiedBullet === bullet ? 'var(--green-400)' : 'var(--slate-400)',
                                    border: '1px solid',
                                    borderColor: copiedBullet === bullet ? 'var(--green-300)' : 'var(--black-100)',
                                    whiteSpace: 'nowrap'
                                  }}
                                >
                                  {copiedBullet === bullet ? 'Copied ✓' : 'Copy'}
                                </button>
                                <button
                                  onClick={() => { setSelectedBullet(bullet); setShowPitch(false); generateEmail(selectedRole, undefined, bullet) }}
                                  style={{
                                    fontSize: 11, fontWeight: 500,
                                    padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
                                    background: selectedBullet === bullet ? '#050849' : 'transparent',
                                    color: selectedBullet === bullet ? '#fff' : 'var(--brand-400)',
                                    border: '1px solid',
                                    borderColor: selectedBullet === bullet ? '#050849' : 'var(--brand-200)',
                                    whiteSpace: 'nowrap'
                                  }}
                                >
                                  {selectedBullet === bullet ? 'In use ✓' : 'Use in email'}
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {!loadingPitch && (!recommendedRole || !pitchAngles[recommendedRole]) && (
                      <div style={{ fontSize: 13, color: 'var(--slate-400)' }}>No pitch angles yet</div>
                    )}
                  </div>
                )}
              </div>
              <div style={{ marginTop: 8 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.png,.jpg,.jpeg,.pptx"
                  style={{ display: 'none' }}
                  onChange={handleFileSelect}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    fontSize: 12, padding: '4px 10px', cursor: 'pointer',
                    background: 'transparent', color: 'var(--slate-400)',
                    border: '1px solid var(--black-100)', borderRadius: 'var(--radius-sm)',
                    fontWeight: 500
                  }}
                >
                  <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                  </svg>
                  Attach file
                </button>
                {attachments.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {attachments.map((a, i) => (
                      <div key={i} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12,
                        padding: '3px 8px', background: 'var(--black-50)',
                        border: '1px solid var(--black-100)', borderRadius: 4,
                        color: 'var(--text-default)'
                      }}>
                        <span>{a.name}</span>
                        <button
                          onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--slate-400)', padding: 0, fontSize: 15, lineHeight: 1 }}
                        >×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {hasCopied && !linkedInSent && (
                <button
                  onClick={handleMarkLinkedIn}
                  disabled={linkedInSending}
                  style={{
                    marginTop: 10, width: '100%', fontSize: 12, fontWeight: 500,
                    padding: '8px 0', borderRadius: 'var(--radius-sm)', cursor: linkedInSending ? 'default' : 'pointer',
                    background: '#fff', color: 'var(--slate-500)',
                    border: '1px solid var(--black-100)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  }}
                >
                  <svg width="13" height="13" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2z"/>
                    <circle cx="4" cy="4" r="2"/>
                  </svg>
                  {linkedInSending ? 'Recording…' : 'Mark as sent via LinkedIn'}
                </button>
              )}
              {linkedInSent && (
                <div style={{
                  marginTop: 10, fontSize: 12, fontWeight: 500, color: 'var(--green-400)',
                  background: 'var(--green-100)', border: '1px solid var(--green-300)',
                  borderRadius: 'var(--radius-sm)', padding: '8px 14px', textAlign: 'center',
                }}>
                  Recorded in pipeline ✓
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {scheduledTabIds.has(activeTabId) && (
        <div style={{ background: 'var(--brand-100)', border: '1px solid var(--brand-200)', borderRadius: 'var(--radius-md)', padding: '16px 20px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 18 }}>🕐</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#050849' }}>Email scheduled</div>
            <div style={{ fontSize: 12, color: 'var(--brand-400)', marginTop: 2 }}>This email will be sent automatically at the scheduled time. View or cancel in the dashboard.</div>
          </div>
        </div>
      )}

      {email && !sent && !scheduledTabIds.has(activeTabId) && (
        <div style={{ position: 'sticky', bottom: 24, zIndex: 10, display: 'flex', gap: 8 }}>
          <button onClick={() => setShowModal(true)} className="btn btn-primary" style={{ flex: 1, height: 52, fontSize: 15, boxShadow: '0 4px 24px rgba(0,0,0,0.12)' }}>
            Send email
          </button>
          <button onClick={openScheduleModal} disabled title="Scheduled sending is temporarily paused" className="btn btn-secondary" style={{ flex: 1, height: 52, fontSize: 15, boxShadow: '0 4px 24px rgba(0,0,0,0.12)' }}>
            🕐 Scheduled sending paused
          </button>
          <button onClick={() => generateEmail(selectedRole)} disabled={loading} className="btn btn-secondary" style={{ flex: 1, height: 52, fontSize: 15, boxShadow: '0 4px 24px rgba(0,0,0,0.12)' }}>
            Regenerate
          </button>
        </div>
      )}

      {showModal && email && (
        <div className="overlay">
          <div className="modal">
            <div className="modal-head">
              <div className="modal-title">Confirm send</div>
              <div className="modal-sub">Review before sending — this cannot be undone.</div>
            </div>
            <div className="modal-body">
              <div className="summary-row">
                <div className="k">From</div>
                <div className="v">{userEmail || userName || 'Your Gmail account'}</div>
              </div>
              <div className="summary-row">
                <div className="k">To</div>
                <div className="v">{toEmail}</div>
              </div>
              {ccEmail && (
                <div className="summary-row">
                  <div className="k">CC</div>
                  <div className="v">{ccEmail}</div>
                </div>
              )}
              {bccEmail && (
                <div className="summary-row">
                  <div className="k">BCC</div>
                  <div className="v">{bccEmail}</div>
                </div>
              )}
              <div className="summary-row">
                <div className="k">Subject</div>
                <div className="v">{email.subject}</div>
              </div>
              {attachments.length > 0 && (
                <div className="summary-row">
                  <div className="k">Attachments</div>
                  <div className="v" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {attachments.map((a, i) => (
                      <span key={i} style={{ fontSize: 12, padding: '2px 7px', background: 'var(--black-50)', border: '1px solid var(--black-100)', borderRadius: 4 }}>{a.name}</span>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ marginTop: 16 }}>
                <div className="field-label" style={{ marginBottom: 8 }}>Email body</div>
                <div className="email-full">{email.body}</div>
              </div>
            </div>
            <div className="modal-foot">
              <button onClick={() => setShowModal(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={handleSend} disabled={sending || !userGoogleSub} className="btn btn-primary">
                {sending ? 'Sending...' : 'Confirm send'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showScheduleModal && email && (
        <div className="overlay">
          <div className="modal">
            <div className="modal-head">
              <div className="modal-title">Schedule send</div>
              <div className="modal-sub">This email will be sent automatically at the chosen time.</div>
            </div>
            <div className="modal-body">
              {outreachTiming && (
                <div style={{ background: 'var(--brand-100)', border: '1px solid var(--brand-200)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 20, fontSize: 12, color: 'var(--brand-400)' }}>
                  <span style={{ fontWeight: 600 }}>💡 Recommended:</span> {outreachTiming.recommended_day === 'Today' || outreachTiming.recommended_day === 'Tomorrow' ? outreachTiming.recommended_day : outreachTiming.recommended_date} · {outreachTiming.day_reason}
                </div>
              )}
              <div style={{ marginBottom: 16 }}>
                <label className="field-label">Date &amp; time</label>
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={e => setScheduledAt(e.target.value)}
                  className="input"
                  min={new Date().toISOString().slice(0, 16)}
                />
              </div>
              <div style={{ marginBottom: 20 }}>
                <label className="field-label">Timezone</label>
                <select
                  value={scheduleTimezone}
                  onChange={e => setScheduleTimezone(e.target.value)}
                  className="input"
                  style={{ cursor: 'pointer' }}
                >
                  <option value="Australia/Sydney">AEST — Sydney / Melbourne (UTC+10)</option>
                  <option value="Australia/Perth">AWST — Perth (UTC+8)</option>
                  <option value="America/New_York">EST — New York (UTC-5)</option>
                  <option value="America/Los_Angeles">PST — Los Angeles (UTC-8)</option>
                  <option value="America/Chicago">CST — Chicago (UTC-6)</option>
                  <option value="Europe/London">GMT — London (UTC+0)</option>
                  <option value="Europe/Paris">CET — Paris (UTC+1)</option>
                  <option value="Asia/Singapore">SGT — Singapore (UTC+8)</option>
                  <option value="Asia/Tokyo">JST — Tokyo (UTC+9)</option>
                </select>
              </div>
              <div style={{ borderTop: '1px solid var(--black-100)', paddingTop: 16 }}>
                <div className="summary-row"><div className="k">To</div><div className="v">{toEmail || '—'}</div></div>
                <div className="summary-row"><div className="k">Subject</div><div className="v">{email.subject}</div></div>
              </div>
            </div>
            <div className="modal-foot">
              <button onClick={() => setShowScheduleModal(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={handleSchedule} disabled={scheduling || !scheduledAt} className="btn btn-primary">
                {scheduling ? 'Scheduling...' : 'Schedule send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
