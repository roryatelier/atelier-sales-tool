'use client'

import { useEffect, useState } from 'react'

import { activeStorageOwner } from '@/lib/browser-storage'

// Uncertain immediate sends, visible without the browser tab that started them.
// A row here was swept by the worker or left uncertain by Gmail: it is never
// resent automatically, and the owner decides what to do next.
interface SendRow {
  id: number
  request_id: string
  status: string
  last_error_code?: string | null
  gmail_message_id?: string | null
  updated_at: string
}

export default function InterruptedSends() {
  const [sends, setSends] = useState<SendRow[]>([])

  useEffect(() => {
    const load = async () => {
      if (!activeStorageOwner()) return
      try {
        const response = await fetch('/api/send-email', { cache: 'no-store' })
        if (!response.ok) return
        const data = await response.json()
        setSends(Array.isArray(data.sends) ? data.sends : [])
      } catch {}
    }
    load()
  }, [])

  if (sends.length === 0) return null

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>Uncertain sends</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sends.map(send => (
          <div key={send.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px', fontSize: 13 }}>
            <div style={{ fontWeight: 600 }}>
              {send.status === 'needs_review' ? 'Delivery uncertain — check Gmail Sent before resending' : 'Send in progress'}
            </div>
            <div style={{ color: 'var(--text-muted)' }}>
              Reference {send.request_id.slice(0, 8)} · {send.last_error_code ? send.last_error_code.replaceAll('_', ' ') : 'uncertain outcome'} · {new Date(send.updated_at).toLocaleString()}
            </div>
            {send.gmail_message_id ? <div style={{ color: 'var(--text-muted)' }}>Gmail accepted this message; it was never marked delivered.</div> : null}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>This list never sends on its own.</div>
    </div>
  )
}
