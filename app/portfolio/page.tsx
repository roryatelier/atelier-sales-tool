'use client'

import { userStorage } from '@/lib/browser-storage'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface PortfolioDossier {
  brand_name: string
  website?: string | null
  revenue_estimate?: string | null
  category: string
  icp_score: number
  score_band: string
  signals?: { type: string; description: string }[]
  updated_at: string
}

interface QueueItem {
  brand_name: string
  category: string
  reason: string
  signal: string
}

interface SavedItem {
  brand_name: string
  category: string
  reason: string
  signal: string
}

type Detail =
  | { kind: 'empty' }
  | { kind: 'preview'; dossier: PortfolioDossier }
  | { kind: 'researching'; brandName: string }
  | { kind: 'saved-preview'; brand: SavedItem }

const ICP_COLOR = (s: number) =>
  s >= 80 ? '#1d9e75' : s >= 60 ? '#e8930a' : s >= 45 ? '#888888' : '#cc3333'

const BADGE: Record<string, { bg: string; fg: string }> = {
  Hot:  { bg: '#e1f5ee', fg: '#0f6e56' },
  Warm: { bg: '#faeeda', fg: '#854f0b' },
  Watch:{ bg: '#f1efe8', fg: '#5f5e5a' },
  Pass: { bg: '#fcebeb', fg: '#a32d2d' },
}

function Chip({ band }: { band: string }) {
  const s = BADGE[band] ?? BADGE.Watch
  return (
    <span style={{
      background: s.bg, color: s.fg,
      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase', padding: '2px 6px', borderRadius: 4,
      flexShrink: 0, display: 'inline-block',
    }}>
      {band}
    </span>
  )
}

