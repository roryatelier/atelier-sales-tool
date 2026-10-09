import 'server-only'

// Provider errors may carry HTTP headers, tokens, bodies and request configuration.
export function logSafeError(label: string, error: unknown) {
  const value = typeof error === 'object' && error !== null
    ? error as { status?: unknown; httpStatus?: unknown; code?: unknown; requestId?: unknown; response?: { status?: unknown } }
    : {}
  const status = typeof value.status === 'number' ? value.status
    : typeof value.httpStatus === 'number' ? value.httpStatus
    : typeof value.response?.status === 'number' ? value.response.status : undefined
  const code = typeof value.code === 'number' || typeof value.code === 'string' ? value.code : undefined
  const requestId = typeof value.requestId === 'string' ? value.requestId : undefined
  console.error(label, { status, code, requestId })
}
