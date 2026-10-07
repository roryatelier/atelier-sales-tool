'use client'
import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { activateBrowserIdentity, activeStorageOwner, subscribeStorageOwner } from '@/lib/browser-storage'

export default function UserStorageBoundary({ userId, children }: { userId: string; children: ReactNode }) {
  const owner = useSyncExternalStore(subscribeStorageOwner, activeStorageOwner, () => null)
  useEffect(() => { activateBrowserIdentity(userId) }, [userId])
  if (!userId || owner !== userId) {
    return <p role="status">Checking account access. If your account changed, reload this page before continuing.</p>
  }
  return children
}