export default function PortfolioPage() {
  const [dossiers, setDossiers]         = useState<PortfolioDossier[]>([])
  const [savedBrands, setSavedBrands]   = useState<SavedItem[]>([])
  const [queue, setQueue]               = useState<QueueItem[]>([])
  const [loading, setLoading]           = useState(true)
  const [loadingSugg, setLoadingSugg]   = useState(false)
  const [search, setSearch]             = useState('')
  const [selected, setSelected]         = useState<string | null>(null)
  const [detail, setDetail]             = useState<Detail>({ kind: 'empty' })
  const [savedSet, setSavedSet]         = useState<Set<string>>(new Set())
  const [savingSet, setSavingSet]       = useState<Set<string>>(new Set())
  const [actionError, setActionError]   = useState('')
  const router = useRouter()

  useEffect(() => {
    document.body.classList.add('portfolio-page')
    document.title = 'Brand Search — Atelier'
    return () => document.body.classList.remove('portfolio-page')
  }, [])

  useEffect(() => {
    Promise.all([
      fetch('/api/portfolio').then(r => r.json()),
      fetch('/api/saved-suggestions').then(r => r.json()),
      fetch('/api/pipeline').then(r => r.json()),
    ]).then(([pd, sd, pl]) => {
      if (pd.success) setDossiers(pd.dossiers)
      if (sd.success) {
        const pipelineNames = new Set(
          (pl.leads ?? []).map((l: { brand_name: string }) => l.brand_name.toLowerCase())
        )
        const filtered = (sd.suggestions as SavedItem[]).filter(
          s => !pipelineNames.has(s.brand_name.toLowerCase())
        )
        setSavedBrands(filtered)
      }
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const typing = search.trim().length > 0

  const visibleSaved = savedBrands
    .filter(s => !typing || s.brand_name.toLowerCase().includes(search.toLowerCase()))

  const exactMatch = dossiers.some(
    d => d.brand_name.toLowerCase() === search.trim().toLowerCase()
  )
  const showResearch = typing && !exactMatch

  function pickDossier(d: PortfolioDossier) {
    setSelected(d.brand_name)
    setDetail({ kind: 'preview', dossier: d })
  }

  async function research(brandName: string) {
    const previousDetail = detail
    setActionError('')
    setSelected(brandName)
    setDetail({ kind: 'researching', brandName })
    try {
      const res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand_name: brandName }),
      })
      const data = await res.json()
      if (data.dossier) {
        const d: PortfolioDossier = { ...data.dossier, updated_at: new Date().toISOString() }
        setDossiers(prev => {
          const idx = prev.findIndex(x => x.brand_name.toLowerCase() === brandName.toLowerCase())
          if (idx >= 0) { const n = [...prev]; n[idx] = d; return n }
          return [d, ...prev]
        })
        setDetail({ kind: 'preview', dossier: d })
        setSearch('')
      } else {
        setDetail(previousDetail)
        setActionError(data.error?.message ?? 'Brand research is unavailable. Try again.')
      }
    } catch {
      setDetail(previousDetail)
      setActionError('Brand research is unavailable. Check your connection and try again.')
    }
  }

  function openDossier(d: PortfolioDossier) {
    userStorage.setItem('current_dossier', JSON.stringify(d))
    userStorage.setItem('dossier_back', 'portfolio')
    router.push('/dossier')
  }

  function openSavedBrand(brand: SavedItem) {
    const existing = dossiers.find(d => d.brand_name.toLowerCase() === brand.brand_name.toLowerCase())
    if (existing) {
      pickDossier(existing)
    } else {
      setSelected(brand.brand_name)
      setDetail({ kind: 'saved-preview', brand })
    }
  }

  async function getAiSuggestions() {
    if (loadingSugg) return
    setLoadingSugg(true)
    setActionError('')
    try {
      const res = await fetch('/api/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excludeBrands: dossiers.map(d => d.brand_name) }),
      })
      const data = await res.json()
      if (data.success) {
        const fresh = (data.suggestions ?? []) as QueueItem[]
        setQueue(prev => {
          const seen = new Set(prev.map(q => q.brand_name.toLowerCase()))
          return [...prev, ...fresh.filter(s => !seen.has(s.brand_name.toLowerCase()))]
        })
      } else setActionError(data.error?.message ?? 'AI suggestions are unavailable. Try again.')
    } catch {
      setActionError('AI suggestions are unavailable. Check your connection and try again.')
    } finally {
      setLoadingSugg(false)
    }
  }

  async function removeQueue(item: QueueItem) {
    if (savedSet.has(item.brand_name)) {
      await fetch(
        `/api/saved-suggestions?brand_name=${encodeURIComponent(item.brand_name)}`,
        { method: 'DELETE' }
      ).catch(() => {})
    }
    setQueue(prev => prev.filter(q => q.brand_name !== item.brand_name))
  }

  async function saveQueueItem(item: QueueItem) {
    setSavingSet(prev => new Set([...prev, item.brand_name]))
    try {
      await fetch('/api/saved-suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand_name: item.brand_name, category: item.category, reason: item.reason, signal: item.signal }),
      })
      setSavedSet(prev => new Set([...prev, item.brand_name]))
    } catch {} finally {
      setSavingSet(prev => { const n = new Set(prev); n.delete(item.brand_name); return n })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: '#fff', zoom: 0.8 }}>

      {/* ══════════════════════════════════════════
          TOP — full-width hero search
      ══════════════════════════════════════════ */}
      <div style={{
        flexShrink: 0,
        padding: '40px 36px 24px',
        borderBottom: '0.5px solid var(--black-100)',
        background: '#fff',
      }}>
        <div className="page-eyebrow">Brand Search</div>
        <h1 className="page-title" style={{ marginBottom: 4 }}>Brand Search</h1>
        <p className="page-sub" style={{ marginBottom: 24 }}>
          Search any brand to research or preview existing dossiers
        </p>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{
              position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
              width: 16, height: 16, color: 'var(--slate-400)', pointerEvents: 'none',
            }}>
              <circle cx="11" cy="11" r="8" strokeWidth="2"/>
              <path d="m21 21-4.35-4.35" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && showResearch) research(search.trim()) }}
              placeholder="Search any brand…"
              autoFocus
              style={{
                width: '100%', height: 48,
                paddingLeft: 42, paddingRight: search ? 36 : 16,
                fontSize: 15, border: '0.5px solid var(--black-100)',
                borderRadius: 10, outline: 'none', background: '#fff',
                color: 'var(--text-default)', boxSizing: 'border-box',
              }}
            />
            {search && (
              <button onClick={() => setSearch('')} style={{
                position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--slate-400)', fontSize: 18, lineHeight: 1, padding: 0,
              }}>×</button>
            )}
          </div>
          {showResearch && (
            <button
              onClick={() => research(search.trim())}
              style={{
                height: 48, padding: '0 22px', flexShrink: 0,
                background: '#050849', color: '#fff',
                border: 'none', borderRadius: 10, cursor: 'pointer',
                fontSize: 14, fontWeight: 600,
              }}
            >
              Research
            </button>
          )}
        </div>
        {actionError && (
          <div role="alert" style={{ marginTop: 12, background: 'var(--red-100)', border: '1px solid var(--red-300)', borderRadius: 8, padding: '10px 12px', color: 'var(--red-500)', fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>{actionError}</span>
            <button onClick={() => setActionError('')} aria-label="Dismiss error" style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer' }}>×</button>
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════
          MIDDLE — 50/50 split pane
      ══════════════════════════════════════════ */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>

        {/* Left: saved brands */}
        <div style={{
          width: '50%', flexShrink: 0,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          alignSelf: 'stretch',
        }}>

          {/* Header row */}
          <div style={{
            flexShrink: 0,
            padding: '10px 16px',
            borderBottom: '0.5px solid var(--black-100)',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#050849', opacity: 0.55 }}>
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--slate-500)' }}>
              Saved
            </span>
            <span style={{ fontSize: 11, color: 'var(--slate-400)', marginLeft: 2 }}>
              {visibleSaved.length}
            </span>
          </div>

          {/* Scrollable saved brand rows */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {loading && (
              <div style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--slate-400)' }}>
                <div className="spinner" />Loading…
              </div>
            )}

            {/* Research [brand] row */}
            {showResearch && (
              <div
                onClick={() => research(search.trim())}
                style={{
                  padding: '11px 16px', cursor: 'pointer',
                  borderBottom: '0.5px solid var(--black-100)',
                  display: 'flex', alignItems: 'center', gap: 10,
                  color: '#050849', fontWeight: 600, fontSize: 13,
                  background: selected === search.trim() ? 'rgba(5,8,73,0.04)' : 'var(--slate-100)',
                  borderLeft: selected === search.trim() ? '2px solid #050849' : '2px solid transparent',
                }}
              >
                <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ flexShrink: 0, opacity: 0.7 }}>
                  <circle cx="11" cy="11" r="8" strokeWidth="2"/>
                  <path d="m21 21-4.35-4.35" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                Research &ldquo;{search.trim()}&rdquo;
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--slate-400)', fontWeight: 400 }}>not saved</span>
              </div>
            )}

            {!loading && visibleSaved.length === 0 && !showResearch && (
              <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 12, color: 'var(--slate-400)' }}>
                {typing ? 'No saved brands match your search' : 'No saved brands yet'}
              </div>
            )}

            {visibleSaved.map((s, i) => {
              const active = selected === s.brand_name
              return (
                <div
                  key={`saved-${i}-${s.brand_name}`}
                  onClick={() => openSavedBrand(s)}
                  style={{
                    padding: '10px 16px 10px 14px',
                    borderBottom: '0.5px solid var(--black-100)',
                    cursor: 'pointer',
                    background: active ? 'rgba(5,8,73,0.04)' : 'transparent',
                    borderLeft: active ? '2px solid #050849' : '2px solid transparent',
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: active ? 600 : 400,
                      color: 'var(--text-default)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {s.brand_name}
                    </div>
                    <div style={{
                      fontSize: 11, color: 'var(--slate-400)', marginTop: 1,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {s.category.split(/[,(]/)[0].trim()}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Right: detail preview pane */}
        <div style={{ width: '50%', overflowY: 'auto', alignSelf: 'stretch', background: '#fff', borderLeft: '0.5px solid var(--black-100)' }}>

          {detail.kind === 'empty' && (
            <div style={{
              height: '100%', display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              padding: 40, textAlign: 'center',
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: 10,
                background: 'var(--slate-100)', border: '0.5px solid var(--black-100)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: 16,
              }}>
                <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--slate-400)' }}>
                  <circle cx="11" cy="11" r="8" strokeWidth="1.5"/>
                  <path d="m21 21-4.35-4.35" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </div>
              <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-default)', marginBottom: 6 }}>
                Select a brand to preview
              </div>
              <div style={{ fontSize: 13, color: 'var(--slate-400)', maxWidth: 260, lineHeight: 1.6 }}>
                Click any brand in the list, or search and research a new one.
              </div>
            </div>
          )}

          {detail.kind === 'researching' && (
            <div style={{
              height: '100%', display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              padding: 40, textAlign: 'center',
            }}>
              <div className="spinner" style={{ marginBottom: 24 }} />
              <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-default)', marginBottom: 8 }}>
                {detail.brandName}
              </div>
              <div style={{ fontSize: 13, color: 'var(--slate-400)', lineHeight: 1.7 }}>
                Analysing ICP fit, ANZ distribution,<br />formulation complexity
              </div>
            </div>
          )}

          {detail.kind === 'saved-preview' && (() => {
            const b = detail.brand
            return (
              <div style={{ padding: '40px 36px' }}>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em',
                  color: '#050849', background: 'var(--brand-50, #f0f1ff)',
                  padding: '3px 9px', borderRadius: 4, marginBottom: 16,
                }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
                  </svg>
                  Saved
                </div>
                <h2 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 6px', letterSpacing: '-0.3px', color: 'var(--text-default)' }}>
                  {b.brand_name}
                </h2>
                <div style={{ fontSize: 12, color: 'var(--slate-400)', marginBottom: 20 }}>
                  {b.category.split(/[,(]/)[0].trim()}
                </div>

                {b.reason && (
                  <p style={{ fontSize: 13, color: 'var(--slate-500)', lineHeight: 1.7, margin: '0 0 16px' }}>
                    {b.reason}
                  </p>
                )}

                {b.signal && (
                  <div style={{
                    fontSize: 12, color: 'var(--brand-500, #050849)', lineHeight: 1.5,
                    background: 'var(--brand-50, #f0f1ff)', padding: '10px 14px',
                    borderRadius: 8, border: '0.5px solid var(--brand-100, #d8daff)',
                    marginBottom: 28,
                  }}>
                    {b.signal}
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <button
                    onClick={() => research(b.brand_name)}
                    style={{
                      width: '100%', height: 44, fontSize: 14, fontWeight: 600,
                      background: '#050849', color: '#fff',
                      border: 'none', borderRadius: 8, cursor: 'pointer',
                    }}
                  >
                    Research {b.brand_name} →
                  </button>
                  <p style={{ fontSize: 12, color: 'var(--slate-400)', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
                    No dossier yet — run research to get ICP score, signals, and full analysis.
                  </p>
                </div>
              </div>
            )
          })()}

          {detail.kind === 'preview' && (() => {
            const d = detail.dossier
            const color = ICP_COLOR(d.icp_score)
            const rationale = d.signals?.[0]?.description
              ?.replace(/\*\*/g, '').split(/\.\s/)[0] ?? null
            const lastDate = d.updated_at
              ? new Date(d.updated_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
              : null

            return (
              <div style={{ padding: '32px 36px' }}>

                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, gap: 20 }}>
                  <div>
                    <h2 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 4px', letterSpacing: '-0.3px', color: 'var(--text-default)' }}>
                      {d.brand_name}
                    </h2>
                    <div style={{ fontSize: 12, color: 'var(--slate-400)', marginBottom: 10 }}>
                      {d.category.split(/[,(]/)[0].trim()}
                    </div>
                    <Chip band={d.score_band} />
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 48, fontWeight: 700, lineHeight: 1, color, letterSpacing: '-2px' }}>
                      {d.icp_score}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--slate-400)', marginTop: 2 }}>/ 100</div>
                  </div>
                </div>

                {/* Progress bar */}
                <div style={{ height: 4, background: 'var(--slate-100)', borderRadius: 2, marginBottom: 20, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${d.icp_score}%`, background: color, borderRadius: 2 }} />
                </div>

                {/* Rationale */}
                {rationale && (
                  <p style={{ fontSize: 13, color: 'var(--slate-500)', lineHeight: 1.7, margin: '0 0 16px' }}>
                    {rationale.endsWith('.') ? rationale : rationale + '.'}
                  </p>
                )}

                {/* Meta */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24, flexWrap: 'wrap' }}>
                  {lastDate && (
                    <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>Last researched {lastDate}</span>
                  )}
                  {d.website && (
                    <a href={d.website} target="_blank" rel="noreferrer" style={{
                      fontSize: 11, color: 'var(--slate-400)', textDecoration: 'none',
                      display: 'inline-flex', alignItems: 'center', gap: 3,
                    }}>
                      {d.website.replace('https://', '').replace(/\/$/, '')}
                      <svg width="10" height="10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeWidth="2" strokeLinecap="round"/>
                        <polyline points="15,3 21,3 21,9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        <line x1="10" y1="14" x2="21" y2="3" strokeWidth="2" strokeLinecap="round"/>
                      </svg>
                    </a>
                  )}
                </div>

                {/* Signal preview */}
                {d.signals && d.signals.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
                    {d.signals.slice(0, 3).map((s, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 10,
                        padding: '10px 14px', background: 'var(--slate-100)',
                        borderRadius: 8, border: '0.5px solid var(--black-100)',
                      }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                          letterSpacing: '0.07em', color: '#050849',
                          background: 'var(--brand-100)', padding: '2px 7px',
                          borderRadius: 4, flexShrink: 0, marginTop: 1,
                        }}>
                          {s.type.replace(/_/g, ' ')}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--slate-500)', lineHeight: 1.5 }}>
                          {s.description.replace(/\*\*/g, '').split(/\.\s/)[0]}.
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* CTA */}
                <button onClick={() => openDossier(d)} style={{
                  width: '100%', height: 44, fontSize: 14, fontWeight: 600,
                  background: '#050849', color: '#fff',
                  border: 'none', borderRadius: 8, cursor: 'pointer',
                }}>
                  Open full dossier →
                </button>
              </div>
            )
          })()}
        </div>
      </div>

      {/* ══════════════════════════════════════════
          BOTTOM — full-width AI suggestions queue
      ══════════════════════════════════════════ */}
      <div style={{
        flexShrink: 0,
        borderTop: '0.5px solid var(--black-100)',
        background: '#fff',
        padding: '14px 36px 16px',
      }}>
        {/* Queue header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--slate-400)' }}>
              Queue
            </span>
            {queue.length > 0 && (
              <span style={{
                fontSize: 10, fontWeight: 600, background: 'var(--slate-100)',
                color: 'var(--slate-400)', borderRadius: 10, padding: '1px 7px',
              }}>
                {queue.length}
              </span>
            )}
          </div>
          <button
            onClick={getAiSuggestions}
            disabled={loadingSugg}
            style={{
              fontSize: 12, fontWeight: 500, padding: '6px 14px',
              borderRadius: 8, cursor: loadingSugg ? 'default' : 'pointer',
              border: '0.5px solid var(--black-100)',
              background: '#fff', color: 'var(--slate-500)',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {loadingSugg ? (
              <><div className="spinner" style={{ width: 12, height: 12 }} />Finding…</>
            ) : (
              '✦ Get AI suggestions'
            )}
          </button>
        </div>

        {/* Horizontal card strip */}
        {queue.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--slate-400)', paddingTop: 2 }}>
            No AI suggestions yet. Click &ldquo;Get AI suggestions&rdquo; to generate brand ideas.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 2 }}>
            {queue.map((item, index) => (
              <div key={`${index}-${item.brand_name}`} style={{
                flexShrink: 0, width: 210,
                border: '0.5px solid var(--black-100)',
                borderRadius: 8, padding: '10px 12px',
                display: 'flex', flexDirection: 'column', gap: 8,
                background: '#fff',
              }}>
                {/* Card header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                      {savedSet.has(item.brand_name) ? (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#050849', flexShrink: 0 }}>
                          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
                        </svg>
                      ) : (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--orange-400)', flexShrink: 0 }}>
                          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                        </svg>
                      )}
                      <span
                        onClick={() => research(item.brand_name)}
                        style={{
                          fontSize: 14, fontWeight: 600, color: 'var(--text-default)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          cursor: 'pointer',
                          textDecoration: 'underline', textDecorationColor: 'transparent',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.textDecorationColor = 'var(--slate-300)')}
                        onMouseLeave={e => (e.currentTarget.style.textDecorationColor = 'transparent')}
                      >
                        {item.brand_name}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--slate-400)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.category.split(/[,(]/)[0].trim()}
                    </div>
                  </div>
                  <button onClick={() => removeQueue(item)} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--slate-300)', fontSize: 15, padding: 0,
                    flexShrink: 0, lineHeight: 1,
                  }}>×</button>
                </div>

                {/* Signal blurb */}
                {item.signal && (
                  <div style={{ fontSize: 11, color: 'var(--slate-400)', lineHeight: 1.4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.signal}
                  </div>
                )}

                {/* Save button */}
                <button
                  onClick={() => saveQueueItem(item)}
                  disabled={savingSet.has(item.brand_name) || savedSet.has(item.brand_name)}
                  style={{
                    fontSize: 11, fontWeight: 600, padding: '5px 0',
                    background: savedSet.has(item.brand_name) ? 'var(--green-100)' : '#fff',
                    color: savedSet.has(item.brand_name) ? 'var(--green-400)' : 'var(--slate-500)',
                    border: '0.5px solid',
                    borderColor: savedSet.has(item.brand_name) ? 'var(--green-300)' : 'var(--black-100)',
                    borderRadius: 6, cursor: savedSet.has(item.brand_name) ? 'default' : 'pointer',
                    width: '100%',
                  }}
                >
                  {savingSet.has(item.brand_name) ? 'Saving…' : savedSet.has(item.brand_name) ? 'Saved ✓' : 'Save'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
