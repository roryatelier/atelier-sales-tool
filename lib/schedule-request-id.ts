// One confirmed schedule submission has one id. localStorage shares it across
// tabs for the same account and draft fingerprint. Success and 4xx clear it.
// Reauth, 5xx, network errors, and reloads keep it until this expiry.

export const SCHEDULE_REQUEST_TTL_MS = 24 * 60 * 60 * 1000

const PREFIX = 'atelier_schedule_request_'
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ScheduleRequestStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function canShare(owner: string, fingerprint: string): boolean {
  return owner.length > 0 && owner.length <= 200 && /^[0-9a-z]+$/.test(fingerprint)
}

export function scheduleRequestStorageKey(owner: string, fingerprint: string): string {
  if (!canShare(owner, fingerprint)) throw new Error('Schedule request key is invalid')
  return PREFIX + JSON.stringify([owner, fingerprint])
}

function storedRequestId(raw: string, now: number): string | null {
  try {
    const parsed = JSON.parse(raw) as { requestId?: unknown; expiresAt?: unknown }
    if (typeof parsed.requestId !== 'string' || !REQUEST_ID_PATTERN.test(parsed.requestId)) return null
    if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= now) return null
    return parsed.requestId
  } catch {
    return null
  }
}

function sweepExpired(storage: ScheduleRequestStorage, now: number) {
  try {
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith(PREFIX)) keys.push(key)
    }
    for (const key of keys) {
      const raw = storage.getItem(key)
      if (raw == null || storedRequestId(raw, now) == null) {
        try { storage.removeItem(key) } catch { /* quota or a locked store leaves the stale key */ }
      }
    }
  } catch { /* a storage read failure must not block scheduling */ }
}

function readStored(storage: ScheduleRequestStorage, owner: string, fingerprint: string, now: number): string {
  if (!canShare(owner, fingerprint)) return ''
  try {
    const key = scheduleRequestStorageKey(owner, fingerprint)
    const raw = storage.getItem(key)
    if (!raw) return ''
    const requestId = storedRequestId(raw, now)
    if (!requestId) storage.removeItem(key)
    return requestId ?? ''
  } catch {
    return ''
  }
}

function remember(storage: ScheduleRequestStorage, owner: string, fingerprint: string, requestId: string, now: number) {
  if (!canShare(owner, fingerprint) || !REQUEST_ID_PATTERN.test(requestId)) return
  try {
    storage.setItem(scheduleRequestStorageKey(owner, fingerprint), JSON.stringify({
      requestId,
      expiresAt: now + SCHEDULE_REQUEST_TTL_MS,
    }))
  } catch { /* the in-memory id still covers this tab when storage is full */ }
}

export function forgetScheduleRequestId(storage: ScheduleRequestStorage, owner: string, fingerprint: string) {
  if (!canShare(owner, fingerprint)) return
  try { storage.removeItem(scheduleRequestStorageKey(owner, fingerprint)) } catch { /* already gone */ }
}

export function claimScheduleRequestId(
  storage: ScheduleRequestStorage,
  owner: string,
  fingerprint: string,
  inMemoryId: string,
  mint: () => string,
  now = Date.now(),
): string {
  sweepExpired(storage, now)
  if (inMemoryId) {
    const stored = readStored(storage, owner, fingerprint, now)
    // Publish this tab's id when the slot is empty. Do not replace another
    // tab's id; this confirmation still retries with the id it already sent.
    if (!stored || stored === inMemoryId) remember(storage, owner, fingerprint, inMemoryId, now)
    return inMemoryId
  }
  const stored = readStored(storage, owner, fingerprint, now)
  if (stored) {
    remember(storage, owner, fingerprint, stored, now)
    return stored
  }
  const minted = mint()
  remember(storage, owner, fingerprint, minted, now)
  return readStored(storage, owner, fingerprint, now) || minted
}
