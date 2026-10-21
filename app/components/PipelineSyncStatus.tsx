'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { activeStorageOwner, matchesDraftIdentity } from '@/lib/browser-storage'

type Export = { outreach_id: string; brand_name: string; to_email: string; subject: string; status: string; last_error_code?: string }
export default function PipelineSyncStatus() {
  const [jobs, setJobs] = useState<Export[]>([])
  const [owner, setOwner] = useState('')
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const identity = useRef<string | null>(null)
  const epoch = useRef({ value: 0 })
  const refresh = useCallback(async () => {
    const version = ++epoch.current.value
    try {
      const response = await fetch('/api/pipeline-exports', { cache: 'no-store' })
      const data = await response.json()
      if (version !== epoch.current.value) return
      if (!response.ok || !data.success) throw new Error('Could not load pipeline sync status')
      if (!matchesDraftIdentity(identity.current, data.owner_google_sub)) {
        setJobs([]); setOwner('')
        throw new Error('Your account changed. Reload before continuing.')
      }
      setJobs(data.exports); setOwner(data.owner_google_sub); setLoadError(''); setLoaded(true)
    } catch (failure) {
      if (version !== epoch.current.value) return
      setLoadError(failure instanceof Error ? failure.message : 'Could not load pipeline sync status'); setLoaded(true)
    }
  }, [])
  useEffect(() => {
    identity.current = activeStorageOwner()
    const version = epoch.current
    const startup = setTimeout(() => void refresh(), 0)
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    const timer = setInterval(visible, 60_000)
    document.addEventListener('visibilitychange', visible)
    return () => { version.value++; clearTimeout(startup); clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [refresh])
  async function retry(job: Export) {
    if (!matchesDraftIdentity(identity.current, owner)) { setJobs([]); setOwner(''); setError('Your account changed. Reload before continuing.'); return }
    epoch.current.value++; setBusy(job.outreach_id); setError('')
    try {
      const response = await fetch('/api/pipeline-exports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outreach_id: job.outreach_id, expectedGoogleSub: owner }) })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'Pipeline sync failed')
      if (data.status === 'synced') window.dispatchEvent(new Event('pipeline-sync-complete'))
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Pipeline sync failed') }
    finally { await refresh(); setBusy(null) }
  }
  const outstanding = jobs.filter(job => job.status !== 'synced')
  return <section aria-label="Pipeline sync" style={{ marginBottom: 24, padding: 16, border: '1px solid var(--black-100)', borderRadius: 'var(--radius-md)' }}>
    <h2 style={{ fontSize: 16 }}>Pipeline sync</h2>
    <p>Gmail acceptance and Sheets export are tracked separately. Retrying here never sends an email.</p>
    {loadError && <p role="alert">{loadError}</p>}
    {error && <p role="alert">{error}</p>}
    <button className="btn btn-ghost btn-sm" onClick={() => void refresh()}>Refresh sync status</button>
    {!loaded && <p role="status">Loading sync status…</p>}
    {loaded && !loadError && outstanding.length === 0 && <p>No outstanding exports.</p>}
    {outstanding.length === 100 && <p>Showing the oldest 100 outstanding exports. More may remain.</p>}
    {outstanding.map(job => <article key={job.outreach_id} style={{ marginTop: 12 }}>
      <strong>{job.brand_name || job.to_email}</strong> · {job.to_email} · {job.subject}
      <div role="status">{job.status === 'needs_review' ? 'Sheets did not confirm the append. Check Sheets looks for the existing outreach ID; it does not append again.' : job.status === 'failed' ? 'Email accepted; pipeline sync failed.' : 'Email accepted; pipeline sync pending.'}</div>
      {job.last_error_code === 'sheets_export_headers_required' && <p>Setup required: reserve Sheet1 columns R:S with headers “Outreach ID” and “Recipient Email”.</p>}
      {job.last_error_code === 'sheets_not_configured' && <p>Sheets is not configured. Contact an administrator.</p>}
      {job.last_error_code === 'sheets_destination_changed' && <p>The configured spreadsheet changed. An administrator must review this export.</p>}
      {job.last_error_code === 'duplicate_outreach_id' && <p>Duplicate outreach IDs need review in Sheets.</p>}
      {['pending','failed','needs_review'].includes(job.status) && <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void retry(job)}>{job.status === 'needs_review' ? 'Check Sheets' : 'Retry sync'}</button>}
    </article>)}
  </section>
}
