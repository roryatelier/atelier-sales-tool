import 'server-only'
import { cookies } from 'next/headers'
import { verifySession, openGmailCredentials, type UserSession } from './auth-policy'
export type { UserSession } from './auth-policy'

export async function getSession(): Promise<UserSession | null> {
  const token = (await cookies()).get('atelier_session')?.value
  return token ? verifySession(token) : null
}

export async function getGmailCredentials(user: UserSession) {
  const token = (await cookies()).get('atelier_gmail')?.value
  return token ? openGmailCredentials(token, user) : null
}
