'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

export default function NavItems({ gmailUrl }: { gmailUrl: string }) {
  const pathname = usePathname()
  const [savedCount, setSavedCount] = useState(0)
  const [sheetUrl, setSheetUrl] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/saved-suggestions').then(r => r.json()),
      fetch('/api/pipeline').then(r => r.json())
    ]).then(([savedData, pipelineData]) => {
      if (pipelineData.success) setSheetUrl(pipelineData.sheet_url ?? null)
      if (savedData.success) {
        const pipelineNames = new Set(
          (pipelineData.leads ?? []).map((l: {brand_name: string}) => l.brand_name.toLowerCase())
        )
        const count = savedData.suggestions.filter(
          (s: {brand_name: string}) => !pipelineNames.has(s.brand_name.toLowerCase())
        ).length
        setSavedCount(count)
      }
    }).catch(() => {})
  }, [pathname])

  const isActive = (path: string) => {
    if (path === '/') return pathname === '/'
    return pathname.startsWith(path)
  }

  const navStyle = (path: string) => ({
    background: isActive(path) ? 'rgba(255,255,255,0.1)' : 'transparent',
    borderRadius: 'var(--radius-sm)',
  })

  return (
    <>
      <a href="/" className="nav-item" style={navStyle('/')}>
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1" strokeWidth="2"/><rect x="14" y="3" width="7" height="7" rx="1" strokeWidth="2"/><rect x="3" y="14" width="7" height="7" rx="1" strokeWidth="2"/><rect x="14" y="14" width="7" height="7" rx="1" strokeWidth="2"/></svg>
        Dashboard
      </a>
      <div style={{ position: 'relative' }}>
        <a href="/portfolio" className="nav-item" style={navStyle('/portfolio')}>
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" strokeWidth="2"/><path d="M8 21h8" strokeWidth="2" strokeLinecap="round"/><path d="M12 17v4" strokeWidth="2" strokeLinecap="round"/></svg>
          Brand Search
        </a>
        <a href="/dossier" className="nav-item nav-subtab" style={{ paddingLeft: 40, fontSize: 12, opacity: 0.7 }}>
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" strokeWidth="2"/><path d="m21 21-4.35-4.35" strokeWidth="2" strokeLinecap="round"/></svg>
          Brand Dossier
        </a>
        <a href="/saved" className="nav-item nav-subtab" style={{ paddingLeft: 40, fontSize: 12, opacity: 0.7 }}>
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Saved Brands
          {savedCount > 0 && (
            <span style={{ marginLeft: 'auto', background: '#050849', color: '#fff', fontSize: 10, fontWeight: 600, borderRadius: 10, padding: '1px 6px', minWidth: 16, textAlign: 'center' }}>
              {savedCount}
            </span>
          )}
        </a>
      </div>
      <div style={{ position: 'relative' }}>
        <a href="/email" className="nav-item" style={{ background: (isActive('/email') || isActive('/templates')) ? 'rgba(255,255,255,0.1)' : 'transparent', borderRadius: 'var(--radius-sm)' }}>
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2" strokeWidth="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" strokeWidth="2"/></svg>
          Email Generator
        </a>
        <a href={gmailUrl} target="_blank" rel="noreferrer" className="nav-item nav-subtab" style={{ paddingLeft: 40, fontSize: 12, opacity: 0.7 }}>
          <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeWidth="2" strokeLinecap="round"/>
            <polyline points="15,3 21,3 21,9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <line x1="10" y1="14" x2="21" y2="3" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Gmail Inbox ↗
        </a>
        <a href="/templates" className="nav-item nav-subtab" style={{ paddingLeft: 40, fontSize: 12, opacity: 0.7 }}>
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" strokeWidth="2"/><polyline points="14,2 14,8 20,8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="16" y1="13" x2="8" y2="13" strokeWidth="2" strokeLinecap="round"/><line x1="16" y1="17" x2="8" y2="17" strokeWidth="2" strokeLinecap="round"/></svg>
          Templates
        </a>
      </div>
      <div style={{ position: 'relative' }}>
        <a href="/pipeline" className="nav-item" style={navStyle('/pipeline')}>
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><line x1="8" y1="6" x2="21" y2="6" strokeWidth="2" strokeLinecap="round"/><line x1="8" y1="12" x2="21" y2="12" strokeWidth="2" strokeLinecap="round"/><line x1="8" y1="18" x2="21" y2="18" strokeWidth="2" strokeLinecap="round"/><line x1="3" y1="6" x2="3.01" y2="6" strokeWidth="2" strokeLinecap="round"/><line x1="3" y1="12" x2="3.01" y2="12" strokeWidth="2" strokeLinecap="round"/><line x1="3" y1="18" x2="3.01" y2="18" strokeWidth="2" strokeLinecap="round"/></svg>
          Pipeline
        </a>
        {sheetUrl && (
          <a href={sheetUrl} target="_blank" rel="noreferrer" className="nav-item nav-subtab" style={{ paddingLeft: 40, fontSize: 12, opacity: 0.7 }}>
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeWidth="2" strokeLinecap="round"/>
              <polyline points="15,3 21,3 21,9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="10" y1="14" x2="21" y2="3" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            Google Sheets ↗
          </a>
        )}
      </div>

    </>
  )
}
111
