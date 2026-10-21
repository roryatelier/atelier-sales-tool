// Shared across browser documents, independently of each composer's snapshots.
// Transactions serialize claims for the same confirmed bytes, so a stale tab
// cannot replace another tab's confirmation with a newly minted request id.
const DATABASE_NAME = 'atelier-send-confirmations-v1'
const STORE_NAME = 'confirmations'
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface StoredConfirmation {
  key: string
  requestId: string
}

function confirmationKey(owner: string, tabId: string, draftKey: string): string {
  if (![owner, tabId, draftKey].every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('Send confirmation identity is unavailable')
  }
  if (!/^[0-9a-f]{64}$/.test(draftKey)) throw new Error('Send confirmation fingerprint is invalid')
  return JSON.stringify([owner, tabId, draftKey])
}

function validRecord(value: unknown, key: string): value is StoredConfirmation {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<StoredConfirmation>
  return record.key === key && typeof record.requestId === 'string' && REQUEST_ID_PATTERN.test(record.requestId)
}

function transact<T>(operation: (store: IDBObjectStore, result: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Send confirmation storage is unavailable'))
      return
    }

    let settled = false
    let database: IDBDatabase | undefined
    let transaction: IDBTransaction | undefined
    let result: T
    let resultReady = false

    function fail(error: Error) {
      if (settled) return
      settled = true
      try { transaction?.abort() } catch { /* already completed or aborted */ }
      database?.close()
      reject(error)
    }

    let opening: IDBOpenDBRequest
    try {
      opening = indexedDB.open(DATABASE_NAME, 1)
    } catch {
      fail(new Error('Send confirmation storage could not be opened'))
      return
    }

    opening.onblocked = () => fail(new Error('Send confirmation storage is blocked'))
    opening.onerror = () => fail(opening.error ?? new Error('Send confirmation storage could not be opened'))
    opening.onupgradeneeded = () => {
      if (settled) {
        opening.transaction?.abort()
        return
      }
      try {
        if (!opening.result.objectStoreNames.contains(STORE_NAME)) {
          opening.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
        }
      } catch {
        opening.transaction?.abort()
        fail(new Error('Send confirmation storage could not be initialized'))
      }
    }
    opening.onsuccess = () => {
      database = opening.result
      if (settled) {
        database.close()
        return
      }
      database.onversionchange = () => {
        fail(new Error('Send confirmation storage changed; reload before sending'))
        database?.close()
      }
      try {
        transaction = database.transaction(STORE_NAME, 'readwrite')
        transaction.onabort = () => fail(transaction?.error ?? new Error('Send confirmation storage transaction was aborted'))
        transaction.onerror = () => fail(transaction?.error ?? new Error('Send confirmation storage transaction failed'))
        transaction.oncomplete = () => {
          if (settled) return
          if (!resultReady) {
            fail(new Error('Send confirmation storage did not return an identity'))
            return
          }
          settled = true
          database?.close()
          resolve(result)
        }
        operation(transaction.objectStore(STORE_NAME), value => {
          result = value
          resultReady = true
        }, fail)
      } catch {
        fail(new Error('Send confirmation storage transaction could not be started'))
      }
    }
  })
}

export async function claimStoredSendId(owner: string, tabId: string, draftKey: string, preferredRequestId: string): Promise<string> {
  const key = confirmationKey(owner, tabId, draftKey)
  if (typeof preferredRequestId !== 'string' || !REQUEST_ID_PATTERN.test(preferredRequestId)) {
    throw new Error('Send confirmation request id is invalid')
  }
  return transact<string>((store, result, fail) => {
    const reading = store.get(key)
    reading.onsuccess = () => {
      const existing: unknown = reading.result
      if (existing !== undefined) {
        if (!validRecord(existing, key)) {
          fail(new Error('Stored send confirmation is invalid; review the existing send before continuing'))
          return
        }
        result(existing.requestId)
        return
      }
      try {
        store.add({ key, requestId: preferredRequestId } satisfies StoredConfirmation)
        result(preferredRequestId)
      } catch {
        fail(new Error('Send confirmation identity could not be saved'))
      }
    }
  })
}

export async function forgetStoredSendId(owner: string, tabId: string, draftKey: string, requestId: string): Promise<void> {
  const key = confirmationKey(owner, tabId, draftKey)
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Send confirmation request id is invalid')
  }
  return transact<void>((store, result, fail) => {
    const reading = store.get(key)
    reading.onsuccess = () => {
      const existing: unknown = reading.result
      if (existing !== undefined && !validRecord(existing, key)) {
        fail(new Error('Stored send confirmation is invalid; review the existing send before continuing'))
        return
      }
      try {
        if (existing !== undefined && (existing as StoredConfirmation).requestId === requestId) store.delete(key)
        result(undefined)
      } catch {
        fail(new Error('Send confirmation identity could not be cleared'))
      }
    }
  })
}
