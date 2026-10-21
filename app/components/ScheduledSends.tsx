'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { activeStorageOwner, matchesDraftIdentity } from '@/lib/browser-storage'

type Job = { id: number; to_email: string; subject: string; brand_name: string; scheduled_at: string; timezone?: string; delivery_status: string; last_error_code?: string }
export default function ScheduledSends() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [owner, setOwner] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const mountedOwner = useRef<string | null>(null)
  const generation = useRef({ value: 0 })
  const [checkedAt, setCheckedAt] = useState(0)
  const [busy, setBusy] = useState<number | null>(null)
  const [confirmation, setConfirmation] = useState<number | null>(null)
  const refresh = useCallback(async () => {
    const requestGeneration = ++generation.current.value
    try {
      const response = await fetch('/api/schedule-email', { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not load scheduled sends')
      if (requestGeneration !== generation.current.value) return
      if (!matchesDraftIdentity(mountedOwner.current, data.owner_google_sub)) {
        setJobs([]); setOwner(''); setConfirmation(null)
        throw new Error('account_changed')
      }
      setJobs(data.emails); setOwner(data.owner_google_sub); setLoaded(true); setLoadError(''); setCheckedAt(Date.now())
    } catch (failure) {
      if (requestGeneration !== generation.current.value) return
      setLoadError(failure instanceof Error && failure.message === 'account_changed' ? 'Your Google account changed. Reload before continuing.' : 'Could not refresh scheduled sends. Status may be out of date.'); setLoaded(true)
    }
  }, [])
  useEffect(() => {
    mountedOwner.current = activeStorageOwner()
    const epoch = generation.current
    const startup = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 60_000)
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => { epoch.value++; clearTimeout(startup); clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [refresh])
  async function act(job: Job, resume: boolean) {
    if (!matchesDraftIdentity(mountedOwner.current, owner)) { setJobs([]); setOwner(''); setError('Your Google account changed. Reload before continuing.'); return }
    generation.current.value++
    setBusy(job.id); setError('')
    try {
      const response = await fetch(resume ? '/api/schedule-email' : `/api/schedule-email?id=${job.id}&expectedGoogleSub=${encodeURIComponent(owner)}`, {
        method: resume ? 'PATCH' : 'DELETE',
        ...(resume ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, action: 'resume', expectedGoogleSub: owner }) } : {}),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'The action failed')
      setConfirmation(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The action failed') }
    finally { await refresh(); setBusy(null) }
  }
  return <section aria-label="Scheduled sends">
    <div className="section-label" style={{ marginBottom: 10, color: '#050849' }}>🕐 Scheduled sends {jobs.length ? `(${jobs.length})` : ''}</div>
    {loadError && <div role="alert">{loadError} <button onClick={() => void refresh()}>Refresh</button></div>}
    {error && <div role="alert">{error} <button onClick={() => { setError(''); void refresh() }}>Refresh</button></div>}
    {!loaded && <p role="status">Loading scheduled sends…</p>}
    {loaded && !error && !loadError && jobs.length === 0 && <p>No scheduled sends</p>}
    <div className="dash-right-scroll" style={{ maxHeight: 300, overflowY: 'auto', display: 'grid', gap: 8 }}>
      {jobs.map(job => <article key={job.id} style={{ padding: '10px 14px', background: '#f0f0ff', border: '1px solid #d0d0ee', borderRadius: 'var(--radius-md)' }}>
        <strong>{job.brand_name || job.to_email}</strong>
        <div>To: {job.to_email}</div><div>{job.subject}</div>
        <div>{scheduleTime(job)}</div>
        {job.delivery_status === 'pending' && <div role="status">{checkedAt - Date.parse(job.scheduled_at) > 30 * 60_000 ? 'Overdue — awaiting the scheduler. Refresh status or cancel.' : job.last_error_code === 'token_refresh_unavailable' ? 'Gmail temporarily unavailable. Safely waiting to retry before sending.' : 'Scheduled'}</div>}
        {job.delivery_status === 'claimed' && <div role="status">Preparing to send. Interrupted preparation can be recovered safely.</div>}
        {job.delivery_status === 'sending' && <div role="status">Send started. If interrupted, it will need review; it will not automatically resend.</div>}
        {job.delivery_status === 'needs_review' && <div role="alert">Delivery uncertain. Check Gmail Sent before taking further action. This job will not resend automatically.</div>}
        {job.delivery_status === 'needs_reauth' && <div role="alert">Not sent. <a href="/api/auth/gmail">Reconnect Gmail</a>, then confirm resuming this job.</div>}
        {['pending', 'claimed', 'needs_reauth'].includes(job.delivery_status) && <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void act(job, false)}>Cancel</button>}
        {job.delivery_status === 'needs_reauth' && (confirmation === job.id ? <div>
          <p>Resume this exact message to {job.to_email}? Its scheduled time has passed, so it may send on the next scheduler run.</p>
          <button className="btn btn-sm" disabled={busy !== null || !owner} onClick={() => void act(job, true)}>Confirm resume</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmation(null)}>Keep paused</button>
        </div> : <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => setConfirmation(job.id)}>Resume…</button>)}
      </article>)}
    </div>
  </section>
}
function scheduleTime(job: Job) {
  try { return new Date(job.scheduled_at).toLocaleString('en-AU', { timeZone: job.timezone || 'Australia/Sydney', timeZoneName: 'short', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) }
  catch { return 'Schedule unavailable' }
}
