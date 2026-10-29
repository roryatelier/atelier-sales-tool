'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { activeStorageOwner, matchesDraftIdentity } from '@/lib/browser-storage'

// Uncertain immediate sends, visible without the browser tab that started them.
// A row here was swept by the worker or left uncertain by Gmail: it is never
// resent automatically, and the owner decides what to do next.
interface SendRow {
  id: number
  request_id: string
  status: string
  last_error_code?: string | null
  gmail_message_id?: string | null
  updated_at: string | null
}

export default function InterruptedSends() {
  const [sends, setSends] = useState<SendRow[]>([])
  const [loadError, setLoadError] = useState('')
  const mountedOwner = useRef<string | null>(null)
  const generation = useRef({ value: 0 })
  const refresh = useCallback(async () => {
    const requestGeneration = ++generation.current.value
    if (!activeStorageOwner()) {
      if (requestGeneration !== generation.current.value) return
      setSends([])
      return
    }
    try {
      const response = await fetch('/api/send-email', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (requestGeneration !== generation.current.value) return
      if (!response.ok) throw new Error('unavailable')
      if (!matchesDraftIdentity(mountedOwner.current, typeof data.owner_google_sub === 'string' ? data.owner_google_sub : null)) {
        setSends([])
        throw new Error('account_changed')
      }
      setSends(Array.isArray(data.sends) ? data.sends : [])
      setLoadError('')
    } catch (failure) {
      if (requestGeneration !== generation.current.value) return
      if (failure instanceof Error && failure.message === 'account_changed') {
        setLoadError('Your Google account changed. Reload before continuing.')
        return
      }
      setLoadError('Could not refresh uncertain sends.')
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

  if (!loadError && sends.length === 0) return null

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>Uncertain sends</div>
      {loadError ? <div role="alert">{loadError} <button type="button" onClick={() => void refresh()}>Refresh</button></div> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sends.map(send => (
          <div key={send.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px', fontSize: 13 }}>
            <div style={{ fontWeight: 600 }}>
              {send.status === 'needs_review' ? 'Delivery uncertain — check Gmail Sent before resending' : 'Send in progress'}
            </div>
            <div style={{ color: 'var(--text-muted)' }}>
              Reference {typeof send.request_id === 'string' ? send.request_id.slice(0, 8) : 'unknown'} · {send.last_error_code ? send.last_error_code.replaceAll('_', ' ') : 'uncertain outcome'} · {send.updated_at ? new Date(send.updated_at).toLocaleString() : ''}
            </div>
            {send.gmail_message_id ? <div style={{ color: 'var(--text-muted)' }}>Gmail accepted this message; it was never marked delivered.</div> : null}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>This list never sends on its own.</div>
    </div>
  )
}
