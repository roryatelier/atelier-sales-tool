import { authorizeRequest } from '@/lib/api-auth'
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'

export async function GET(request: Request) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ user: null })
    }
    return NextResponse.json({
      user: {
        google_sub: session.googleSub,
        name: session.name,
        email: session.email,
        picture: session.picture
      }
    })
  } catch {
    return NextResponse.json({ user: null })
  }
}