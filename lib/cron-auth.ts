// Shared by proxy.ts and the scheduled-send worker. TextEncoder and a full
// XOR scan only, so the proxy bundle does not need Node's crypto module.
// Next.js 16 runs proxy on Node today; this still holds if that bundle is
// edge-constrained.
// A length mismatch still fails. The loop always walks the longer input, so a
// difference at either end takes the same path when the lengths match, and a
// shorter value does not return before the scan.

export function timingSafeEqualUtf8(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  const length = a.length > b.length ? a.length : b.length
  let diff = a.length === b.length ? 0 : 1
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function cronSecretMatches(presented: string | null, secret: string): boolean {
  return timingSafeEqualUtf8(presented ?? '', `Bearer ${secret}`)
}
