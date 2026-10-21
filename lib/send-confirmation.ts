// The composer mints one request id when the user confirms a specific draft.
// The same id is reused when that confirmed content may have reached Gmail,
// including after acceptance. A different draft gets a new id. A definite refusal
// clears the id so the user can confirm again.

export interface ConfirmedSendDraft {
  to: string
  cc: string
  bcc: string
  subject: string
  emailBody: string
  attachments: { name: string; type: string; data: string }[]
}

export interface RetainedSend {
  requestId: string
  draftKey: string
}

export type SendObservation =
  | { kind: 'network_error' }
  | { kind: 'response'; httpStatus: number; success?: boolean; uncertain?: boolean; outcome?: string }

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function confirmedSendDraftKey(draft: ConfirmedSendDraft): string {
  return JSON.stringify({
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    emailBody: draft.emailBody,
    attachments: draft.attachments,
  })
}

export function claimConfirmedSendId(
  retained: RetainedSend | null,
  draftKey: string,
  mint: () => string = () => crypto.randomUUID(),
): RetainedSend {
  if (retained && retained.draftKey === draftKey && REQUEST_ID_PATTERN.test(retained.requestId)) return retained
  return { requestId: mint(), draftKey }
}

// Keep the id when the response does not prove Gmail refused the message.
// That includes a lost network response, a 409 in-progress replay, and any
// needs_review / uncertain outcome — even one that also says success, because
// a Gmail message id may already exist. Definite failures clear the id.
export function shouldRetainRequestId(observation: SendObservation): boolean {
  if (observation.kind === 'network_error') return true
  if (observation.uncertain) return true
  if (observation.outcome === 'needs_review' || observation.outcome === 'uncertain') return true
  if (observation.success) return false
  // An unclassified refusal may be an auth failure on replay after the
  // original request reached Gmail. Only explicit non-delivery clears it.
  return observation.outcome !== 'failed' && observation.outcome !== 'failed_auth'
}

export interface ConfirmedSendLedger {
  claim(tabId: string, draftKey: string): string
  observe(tabId: string, requestId: string, observation: SendObservation): void
  current(tabId: string): RetainedSend | null
  parked(tabId: string): RetainedSend[]
  restore(tabId: string, retained: RetainedSend | null, parkedSends?: RetainedSend[] | null): void
  forget(tabId: string): void
}

function rememberable(send: RetainedSend | null | undefined): send is RetainedSend {
  return !!send && typeof send.requestId === 'string' && REQUEST_ID_PATTERN.test(send.requestId)
    && typeof send.draftKey === 'string' && send.draftKey.length > 0
}

export function createConfirmedSendLedger(mint: () => string = () => crypto.randomUUID()): ConfirmedSendLedger {
  const byTab = new Map<string, RetainedSend>()
  // Drafts that may already have reached Gmail stay addressable after the user
  // edits. Returning to that exact content reuses the id; a different draft
  // gets its own. Only a definite refusal removes that draft's parked id.
  const parkedByTab = new Map<string, Map<string, string>>()

  function park(tabId: string, send: RetainedSend) {
    let remembered = parkedByTab.get(tabId)
    if (!remembered) {
      remembered = new Map()
      parkedByTab.set(tabId, remembered)
    }
    remembered.set(send.draftKey, send.requestId)
  }

  return {
    claim(tabId, draftKey) {
      const current = byTab.get(tabId) ?? null
      if (current && current.draftKey === draftKey && rememberable(current)) {
        park(tabId, current)
        return current.requestId
      }
      const remembered = parkedByTab.get(tabId)?.get(draftKey)
      if (remembered && REQUEST_ID_PATTERN.test(remembered)) {
        const restored = { requestId: remembered, draftKey }
        byTab.set(tabId, restored)
        return remembered
      }
      const next = claimConfirmedSendId(null, draftKey, mint)
      byTab.set(tabId, next)
      // Claimed means the user confirmed. Park immediately so a lost response
      // cannot be followed by a second id for the same bytes.
      park(tabId, next)
      return next.requestId
    },
    observe(tabId, requestId, observation) {
      const current = [...(parkedByTab.get(tabId)?.entries() ?? [])]
        .map(([draftKey, requestId]) => ({ draftKey, requestId }))
        .find(send => send.requestId === requestId)
      if (!current) return
      if (shouldRetainRequestId(observation)) {
        park(tabId, current)
        return
      }
      // Keep accepted bytes parked too: if the visible sent state is lost,
      // confirming them again replays acceptance instead of sending again.
      if (observation.kind === 'response' && !observation.success) parkedByTab.get(tabId)?.delete(current.draftKey)
      if (byTab.get(tabId)?.requestId === requestId) byTab.delete(tabId)
    },
    current(tabId) {
      return byTab.get(tabId) ?? null
    },
    parked(tabId) {
      const remembered = parkedByTab.get(tabId)
      if (!remembered) return []
      return [...remembered.entries()].map(([draftKey, requestId]) => ({ requestId, draftKey }))
    },
    restore(tabId, retained, parkedSends) {
      byTab.delete(tabId)
      parkedByTab.delete(tabId)
      for (const send of Array.isArray(parkedSends) ? parkedSends : []) if (rememberable(send)) park(tabId, send)
      if (rememberable(retained)) {
        park(tabId, retained)
        byTab.set(tabId, retained)
      }
    },
    forget(tabId) {
      byTab.delete(tabId)
      parkedByTab.delete(tabId)
    },
  }
}
