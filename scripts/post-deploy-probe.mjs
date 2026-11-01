// Post-deploy probe. Run by the post-deploy workflow after a merge to main.
//
// It proves four things about the live site and prints counts only:
//   1. the running build is the commit that was just pushed (health route);
//   2. an anonymous API call is still refused (401);
//   3. the home page still redirects an anonymous visitor to sign-in;
//   4. no legacy-quarantined scheduled job carries a Gmail message id, i.e.
//      nothing that was quarantined has been sent.
//
// It only issues GET requests. It never calls the cron route that sends mail.
// The probe secret comes from the environment, is never logged, and the run
// fails if it is missing.

const baseUrl = (process.env.PROBE_BASE_URL || '').replace(/\/+$/, '')
const expectedSha = process.env.PROBE_EXPECTED_SHA || ''
const secret = process.env.PROBE_CRON_SECRET || ''
const timeoutSeconds = Number(process.env.PROBE_TIMEOUT_SECONDS || 900)
const intervalSeconds = Number(process.env.PROBE_INTERVAL_SECONDS || 20)

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

if (!baseUrl) fail('PROBE_BASE_URL is not set')
if (!expectedSha) fail('PROBE_EXPECTED_SHA is not set')
if (!secret) fail('the probe secret is not set; install it as a repository secret before relying on this check')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitForCommit() {
  const deadline = Date.now() + timeoutSeconds * 1000
  let lastSeen = 'no response'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { redirect: 'manual' })
      if (response.status === 200) {
        const body = await response.json()
        lastSeen = typeof body.commit === 'string' ? body.commit.slice(0, 12) : 'no commit field'
        if (body.status === 'ok' && body.commit === expectedSha) {
          console.log(`ok: health reports the pushed commit (${expectedSha.slice(0, 12)}), env=${body.env}`)
          return
        }
      } else {
        lastSeen = `HTTP ${response.status}`
      }
    } catch {
      lastSeen = 'request failed'
    }
    await sleep(intervalSeconds * 1000)
  }
  fail(`health did not report the pushed commit within ${timeoutSeconds}s (last seen: ${lastSeen})`)
}

async function checkAnonymousApiDenied() {
  const response = await fetch(`${baseUrl}/api/pipeline`, { redirect: 'manual' })
  if (response.status !== 401) fail(`anonymous GET /api/pipeline returned ${response.status}, expected 401`)
  console.log('ok: anonymous API call is refused (401)')
}

async function checkHomeRedirectsToSignIn() {
  const response = await fetch(`${baseUrl}/`, { redirect: 'manual' })
  const location = response.headers.get('location') || ''
  if (response.status < 300 || response.status >= 400 || !location.includes('/api/auth/gmail')) {
    fail(`anonymous GET / did not redirect to sign-in (status ${response.status})`)
  }
  console.log('ok: anonymous home page redirects to sign-in')
}

async function checkQuarantine() {
  const anonymous = await fetch(`${baseUrl}/api/cron/quarantine-status`, { redirect: 'manual' })
  if (anonymous.status !== 401) fail(`quarantine status answered ${anonymous.status} without the secret, expected 401`)
  const response = await fetch(`${baseUrl}/api/cron/quarantine-status`, {
    redirect: 'manual',
    headers: { authorization: `Bearer ${secret}` },
  })
  if (response.status !== 200) fail(`quarantine status returned ${response.status} with the secret (is the repository secret current?)`)
  const body = await response.json()
  const sent = body.legacy_quarantined_with_message_id
  if (!Number.isInteger(sent)) fail('quarantine status response was not in the expected shape')
  const counts = body.status_counts && typeof body.status_counts === 'object' ? body.status_counts : {}
  console.log(`scheduled job counts by state: ${JSON.stringify(counts)}`)
  if (sent !== 0) fail(`${sent} legacy-quarantined job(s) carry a Gmail message id`)
  console.log('ok: no quarantined job has been sent')
}

await waitForCommit()
await checkAnonymousApiDenied()
await checkHomeRedirectsToSignIn()
await checkQuarantine()
console.log('post-deploy checks passed')
