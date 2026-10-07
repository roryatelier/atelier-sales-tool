'use client'

import { userStorage } from '@/lib/browser-storage'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Lead {
  brand_name: string
  website: string
  lead_source: string
  revenue_estimate: string
  retailers: string
  category: string
  icp_score: string
  score_band: string
  key_signals: string
  target_role: string
  contact_name: string
  email_subject: string
  email_body: string
  date_added: string
  status: string
  notes?: string
}

export default function PipelinePage() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<string>('All')
  const [filterBand, setFilterBand] = useState<string>('All')
  const [filterDate, setFilterDate] = useState<string>('All Time')
  const [sortByScore, setSortByScore] = useState<'asc' | 'desc' | null>(null)
  const router = useRouter()
  const [editingNotes, setEditingNotes] = useState<string | null>(null)
  const [notesValue, setNotesValue] = useState<string>('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [loadingBrand, setLoadingBrand] = useState<string | null>(null)

  async function handleResearch(brandName: string) {
    setLoadingBrand(brandName)
    try {
      const res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand_name: brandName })
      })
      const data = await res.json()
      if (data.success) {
        userStorage.setItem('current_dossier', JSON.stringify(data.dossier))
        router.push('/dossier')
      }
    } catch {
      // silent fail
    } finally {
      setLoadingBrand(null)
    }
  }

  useEffect(() => {
    document.title = 'Pipeline — Atelier'
    async function fetchLeads() {
      try {
        const res = await fetch('/api/pipeline')
        const data = await res.json()
        if (data.success) {
          setLeads(data.leads)
        } else {
          setError('Failed to load pipeline.')
        }
      } catch {
        setError('Failed to load pipeline.')
      } finally {
        setLoading(false)
      }
    }
    fetchLeads()
  }, [])

  async function updateStatus(brandName: string, newStatus: string) {
    setUpdatingStatus(brandName)
    try {
      setLeads(prev => prev.map(l =>
        l.brand_name === brandName ? { ...l, status: newStatus } : l
      ))
      await fetch('/api/update-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand_name: brandName, status: newStatus })
      })
    } catch {
      console.error('Failed to update status')
    } finally {
      setUpdatingStatus(null)
    }
  }

  async function saveNotes(brandName: string) {
    setSavingNotes(true)
    try {
      await fetch('/api/update-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand_name: brandName, notes: notesValue })
      })
      setLeads(prev => prev.map(l =>
        l.brand_name === brandName ? { ...l, notes: notesValue } : l
      ))
      setEditingNotes(null)
    } catch {
      console.error('Failed to save notes')
    } finally {
      setSavingNotes(false)
    }
  }

  function filterByDate(dateStr: string): boolean {
    if (filterDate === 'All Time') return true
    const parts = dateStr.split('/')
    if (parts.length !== 3) return false
    const date = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`)
    if (isNaN(date.getTime())) return false
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (filterDate === 'Today') return date >= today
    if (filterDate === 'Yesterday') {
      const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
      return date >= yesterday && date < today
    }
    if (filterDate === 'This Week') {
      const cutoff = new Date(today); cutoff.setDate(today.getDate() - 7); return date >= cutoff
    }
    if (filterDate === 'This Month') return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()
    if (filterDate === 'This Year') return date.getFullYear() === now.getFullYear()
    return true
  }

  function getBandClass(band: string) {
    const classes: Record<string, string> = {
      Hot: 'band band-hot',
      Warm: 'band band-warm',
      Watch: 'band band-watch',
      Pass: 'band band-pass',
    }
    return classes[band] ?? 'band band-watch'
  }

  function getScoreColour(score: string) {
    const n = parseInt(score)
    if (n >= 80) return 'var(--green-400)'
    if (n >= 60) return 'var(--orange-400)'
    return 'var(--red-500)'
  }

  function getStatusDot(status: string) {
    const dots: Record<string, string> = {
      Sent: 'dot-sent',
      Researched: 'dot-researched',
      Qualified: 'dot-qualified',
      Passed: 'dot-passed',
      'Follow-up 1': 'dot-sent',
      'Follow-up 2': 'dot-sent',
      Called: 'dot-sent',
      Replied: 'dot-qualified',
    }
    return dots[status] ?? 'dot-researched'
  }

  return (
    <div style={{ zoom: 0.8 }}>
      <div className="page-eyebrow">Pipeline</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h1 className="page-title">Atelier Pipeline</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--slate-400)' }}>
            {leads.length} {leads.length === 1 ? 'brand' : 'brands'}
          </div>
          <a
            href="https://docs.google.com/spreadsheets/d/1t2dGrIg9sQYGuqhU38qYcHBRM9XYmk3LFa_k_mA4cd8"
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary btn-sm"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeWidth="2" strokeLinecap="round"/>
              <polyline points="15,3 21,3 21,9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="10" y1="14" x2="21" y2="3" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            Open in Google Sheets
          </a>
        </div>
      </div>
      <p className="page-sub" style={{ marginBottom: 20 }}>All leads tracked across outbound, inbound, and referral channels.</p>

      {!loading && leads.length > 0 && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 28, flexWrap: 'wrap' }}>
          {[
            { label: 'Total', count: leads.length, color: 'var(--text-default)' },
            { label: 'Sent', count: leads.filter(l => l.status === 'Sent').length, color: 'var(--brand-400)' },
            { label: 'Researched', count: leads.filter(l => l.status === 'Researched').length, color: 'var(--slate-400)' },
            { label: 'Called', count: leads.filter(l => l.status === 'Called').length, color: 'var(--orange-400)' },
            { label: 'Follow-up 1', count: leads.filter(l => l.status === 'Follow-up 1').length, color: 'var(--orange-400)' },
            { label: 'Follow-up 2', count: leads.filter(l => l.status === 'Follow-up 2').length, color: 'var(--orange-400)' },
            { label: 'Replied', count: leads.filter(l => l.status === 'Replied').length, color: 'var(--green-400)' },
            { label: 'Qualified', count: leads.filter(l => l.status === 'Qualified').length, color: 'var(--green-400)' },
          ].filter(s => s.count > 0).map(s => (
            <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', background: '#fff', border: '1px solid var(--black-100)', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontSize: 20, fontWeight: 600, color: s.color }}>{s.count}</span>
              <span style={{ fontSize: 12, color: 'var(--slate-400)', fontWeight: 500 }}>{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--slate-400)', fontSize: 14 }}>
          <div className="spinner" />
          Loading pipeline...
        </div>
      )}

      {error && (
        <div className="data-warning">{error}</div>
      )}

      {!loading && !error && leads.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { label: 'All statuses', value: filterStatus, set: setFilterStatus, options: ['All', 'Sent', 'Called', 'Follow-up 1', 'Follow-up 2', 'Replied', 'Qualified'], defaultLabel: 'All statuses' },
            { label: 'All bands', value: filterBand, set: setFilterBand, options: ['All', 'Hot', 'Warm', 'Watch', 'Pass'], defaultLabel: 'All bands' },
            { label: 'All Time', value: filterDate, set: setFilterDate, options: ['All Time', 'Today', 'Yesterday', 'This Week', 'This Month', 'This Year'], defaultLabel: 'All Time' },
          ].map(f => (
            <select
              key={f.label}
              value={f.value}
              onChange={e => f.set(e.target.value)}
              style={{
                fontSize: 12, padding: '4px 10px', border: '1px solid var(--black-100)',
                borderRadius: 'var(--radius-sm)', outline: 'none', cursor: 'pointer', height: 28,
                background: f.value !== f.defaultLabel ? '#050849' : '#fff',
                color: f.value !== f.defaultLabel ? '#fff' : 'var(--text-default)'
              }}
            >
              {f.options.map(o => (
                <option key={o} value={o}>{o === 'All' ? f.defaultLabel : o}</option>
              ))}
            </select>
          ))}
          {(filterStatus !== 'All' || filterBand !== 'All' || filterDate !== 'All Time') && (
            <button
              onClick={() => { setFilterStatus('All'); setFilterBand('All'); setFilterDate('All Time') }}
              style={{ fontSize: 11, color: 'var(--slate-400)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {!loading && !error && (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Brand Name</th>
                <th
                  onClick={() => setSortByScore(s => s === 'desc' ? 'asc' : 'desc')}
                  style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                >
                  ICP Score {sortByScore === 'desc' ? '↓' : sortByScore === 'asc' ? '↑' : '↕'}
                </th>
                <th>Score Band</th>
                <th>Lead Source</th>
                <th>Contact</th>
                <th>Status</th>
                <th>Date Added</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {leads.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div style={{ textAlign: 'center', padding: '64px 24px' }}>
                      <svg width="40" height="40" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--slate-300)', marginBottom: 16 }}>
                        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" strokeWidth="1.5"/>
                        <polyline points="13,2 13,9 20,9" strokeWidth="1.5"/>
                      </svg>
                      <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-default)', marginBottom: 8 }}>No leads in the pipeline yet</div>
                      <div style={{ fontSize: 13, color: 'var(--slate-400)', marginBottom: 20 }}>Research a brand and save it to the pipeline to get started.</div>
                      <a href="/" className="btn btn-primary btn-sm">Research a brand</a>
                    </div>
                  </td>
                </tr>
              )}
              {leads.filter(lead => {
                if (filterStatus !== 'All' && lead.status !== filterStatus) return false
                if (filterBand !== 'All' && lead.score_band !== filterBand) return false
                if (!filterByDate(lead.date_added)) return false
                return true
              }).sort((a, b) => {
                if (!sortByScore) return 0
                const aScore = parseInt(a.icp_score) || 0
                const bScore = parseInt(b.icp_score) || 0
                return sortByScore === 'desc' ? bScore - aScore : aScore - bScore
              }).map((lead, i) => (
                <tr
                  key={i}
                  className="clickable"
                  onClick={() => {
                    userStorage.setItem('pipeline_lead', JSON.stringify(lead))
                    router.push('/')
                  }}
                >
                  <td className="cell-brand">
                    <span
                      onClick={e => { e.stopPropagation(); handleResearch(lead.brand_name) }}
                      style={{ cursor: loadingBrand === lead.brand_name ? 'wait' : 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--black-200)', fontWeight: 600 }}
                    >
                      {loadingBrand === lead.brand_name ? '…' : lead.brand_name}
                    </span>
                  </td>
                  <td className="cell-score" style={{ color: getScoreColour(lead.icp_score) }}>
                    {lead.icp_score}
                  </td>
                  <td>
                    <span className={getBandClass(lead.score_band)}>{lead.score_band}</span>
                  </td>
                  <td style={{ color: 'var(--slate-500)', fontSize: 13 }}>{lead.lead_source}</td>
                    <td>
                      {lead.contact_name ? (
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-default)' }}>{lead.contact_name}</div>
                          {lead.target_role && (
                            <div style={{ fontSize: 11, color: 'var(--slate-400)', marginTop: 2 }}>{lead.target_role.split(' ').slice(0, 4).join(' ')}</div>
                          )}
                        </div>
                      ) : (
                        <span style={{ fontSize: 13, color: 'var(--slate-300)' }}>—</span>
                      )}
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      <select
                      value={lead.status}
                      onChange={e => updateStatus(lead.brand_name, e.target.value)}
                      disabled={updatingStatus === lead.brand_name}
                      style={{
                        border: 'none', background: 'transparent', fontSize: 13,
                        color: 'var(--text-default)', cursor: 'pointer', outline: 'none',
                        padding: '2px 4px', borderRadius: 4
                      }}
                    >
                      {['Sent', 'Called', 'Follow-up 1', 'Follow-up 2', 'Replied', 'Qualified'].map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ color: 'var(--slate-500)', fontSize: 13 }}>{lead.date_added}</td>
                  <td onClick={e => e.stopPropagation()} style={{ minWidth: 180 }}>
                    {editingNotes === lead.brand_name ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="text"
                          value={notesValue}
                          onChange={e => setNotesValue(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveNotes(lead.brand_name); if (e.key === 'Escape') setEditingNotes(null) }}
                          autoFocus
                          style={{ fontSize: 12, padding: '3px 8px', border: '1px solid var(--black-100)', borderRadius: 4, outline: 'none', flex: 1 }}
                        />
                        <button onClick={() => saveNotes(lead.brand_name)} disabled={savingNotes} className="btn btn-primary btn-sm" style={{ padding: '3px 8px', fontSize: 11 }}>
                          {savingNotes ? '...' : 'Save'}
                        </button>
                        <button onClick={() => setEditingNotes(null)} className="btn btn-secondary btn-sm" style={{ padding: '3px 8px', fontSize: 11 }}>
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div
                        onClick={() => { setEditingNotes(lead.brand_name); setNotesValue(lead.notes ?? '') }}
                        style={{ fontSize: 12, color: lead.notes ? 'var(--text-default)' : 'var(--slate-300)', cursor: 'pointer', padding: '2px 4px', borderRadius: 4 }}
                      >
                        {lead.notes || '+ Add note'}
                      </div>
                    )}
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    {lead.status === 'Sent' && (() => {
                      const parts = lead.date_added.split('/')
                      if (parts.length !== 3) return null
                      const date = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`)
                      const sevenDaysAgo = new Date()
                      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
                      if (date > sevenDaysAgo) return null
                      return (
                        <button
                          onClick={async () => {
                            try {
                              const res = await fetch('/api/research', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ brand_name: lead.brand_name })
                              })
                              const data = await res.json()
                              if (data.success) {
                                userStorage.setItem('current_dossier', JSON.stringify(data.dossier))
                                userStorage.setItem('follow_up_context', JSON.stringify({
                                  original_subject: lead.email_subject,
                                  contact_name: lead.contact_name,
                                  date_sent: lead.date_added
                                }))
                                router.push('/email')
                              }
                            } catch {
                              console.error('Failed to load dossier')
                            }
                          }}
                          className="btn btn-primary btn-sm"
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          ⏰ Follow-up
                        </button>
                      )
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}