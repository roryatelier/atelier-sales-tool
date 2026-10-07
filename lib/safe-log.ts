import 'server-only'

// Provider errors may carry HTTP headers, tokens, bodies and request configuration.
export function logSafeError(label: string, error: unknown) {
  const value = typeof error === 'object' && error !== null
    ? error as { status?: unknown; code?: unknown; response?: { status?: unknown } }
    : {}
  const status = typeof value.status === 'number' ? value.status
    : typeof value.response?.status === 'number' ? value.response.status : undefined
  const code = typeof value.code === 'number' ? value.code : undefined
  console.error(label, { status, code })
}
