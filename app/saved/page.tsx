'use client'

import { userStorage } from '@/lib/browser-storage'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface SavedBrand {
  id: number
  brand_name: string
  category: string
  reason: string
  signal: string
  created_at: string
}

const DATE_OPTIONS = ['All Time', 'Today', 'Yesterday', 'This Week', 'This Month', 'This Year']

function filterByDate(dateStr: string, filter: string): boolean {
  if (filter === 'All Time') return true
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return false
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (filter === 'Today') return date >= today
  if (filter === 'Yesterday') {
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
    return date >= yesterday && date < today
  }
  if (filter === 'This Week') {
    const cutoff = new Date(today); cutoff.setDate(today.getDate() - 7); return date >= cutoff
  }
  if (filter === 'This Month') return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()
  if (filter === 'This Year') return date.getFullYear() === now.getFullYear()
  return true
}

export default function SavedBrandsPage() {
  const [brands, setBrands] = useState<SavedBrand[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingBrand, setLoadingBrand] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterDate, setFilterDate] = useState('All Time')
  const router = useRouter()

  useEffect(() => {
    document.title = 'Saved Brands — Atelier'

    Promise.all([
      fetch('/api/saved-suggestions').then(r => r.json()),
      fetch('/api/pipeline').then(r => r.json())
    ]).then(([savedData, pipelineData]) => {
      const pipelineNames = new Set(
        (pipelineData.leads ?? []).map((l: {brand_name: string}) => l.brand_name.toLowerCase())
      )
      if (savedData.success) {
        setBrands(savedData.suggestions.filter(
          (s: SavedBrand) => !pipelineNames.has(s.brand_name.toLowerCase())
        ))
      }
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  async function handleUnsave(brandName: string) {
    try {
      await fetch(`/api/saved-suggestions?brand_name=${encodeURIComponent(brandName)}`, { method: 'DELETE' })
      setBrands(prev => prev.filter(b => b.brand_name !== brandName))
    } catch {
      console.error('Failed to unsave brand')
    }
  }

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
      console.error('Failed to research brand')
    } finally {
      setLoadingBrand(null)
    }
  }

  const filteredBrands = brands.filter(b => {
    if (searchQuery && !b.brand_name.toLowerCase().includes(searchQuery.toLowerCase())) return false
    if (!filterByDate(b.created_at, filterDate)) return false
    return true
  })

  return (
    <div style={{ zoom: 0.8 }}>
      <div className="page-eyebrow">Saved Brands</div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 }}>
        <h1 className="page-title" style={{ margin: 0 }}>Saved Brands</h1>
        <span style={{ fontSize: 13, color: 'var(--slate-400)', paddingTop: 6 }}>{filteredBrands.length} brand{filteredBrands.length !== 1 ? 's' : ''}</span>
      </div>
      <p className="page-sub">Brands saved from research dossiers and suggested brands — excludes brands already in your pipeline.</p>

      {!loading && brands.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search brands…"
            style={{
              fontSize: 12, padding: '4px 10px', border: '1px solid var(--black-100)',
              borderRadius: 'var(--radius-sm)', outline: 'none', height: 28, minWidth: 180
            }}
          />
          <select
            value={filterDate}
            onChange={e => setFilterDate(e.target.value)}
            style={{
              fontSize: 12, padding: '4px 10px', border: '1px solid var(--black-100)',
              borderRadius: 'var(--radius-sm)', outline: 'none', cursor: 'pointer', height: 28,
              background: filterDate !== 'All Time' ? '#050849' : '#fff',
              color: filterDate !== 'All Time' ? '#fff' : 'var(--text-default)'
            }}
          >
            {DATE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          {(searchQuery || filterDate !== 'All Time') && (
            <button
              onClick={() => { setSearchQuery(''); setFilterDate('All Time') }}
              style={{ fontSize: 11, color: 'var(--slate-400)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--slate-400)', fontSize: 14, marginTop: 32 }}>
          <div className="spinner" />
          Loading saved brands...
        </div>
      )}

      {!loading && brands.length === 0 && (
        <div className="card-hair" style={{ padding: '48px 24px', textAlign: 'center', marginTop: 32 }}>
          <svg width="40" height="40" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--slate-300)', marginBottom: 16 }}>
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-default)', marginBottom: 8 }}>No saved brands yet</div>
          <div style={{ fontSize: 13, color: 'var(--slate-400)', marginBottom: 20 }}>Save brands from the research dossier or from suggested brands on the dashboard.</div>
          <a href="/" className="btn btn-primary btn-sm">Go to dashboard</a>
        </div>
      )}

      {!loading && brands.length > 0 && filteredBrands.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--slate-400)', fontSize: 13 }}>
          No brands match your filters.
        </div>
      )}

      {!loading && filteredBrands.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 8, alignItems: 'stretch' }}>
          {filteredBrands.map((brand, i) => (
            <div key={i} className="card-hair" style={{ padding: '16px', display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                <div>
                  <div
                    onClick={() => handleResearch(brand.brand_name)}
                    style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-default)', marginBottom: 2, cursor: loadingBrand === brand.brand_name ? 'wait' : 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--black-200)', display: 'inline-block' }}
                  >
                    {loadingBrand === brand.brand_name ? '…' : brand.brand_name}
                  </div>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--slate-400)' }}>{brand.category.split(/[,(]/)[0].trim()}</div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--slate-500)', lineHeight: 1.4 }}>{brand.reason}</div>
                <div style={{ fontSize: 11, color: 'var(--brand-400)', fontWeight: 500, background: 'var(--brand-100)', padding: '3px 8px', borderRadius: 4, display: 'inline-block' }}>
                  {brand.signal.slice(0, 80)}{brand.signal.length > 80 ? '...' : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                <button onClick={() => handleResearch(brand.brand_name)} className="btn btn-primary btn-sm" style={{ flex: 1, background: '#050849', borderColor: '#050849' }}>
                  Research
                </button>
                <button onClick={() => handleUnsave(brand.brand_name)} className="btn btn-secondary btn-sm" style={{ flex: 1 }}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}