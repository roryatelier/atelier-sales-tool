import type { Metadata } from 'next'
import './globals.css'
import { getSession } from '@/lib/session'
import NavItems from './components/NavItems'
import UserStorageBoundary from './components/UserStorageBoundary'

export const metadata: Metadata = {
  title: {
    default: 'Atelier',
    template: '%s — Atelier'
  },
  description: 'AI Sales Intelligence',
}

async function SavedCount() {
  try {
    const { isVercel, getLocalDb } = await import('@/lib/db')
    let count = 0
    if (isVercel) {
      const { sql } = await import('@vercel/postgres')
      const result = await sql`SELECT COUNT(*) as count FROM saved_suggestions`
      count = parseInt(result.rows[0].count)
    } else {
      const db = getLocalDb()
      const result = db.prepare('SELECT COUNT(*) as count FROM saved_suggestions').get() as { count: number }
      count = result.count
    }
    if (count === 0) return null
    return (
      <span style={{ marginLeft: 'auto', background: '#050849', color: '#fff', fontSize: 10, fontWeight: 600, borderRadius: 10, padding: '1px 6px', minWidth: 16, textAlign: 'center' }}>
        {count}
      </span>
    )
  } catch {
    return null
  }
}

async function UserBar() {
  const session = await getSession()
  const name = session?.name ?? 'Guest'
  const email = session?.email ?? ''
  const initials = name.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)

  return (
    <div className="sidebar-foot">
      {session?.picture ? (
        <img
          src={session.picture}
          alt={name}
          style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        />
      ) : (
        <div className="avatar">{initials}</div>
      )}
      <div className="who">
        <div className="nm">{name}</div>
        <div className="rl">{email}</div>
      </div>
    </div>
  )
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getSession()

  return (
    <html lang="en">
      <body>
        <div className="app">
          <aside className="sidebar">
            <div className="sidebar-brand">
              <span style={{ color: '#fff', fontSize: '15px', fontFamily: 'var(--font-display)', fontWeight: 500, letterSpacing: '0.2em' }}>ATELIER®</span>
            </div>
            <div className="sidebar-tagline">Sales Intelligence</div>
            <nav className="nav">
              <NavItems gmailUrl="https://mail.google.com" />
            </nav>
            <UserBar />
          </aside>
          <main className="main">
            <div className="main-inner">
              <UserStorageBoundary userId={session?.googleSub ?? ''}>{children}</UserStorageBoundary>
            </div>
          </main>
        </div>
      </body>
    </html>
  )
}