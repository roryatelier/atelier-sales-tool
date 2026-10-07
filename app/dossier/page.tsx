'use client'

import { userStorage } from '@/lib/browser-storage'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Dossier {
  brand_name: string
  website: string | null
  revenue_estimate: string | null
  revenue_confidence: string
  retailers: { name: string; confidence: string }[]
  markets: string[]
  category: string
  sku_count_estimate: string | null
  signals: { type: string; description: string; source: string }[]
  icp_score: number
  score_breakdown: {
    annual_revenue: number
    retail_distribution: number
    market_presence: number
    product_category: number
    order_viability: number
  }
  score_explanations?: {
    annual_revenue?: string
    retail_distribution?: string
    market_presence?: string
    product_category?: string
    order_viability?: string
  }
  score_band: string
  data_quality: string
}

interface Tab {
  id: string
  dossier: Dossier
  leadSource: string
}

interface TabUI {
  showAllMarkets: boolean
  showDataHealth: boolean
  alreadyInPipeline: { status: string; date_added: string } | null
  brandSaved: boolean
  saving: boolean
  saved: boolean
  savingBrand: boolean
}

const CRITERIA = [
  { key: 'annual_revenue', label: 'Annual revenue', max: 35, weight: 'high', threshold: 'AUD $50M+ · higher revenue = stronger manufacturing need' },
  { key: 'retail_distribution', label: 'Retail distribution', max: 20, weight: 'high', threshold: 'Sephora · Mecca · Ulta · Net-a-Porter · David Jones · prestige retail globally' },
  { key: 'order_viability', label: 'Order viability', max: 20, weight: 'high', threshold: 'Store count · funding signals · NPD hiring · new launches' },
  { key: 'product_category', label: 'Product category fit', max: 15, weight: 'medium', threshold: 'Skincare · haircare · colour cosmetics · body care · wellness' },
  { key: 'market_presence', label: 'Market presence', max: 10, weight: 'medium', threshold: 'US · AU · international markets · omnichannel presence' },
]

function defaultTabUI(): TabUI {
  return { showAllMarkets: false, showDataHealth: false, alreadyInPipeline: null, brandSaved: false, saving: false, saved: false, savingBrand: false }
}

function getDataHealth(d: Dossier): {
  score: number
  label: string
  dotColor: string
  bg: string
  fg: string
  breakdown: { label: string; points: number; max: number; note: string }[]
} {
  const breakdown: { label: string; points: number; max: number; note: string }[] = []

  const revConf = (d.revenue_confidence ?? '').toLowerCase()
  const revPoints = revConf === 'high' ? 2 : revConf === 'medium' ? 1 : 0
  breakdown.push({ label: 'Revenue confidence', points: revPoints, max: 2, note: revConf || 'unknown' })

  const highRetailers = (d.retailers ?? []).filter(r => (r.confidence ?? '').toLowerCase() === 'high').length
  const retailPoints = highRetailers >= 2 ? 2 : highRetailers === 1 ? 1 : 0
  breakdown.push({ label: 'Verified retailers', points: retailPoints, max: 2, note: `${highRetailers} high-confidence` })

  const sigLen = (d.signals ?? []).length
  const sigPoints = sigLen >= 5 ? 2 : sigLen >= 3 ? 1 : 0
  breakdown.push({ label: 'Market signals', points: sigPoints, max: 2, note: `${sigLen} found` })

  const mktLen = (d.markets ?? []).length
  const mktPoints = mktLen >= 3 ? 1 : 0
  breakdown.push({ label: 'Market presence', points: mktPoints, max: 1, note: `${mktLen} market${mktLen !== 1 ? 's' : ''}` })

  const dq = (d.data_quality ?? '').toLowerCase()
  const dqPoints = dq === 'sufficient' ? 1 : dq === 'insufficient' ? -1 : 0
  breakdown.push({ label: 'Data quality', points: dqPoints, max: 1, note: dq || 'unknown' })

  const webPoints = d.website ? 1 : 0
  breakdown.push({ label: 'Website', points: webPoints, max: 1, note: d.website ? 'found' : 'not found' })

  const score = Math.max(0, breakdown.reduce((s, b) => s + b.points, 0))

  let label: string, dotColor: string, bg: string, fg: string
  if (score >= 8) {
    label = 'Excellent'; dotColor = '#1d9e75'; bg = '#e1f5ee'; fg = '#0f6e56'
  } else if (score >= 5) {
    label = 'Good'; dotColor = '#e8930a'; bg = '#fdf3e0'; fg = '#854f0b'
  } else if (score >= 3) {
    label = 'Limited'; dotColor = '#9b7d2e'; bg = '#f5f0e4'; fg = '#7a5e1a'
  } else {
    label = 'Sparse'; dotColor = '#cc3333'; bg = '#fcebeb'; fg = '#a32d2d'
  }

  return { score, label, dotColor, bg, fg, breakdown }
}

