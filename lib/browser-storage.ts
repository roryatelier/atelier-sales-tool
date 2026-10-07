const OWNER_KEY = 'atelier:storage-owner:v2'
const LEGACY_KEYS = ['current_dossier','selected_contact','email_tabs','dossier_tabs','dossier_active_tab','dossier_back','email_template','follow_up_context','last_contacted_date','lead_source','pitch_bullet','atelier_user_name','search_history','pipeline_lead','cache_competitor_signals','cache_trend_matches','cache_market_pulse']
let activeUserId: string | null = null
const listeners = new Set<() => void>()
export function storageOwner(): string | null {
  try { return localStorage.getItem(OWNER_KEY) } catch { return null }
}
export function activeStorageOwner(): string | null {
  const owner = storageOwner()
  return activeUserId && owner === activeUserId ? owner : null
}
export function matchesDraftIdentity(draftOwner: string | null, observedUserId: string | null): boolean {
  return !!draftOwner && draftOwner === observedUserId && activeStorageOwner() === draftOwner
}
export function subscribeStorageOwner(listener: () => void) {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => { if (event.key === OWNER_KEY || event.key === null) listener() }
  window.addEventListener('storage', onStorage)
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage) }
}
export function activateBrowserIdentity(userId: string) {
  if (!userId) return
  try {
    for (const key of LEGACY_KEYS) localStorage.removeItem(key)
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key?.startsWith('atelier:draft:v2:') && !key.startsWith('atelier:draft:v2:' + userId + ':')) localStorage.removeItem(key)
    }
    activeUserId = userId
    localStorage.setItem(OWNER_KEY, userId)
  } catch { activeUserId = null }
  for (const listener of listeners) listener()
}
function scopedKey(key: string) {
  if (!activeUserId || storageOwner() !== activeUserId) throw new Error('Account changed. Reload before continuing.')
  return 'atelier:draft:v2:' + activeUserId + ':' + key
}
export const userStorage = {
  getItem(key: string) { return localStorage.getItem(scopedKey(key)) },
  setItem(key: string, value: string) { localStorage.setItem(scopedKey(key), value) },
  removeItem(key: string) { localStorage.removeItem(scopedKey(key)) },
}
