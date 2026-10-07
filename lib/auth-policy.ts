import 'server-only'
import { jwtVerify, SignJWT, EncryptJWT, jwtDecrypt } from 'jose'

export const SESSION_VERSION = 2
const ISSUER = 'atelier-sales-tool'
const AUDIENCE = 'atelier-app'
export interface UserSession { googleSub: string; email: string; name: string; picture: string }
export interface GmailCredentials { googleSub: string; email: string; accessToken: string; refreshToken?: string }

function signingKey(): Uint8Array {
  const key = new TextEncoder().encode(process.env.JWT_SECRET ?? '')
  if (key.length < 32) throw new Error('Security configuration missing')
  return key
}
function allowlist() {
  const parse = (value: string | undefined) => (value ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean)
  return { emails: parse(process.env.APP_ALLOWED_EMAILS) }
}
export function securityConfigured(): boolean {
  try {
    signingKey()
    const { emails } = allowlist()
    return emails.length > 0
  } catch { return false }
}
export function isAuthorizedEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase()
  const parts = normalized.split('@')
  if (parts.length !== 2 || !parts[0]) return false
  const { emails } = allowlist()
  return emails.includes(normalized)
}
export async function signSession(user: UserSession): Promise<string> {
  if (!securityConfigured() || !isAuthorizedEmail(user.email)) throw new Error('User not authorized')
  return new SignJWT({ ...user, sessionVersion: SESSION_VERSION })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.googleSub)
    .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('30d')
    .sign(signingKey())
}
export async function verifySession(token: string): Promise<UserSession | null> {
  try {
    if (!securityConfigured()) return null
    const { payload } = await jwtVerify(token, signingKey(), { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE })
    if (payload.sessionVersion !== SESSION_VERSION || typeof payload.googleSub !== 'string' || !payload.googleSub ||
      payload.sub !== payload.googleSub || typeof payload.email !== 'string' || typeof payload.name !== 'string' ||
      typeof payload.picture !== 'string' || !isAuthorizedEmail(payload.email)) return null
    return { googleSub: payload.googleSub, email: payload.email, name: payload.name, picture: payload.picture }
  } catch { return null }
}
async function credentialKey(): Promise<Uint8Array> {
  signingKey()
  const source = new TextEncoder().encode('atelier:gmail:v2:' + process.env.JWT_SECRET)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', source))
}
export async function sealGmailCredentials(credentials: GmailCredentials): Promise<string> {
  return new EncryptJWT({ ...credentials }).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(ISSUER).setAudience('atelier-gmail').setIssuedAt().setExpirationTime('30d')
    .encrypt(await credentialKey())
}
export async function openGmailCredentials(token: string, user: Pick<UserSession, 'googleSub' | 'email'>): Promise<GmailCredentials | null> {
  try {
    const { payload } = await jwtDecrypt(token, await credentialKey(), { issuer: ISSUER, audience: 'atelier-gmail', keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] })
    if (payload.googleSub !== user.googleSub || payload.email !== user.email || typeof payload.accessToken !== 'string' ||
      (payload.refreshToken !== undefined && typeof payload.refreshToken !== 'string') || !isAuthorizedEmail(user.email)) return null
    return { googleSub: user.googleSub, email: user.email, accessToken: payload.accessToken, refreshToken: payload.refreshToken as string | undefined }
  } catch { return null }
}