function getBandClass(band: string): string {
  return { Hot: 'band band-hot', Warm: 'band band-warm', Watch: 'band band-watch', Pass: 'band band-pass' }[band] ?? 'band band-watch'
}

export default function DossierPage() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string>('')
  const [tabUI, setTabUI] = useState<Record<string, TabUI>>({})
  const [backTo, setBackTo] = useState<string | null>(null)
  const router = useRouter()

  const activeTab = tabs.find(t => t.id === activeTabId) ?? null
  const dossier = activeTab?.dossier ?? null
  const leadSource = activeTab?.leadSource ?? 'Outbound'
  const ui = tabUI[activeTabId] ?? defaultTabUI()

  useEffect(() => {
    const back = userStorage.getItem('dossier_back')
    if (back) { setBackTo(back); userStorage.removeItem('dossier_back') }

    const stored = userStorage.getItem('dossier_tabs')
    const storedActive = userStorage.getItem('dossier_active_tab')
    const newDossierRaw = userStorage.getItem('current_dossier')

    let existingTabs: Tab[] = []
    if (stored) {
      try { existingTabs = JSON.parse(stored) } catch {}
    }

    if (newDossierRaw) {
      userStorage.removeItem('current_dossier')
      const newDossier: Dossier = JSON.parse(newDossierRaw)
      const existingTab = existingTabs.find(t =>
        t.dossier.brand_name.toLowerCase() === newDossier.brand_name.toLowerCase()
      )

      if (existingTab) {
        const updatedTabs = existingTabs.map(t => t.id === existingTab.id ? { ...t, dossier: newDossier } : t)
        setTabs(updatedTabs)
        setActiveTabId(existingTab.id)
        userStorage.setItem('dossier_tabs', JSON.stringify(updatedTabs))
        userStorage.setItem('dossier_active_tab', existingTab.id)
        document.title = `${newDossier.brand_name} — Atelier`
        checkPipelineStatus(newDossier.brand_name, existingTab.id)
        checkIfSaved(newDossier.brand_name, existingTab.id)
        existingTabs.filter(t => t.id !== existingTab.id).forEach(t => {
          checkPipelineStatus(t.dossier.brand_name, t.id)
          checkIfSaved(t.dossier.brand_name, t.id)
        })
      } else {
        const newId = `tab_${Date.now()}`
        const newTab: Tab = { id: newId, dossier: newDossier, leadSource: userStorage.getItem('lead_source') ?? 'Outbound' }
        const updatedTabs = [...existingTabs, newTab]
        setTabs(updatedTabs)
        setActiveTabId(newId)
        userStorage.setItem('dossier_tabs', JSON.stringify(updatedTabs))
        userStorage.setItem('dossier_active_tab', newId)
        document.title = `${newDossier.brand_name} — Atelier`
        checkPipelineStatus(newDossier.brand_name, newId)
        checkIfSaved(newDossier.brand_name, newId)
        existingTabs.forEach(t => {
          checkPipelineStatus(t.dossier.brand_name, t.id)
          checkIfSaved(t.dossier.brand_name, t.id)
        })
      }
    } else if (existingTabs.length > 0) {
      setTabs(existingTabs)
      const activeId = storedActive && existingTabs.find(t => t.id === storedActive)
        ? storedActive
        : existingTabs[0].id
      setActiveTabId(activeId)
      const activeD = existingTabs.find(t => t.id === activeId)
      if (activeD) document.title = `${activeD.dossier.brand_name} — Atelier`
      existingTabs.forEach(t => {
        checkPipelineStatus(t.dossier.brand_name, t.id)
        checkIfSaved(t.dossier.brand_name, t.id)
      })
    } else {
      router.push('/')
    }
  }, [router])

  useEffect(() => {
    if (tabs.length > 0) {
      userStorage.setItem('dossier_tabs', JSON.stringify(tabs))
    }
  }, [tabs])

  useEffect(() => {
    if (activeTabId) {
      userStorage.setItem('dossier_active_tab', activeTabId)
    }
  }, [activeTabId])

  function updateUI(tabId: string, update: Partial<TabUI>) {
    setTabUI(prev => ({ ...prev, [tabId]: { ...(prev[tabId] ?? defaultTabUI()), ...update } }))
  }

  async function checkPipelineStatus(brandName: string, tabId: string) {
    try {
      const res = await fetch('/api/pipeline')
      const data = await res.json()
      if (data.success) {
        const existing = data.leads.find((l: { brand_name: string; status: string; date_added: string }) =>
          l.brand_name.toLowerCase() === brandName.toLowerCase()
        )
        if (existing) updateUI(tabId, { alreadyInPipeline: { status: existing.status, date_added: existing.date_added } })
      }
    } catch {}
  }

  async function checkIfSaved(brandName: string, tabId: string) {
    try {
      const res = await fetch('/api/saved-suggestions')
      const data = await res.json()
      if (data.success) {
        const exists = data.suggestions.some((s: { brand_name: string }) =>
          s.brand_name.toLowerCase() === brandName.toLowerCase()
        )
        if (exists) updateUI(tabId, { brandSaved: true })
      }
    } catch {}
  }

  function switchTab(tabId: string) {
    setActiveTabId(tabId)
    const tab = tabs.find(t => t.id === tabId)
    if (tab) document.title = `${tab.dossier.brand_name} — Atelier`
  }

  function closeTab(tabId: string) {
    const idx = tabs.findIndex(t => t.id === tabId)
    const newTabs = tabs.filter(t => t.id !== tabId)
    setTabUI(prev => { const n = { ...prev }; delete n[tabId]; return n })
    setTabs(newTabs)

    if (newTabs.length === 0) {
      userStorage.removeItem('dossier_tabs')
      userStorage.removeItem('dossier_active_tab')
      router.push('/')
      return
    }

    userStorage.setItem('dossier_tabs', JSON.stringify(newTabs))
    if (tabId === activeTabId) {
      const nextTab = newTabs[Math.max(0, idx - 1)]
      setActiveTabId(nextTab.id)
      document.title = `${nextTab.dossier.brand_name} — Atelier`
    }
  }

  function setLeadSourceForTab(source: string) {
    if (!activeTabId) return
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, leadSource: source } : t))
  }

  function handleProceed() {
    if (!dossier) return
    userStorage.setItem('current_dossier', JSON.stringify(dossier))
    userStorage.setItem('lead_source', leadSource)
    router.push('/contacts')
  }

  function handlePass() {
    router.push('/')
  }

  function navigateToEmail() {
    if (!dossier) return
    userStorage.setItem('current_dossier', JSON.stringify(dossier))
    router.push('/email')
  }

  async function handleSave() {
    if (!dossier) return
    updateUI(activeTabId, { saving: true })
    try {
      await fetch('/api/save-to-sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand_name: dossier.brand_name,
          website: dossier.website,
          lead_source: leadSource,
          revenue_estimate: dossier.revenue_estimate,
          retailers: dossier.retailers,
          category: dossier.category,
          icp_score: dossier.icp_score,
          score_band: dossier.score_band,
          signals: dossier.signals,
          target_role: '',
          contact_name: '',
          email_subject: '',
          email_body: '',
          status: 'Researched'
        })
      })
      updateUI(activeTabId, { saving: false, saved: true })
      setTimeout(() => updateUI(activeTabId, { saved: false }), 5000)
    } catch {
      updateUI(activeTabId, { saving: false })
    }
  }

  async function saveBrand() {
    if (!dossier) return
    updateUI(activeTabId, { savingBrand: true })
    try {
      await fetch('/api/saved-suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand_name: dossier.brand_name,
          category: dossier.category ?? 'Beauty',
          reason: `ICP Score: ${dossier.icp_score} (${dossier.score_band})`,
          signal: dossier.signals?.[0]?.description?.replace(/\*\*/g, '').slice(0, 80) ?? 'Saved from dossier'
        })
      })
      updateUI(activeTabId, { savingBrand: false, brandSaved: true })
    } catch {
      updateUI(activeTabId, { savingBrand: false })
    }
  }

  if (!dossier || tabs.length === 0) return null

  const bandClass = getBandClass(dossier.score_band)
  const scoreColour = dossier.icp_score >= 80
    ? 'var(--green-400)'
    : dossier.icp_score >= 60
    ? 'var(--orange-400)'
    : 'var(--red-500)'
  const revenueShort = dossier.revenue_estimate
    ? dossier.revenue_estimate.split('(')[0].split('.')[0].trim()
    : 'Unknown'

  return (
    <div style={{ zoom: 0.8 }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'stretch',
        borderBottom: '1px solid var(--black-100)',
        marginBottom: 20, marginLeft: -36, marginRight: -36,
        paddingLeft: 36, overflowX: 'auto'
      }}>
        {tabs.map(tab => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 16px',
                borderBottom: isActive ? '2px solid #050849' : '2px solid transparent',
                marginBottom: -1,
                cursor: 'pointer', flexShrink: 0,
                fontSize: 13,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? 'var(--text-default)' : 'var(--slate-400)',
                userSelect: 'none',
              }}
            >
              <span>{tab.dossier.brand_name}</span>
              <span className={getBandClass(tab.dossier.score_band)} style={{ fontSize: 10, padding: '1px 6px', lineHeight: 1.6 }}>
                {tab.dossier.score_band}
              </span>
              {tabs.length > 1 && (
                <span
                  onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                  style={{
                    fontSize: 16, lineHeight: 1, color: 'var(--slate-300)',
                    cursor: 'pointer', padding: '0 2px', marginLeft: 2,
                    display: 'flex', alignItems: 'center'
                  }}
                >
                  ×
                </span>
              )}
            </div>
          )
        })}
        <button
          onClick={() => router.push('/')}
          title="Research a new brand"
          style={{
            padding: '8px 14px', background: 'none', border: 'none',
            cursor: 'pointer', fontSize: 20, color: 'var(--slate-400)',
            display: 'flex', alignItems: 'center', flexShrink: 0, lineHeight: 1
          }}
        >
          +
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {backTo === 'portfolio' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <button onClick={() => router.push('/portfolio')} className="btn btn-ghost btn-sm" style={{ padding: '2px 6px' }}>
                Brand Search
              </button>
              <span style={{ color: 'var(--slate-300)' }}>›</span>
              <span style={{ color: 'var(--text-default)', fontWeight: 500 }}>{dossier?.brand_name}</span>
            </div>
          ) : (
            <button onClick={() => router.push('/portfolio')} className="btn btn-ghost btn-sm">
              ← Brand Search
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={navigateToEmail} className="btn btn-secondary btn-sm">
            Generate email
          </button>
          <button
            onClick={() => window.print()}
            className="btn btn-secondary btn-sm"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <polyline points="6,9 6,2 18,2 18,9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" strokeWidth="2"/>
              <rect x="6" y="14" width="12" height="8" strokeWidth="2"/>
            </svg>
            Export PDF
          </button>
        </div>
      </div>

      {ui.alreadyInPipeline && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--brand-100)', border: '1px solid var(--brand-200)', borderRadius: 'var(--radius-md)', padding: '12px 16px', marginBottom: 16 }}>
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--brand-400)', flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10" strokeWidth="2"/>
            <line x1="12" y1="8" x2="12" y2="12" strokeWidth="2" strokeLinecap="round"/>
            <line x1="12" y1="16" x2="12.01" y2="16" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <div style={{ fontSize: 13, color: 'var(--brand-400)' }}>
            <span style={{ fontWeight: 600 }}>Already in your pipeline</span> — added {ui.alreadyInPipeline.date_added} with status <span style={{ fontWeight: 600 }}>{ui.alreadyInPipeline.status}</span>. Saving again will create a duplicate.
          </div>
          <button onClick={() => router.push('/pipeline')} className="btn btn-secondary btn-sm" style={{ flexShrink: 0, marginLeft: 'auto' }}>
            View in pipeline
          </button>
        </div>
      )}

      {dossier.data_quality === 'insufficient' && (
        <div className="data-warning" style={{ marginBottom: 20 }}>
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ flexShrink: 0, marginTop: 1 }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" strokeWidth="2"/>
            <line x1="12" y1="9" x2="12" y2="13" strokeWidth="2" strokeLinecap="round"/>
            <line x1="12" y1="17" x2="12.01" y2="17" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Limited ANZ data found. Verify before outreach.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 32, fontWeight: 500, letterSpacing: '-0.5px', margin: 0 }}>{dossier.brand_name}</h1>
          <span className={bandClass}>{dossier.score_band}</span>
          {(() => {
            const dh = getDataHealth(dossier)
            return (
              <button
                onClick={() => updateUI(activeTabId, { showDataHealth: !ui.showDataHealth })}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '3px 10px', borderRadius: 20,
                  background: dh.bg, color: dh.fg,
                  border: 'none', cursor: 'pointer',
                  fontSize: 11, fontWeight: 600, letterSpacing: '0.02em',
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: dh.dotColor, flexShrink: 0, display: 'inline-block' }} />
                Data Health: {dh.label}
              </button>
            )
          })()}
        </div>
        <div style={{ textAlign: 'right', width: 220, flexShrink: 0 }}>
          <div className="kv-label">Category</div>
          <div style={{ fontSize: 13, color: 'var(--text-default)', lineHeight: 1.4 }}>
            {dossier.category.split(/[,(]/)[0].trim().replace(/\.$/, '')}
          </div>
        </div>
      </div>

      {dossier.website && (
        <a href={dossier.website} target="_blank" rel="noreferrer"
          style={{ fontSize: 13, color: 'var(--slate-400)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: ui.showDataHealth ? 12 : 28 }}>
          {dossier.website.replace('https://', '')}
          <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeWidth="2" strokeLinecap="round"/>
            <polyline points="15,3 21,3 21,9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <line x1="10" y1="14" x2="21" y2="3" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </a>
      )}

      {ui.showDataHealth && (() => {
        const dh = getDataHealth(dossier)
        const summaryText: Record<string, string> = {
          Excellent: 'Rich public data available — high confidence in research findings.',
          Good: 'Sufficient data for outreach — most key details are verified.',
          Limited: 'Some gaps in public data — verify key details before outreach.',
          Sparse: 'Niche or private brand — manual research recommended before outreach.',
        }
        return (
          <div style={{
            marginBottom: 20,
            background: 'var(--black-50, #f9f9f8)', border: '1px solid var(--black-100, #ebebea)',
            borderRadius: 8, padding: '12px 16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--slate-400)' }}>
                Data Health Breakdown
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: dh.fg }}>{dh.score} / 9</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {dh.breakdown.map(item => (
                <div key={item.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-secondary, #6b6b68)' }}>{item.label}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: 'var(--slate-400)', fontSize: 11 }}>{item.note}</span>
                    <span style={{
                      fontWeight: 600, minWidth: 24, textAlign: 'right', fontSize: 12,
                      color: item.points > 0 ? '#1d9e75' : item.points < 0 ? '#cc3333' : 'var(--slate-300)',
                    }}>
                      {item.points > 0 ? `+${item.points}` : item.points}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ borderTop: '1px solid var(--black-100, #ebebea)', marginTop: 10, paddingTop: 8, fontSize: 12, color: 'var(--slate-400)' }}>
              {summaryText[dh.label] ?? ''}
            </div>
          </div>
        )
      })()}

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 48 }}>
          <div style={{ width: 160, flexShrink: 0 }}>
            <div className="kv-label">ICP Score</div>
            <div className="score-big" style={{ color: scoreColour }}>{dossier.icp_score}</div>
            <div style={{ fontSize: 16, color: 'var(--slate-400)' }}>/ 100</div>
            <div style={{ display: 'flex', gap: 3, marginTop: 12, marginBottom: 6 }}>
              {CRITERIA.map(c => {
                const val = dossier.score_breakdown[c.key as keyof typeof dossier.score_breakdown]
                const pct = val / c.max
                const bg = pct >= 0.8 ? 'var(--green-400)' : pct >= 0.5 ? 'var(--orange-400)' : 'var(--slate-300)'
                return <div key={c.key} style={{ height: 4, flex: 1, borderRadius: 2, background: bg }} />
              })}
            </div>
            <div style={{ fontSize: 11, color: 'var(--slate-400)' }}>{dossier.icp_score} of 100 across 5 criteria</div>
          </div>

          <div style={{ flex: 1 }}>
            <table className="crit-table">
              <thead>
                <tr>
                  <th>Criterion</th>
                  <th style={{ width: 110 }}>Score</th>
                  <th style={{ width: 80 }}>Achieved</th>
                </tr>
              </thead>
              <tbody>
                {CRITERIA.map(c => {
                  const val = dossier.score_breakdown[c.key as keyof typeof dossier.score_breakdown]
                  const pct = (val / c.max) * 100
                  const valColour = pct >= 80 ? 'var(--green-400)' : pct >= 50 ? 'var(--orange-400)' : 'var(--red-500)'
                  const explanation = dossier.score_explanations?.[c.key as keyof typeof dossier.score_explanations]
                  return (
                    <CriteriaRow
                      key={c.key}
                      label={c.label}
                      threshold={c.threshold}
                      val={val}
                      max={c.max}
                      pct={pct}
                      valColour={valColour}
                      weight={c.weight}
                      explanation={explanation}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="section-label">Brand Details</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 32 }}>
          <div>
            <div className="kv-label">Revenue Estimate</div>
            <div style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>{revenueShort}</div>
            <div className={`confidence conf-${dossier.revenue_confidence}`}>
              <span className="dot" />
              {dossier.revenue_confidence.charAt(0).toUpperCase() + dossier.revenue_confidence.slice(1)} confidence
            </div>
          </div>
          <div>
            <div className="kv-label">Retailers</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {dossier.retailers
                .filter(r => r.confidence === 'high' || r.confidence === 'medium')
                .map((r, i) => (
                  <span key={i} className="tag" style={{ fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: '#050849', color: '#fff', borderColor: '#050849' }}>
                    {r.name.split('(')[0].trim()}
                  </span>
                ))}
            </div>
          </div>
          <div>
            <div className="kv-label">Markets</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(ui.showAllMarkets ? dossier.markets : dossier.markets.slice(0, 4)).map((m, i) => (
                <span key={i} className="tag" style={{ fontSize: 12, background: '#050849', color: '#fff', borderColor: '#050849' }}>{m}</span>
              ))}
              {dossier.markets.length > 4 && !ui.showAllMarkets && (
                <span
                  onClick={() => updateUI(activeTabId, { showAllMarkets: true })}
                  className="tag"
                  style={{ fontSize: 12, background: '#050849', color: '#fff', borderColor: '#050849', cursor: 'pointer', opacity: 0.7 }}
                >
                  +{dossier.markets.length - 4} more
                </span>
              )}
              {ui.showAllMarkets && (
                <span
                  onClick={() => updateUI(activeTabId, { showAllMarkets: false })}
                  style={{ fontSize: 12, color: 'var(--slate-400)', cursor: 'pointer', textDecoration: 'underline', display: 'flex', alignItems: 'center' }}
                >
                  Show less
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="kv-label">SKU Count</div>
            <div style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>
              {dossier.sku_count_estimate
                ? dossier.sku_count_estimate.match(/[\d,]+\+?/)?.[0] ?? dossier.sku_count_estimate.split(' ').slice(0, 3).join(' ')
                : 'Unknown'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--slate-400)' }}>active SKUs</div>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <div className="section-label">Key Signals</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          {dossier.signals.map((s, i) => {
            const bullets = s.description.split(/\.\s+(?=[A-Z])/).filter(b => b.trim().length > 0).slice(0, 3)
            return (
              <div key={i} className="card-hair" style={{ padding: '14px 16px' }}>
                <div style={{ textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: 11, fontWeight: 700, color: 'var(--brand-400)', marginBottom: 8 }}>
                  {s.type.replace(/_/g, ' ')}
                </div>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {bullets.map((bullet, j) => (
                    <li key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: 'var(--text-default)', lineHeight: 1.4 }}>
                      <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--slate-400)', flexShrink: 0, marginTop: 6 }} />
                      <span dangerouslySetInnerHTML={{ __html: bullet.trim().replace(/\.$/, '').replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight:600;color:var(--text-default)">$1</strong>') }} />
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ position: 'sticky', bottom: 24, zIndex: 10, background: '#fff', padding: '12px 0', borderTop: '1px solid var(--black-100)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--slate-400)', fontWeight: 500 }}>Lead source:</span>
          <div className="role-row" style={{ margin: 0 }}>
            {['Outbound', 'Inbound', 'Referral'].map(source => (
              <button
                key={source}
                onClick={() => setLeadSourceForTab(source)}
                className={`role-btn ${leadSource === source ? 'active' : ''}`}
                style={{ padding: '4px 12px', fontSize: 12 }}
              >
                {source}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={handleProceed} className="btn btn-primary" style={{ flex: 1, height: 48, boxShadow: '0 4px 24px rgba(0,0,0,0.12)' }}>
            Find contacts
          </button>
          <button
            onClick={saveBrand}
            disabled={ui.savingBrand || ui.brandSaved}
            style={{
              flex: 1, height: 48, cursor: ui.brandSaved ? 'default' : 'pointer',
              background: ui.brandSaved ? 'var(--green-100)' : '#fff',
              border: '1px solid', borderColor: ui.brandSaved ? 'var(--green-300)' : 'var(--black-100)',
              borderRadius: 'var(--radius-sm)', fontSize: 13, fontWeight: 500,
              color: ui.brandSaved ? 'var(--green-400)' : 'var(--slate-500)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, boxShadow: '0 4px 24px rgba(0,0,0,0.12)'
            }}
          >
            <svg width="14" height="14" fill={ui.brandSaved ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {ui.savingBrand ? 'Saving...' : ui.brandSaved ? 'Saved' : 'Save brand'}
          </button>
        </div>
        {ui.saved && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, color: 'var(--green-400)', fontSize: 13, fontWeight: 500 }}>
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <polyline points="20,6 9,17 4,12" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Saved to pipeline as {leadSource}
          </div>
        )}
      </div>
    </div>
  )
}

function CriteriaRow({ label, threshold, val, max, pct, valColour, weight, explanation }: {
  label: string
  threshold: string
  val: number
  max: number
  pct: number
  valColour: string
  weight: string
  explanation?: string
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <tr
        onClick={() => explanation && setExpanded(!expanded)}
        style={{ cursor: explanation ? 'pointer' : 'default' }}
      >
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: 13 }}>{label}</div>
              <div style={{ fontSize: 11, color: 'var(--slate-400)', marginTop: 2 }}>{threshold}</div>
            </div>
            {explanation && (
              <svg
                width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ color: 'var(--slate-400)', flexShrink: 0, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
              >
                <polyline points="6,9 12,15 18,9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </div>
        </td>
        <td>
          <div className="crit-bar">
            <span style={{ width: `${pct}%` }} />
          </div>
        </td>
        <td style={{ color: valColour, fontWeight: 500, fontSize: 13 }}>{val} / {max}</td>
      </tr>
      {expanded && explanation && (
        <tr>
          <td colSpan={3} style={{ paddingTop: 0, paddingBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--slate-500)', background: 'var(--slate-100)', padding: '8px 12px', borderRadius: 'var(--radius-sm)', lineHeight: 1.5 }}>
              {explanation}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
