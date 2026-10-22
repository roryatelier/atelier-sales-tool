# Roadmap

Backlog for `roryatelier/atelier-sales-tool`, reconciled on 19 October 2026 against `main` at `67456f7` (merge of pull request #7). GitHub Issues are disabled, so this file is the backlog.

Status meanings:

- **Done** — the behaviour is on `main`, checked against the current tree. A merged pull request number is cited where the change landed as a PR. Earlier work landed as direct commits and is cited by what the code does now.
- **Partial** — some of the specified behaviour is on `main`, and the rest is still open.
- **Open** — specified, not implemented. Do not treat an old note outside the repo as proof it shipped.
- **Operator** — needs a person with admin access to GitHub, Vercel, Google, or a provider account. An agent pull request cannot close it.

`SECURITY_CONTAINMENT.md` describes the containment patch and is stale about the scheduler. `doc/TECHNICAL_HANDOFF.md` and `doc/PROMPTS.md` still describe an older framework version and the retired model. Prefer this file, `AGENTS.md`, and the code.

## Review update — 20 October 2026

Checked against `c2a0f66` (PR #11). The sections below were originally reconciled
before PRs #8–#11; this update takes precedence where they differ.

- **Done, #8:** draft generation displays the selected template and role group.
- **Done, #10:** each sender can save a signature. The composer previews it and
  immediate and scheduled sending use the shared HTML/MIME builder. This closes
  the shared-builder gap listed under Scheduled sending below.
- **Done, #11:** per-draft instructions are retained per browser tab and sent to
  generation. Guidance source and revision are displayed. Prompt precedence is a
  model instruction, not a runtime guarantee.
- **Fix prepared, awaiting schema review:** distinguish seeded default guidance,
  explicitly saved guidance, and legacy guidance whose origin was not recorded.
  Preserve all legacy content. Integration coverage reproduces initial seeding,
  migration and explicit saves against a temporary SQLite database. PostgreSQL
  migration still needs deployment verification after review.
- **Release label:** `v0.2.2` labels the already-deployed signatures and generation
  controls at `c2a0f66`, including the known provenance limitation in its notes.
- **Verified release evidence:** PR #11's GitHub `verify` check and Vercel production
  deployment succeeded. Its second Codex review raised a remaining P2 provenance
  finding; the review was not clean. Green CI did not close that finding.
- **Still partial:** durable immediate/scheduled send states and idempotency;
  server-owned frozen draft revisions; dependable Sheets sync and visible failures.
- **Still open:** accepted-send ledger/outbox, Copper pilot, and automated release
  probes. Existing mocked tests do not prove live Gmail delivery or Lusha coverage.

## Priority

1. **Durable sending gaps** while the scheduler is live (partial work below). Ambiguous Gmail outcomes must stay visible and must not send twice.
2. **Draft confirmation.** The revealed address now survives into the composer; a frozen revision, idempotency key, and shared MIME builder do not exist yet.
3. **Pipeline ledger.** Sheets is still an append plus a first-brand-name update. A failed sync must not look like a finished export, and a retry must not resend mail.
4. **Copper**, only after the ledger can record an accepted send exactly once.
5. **Release health.** A public health response and a post-deploy canary are not in the repo. CI `verify` does not call live providers.
6. **Remaining doc drift** in handover and prompt notes, without copying prospect or operator data into the repo.

### Immediate-send retries (#13)

The implementation adds durable send records, payload-bound request IDs, atomic claims,
accepted/failed/review outcomes, and replay without another Gmail call. The
composer saves the confirmation before contacting the server, restores each
tab's attachments and request identity after reload, and routes late outcomes
to the originating draft. Browser storage failure blocks that attempt.
Atomic IndexedDB claims share identities across browser documents for the same
saved draft. Draft fingerprints use SHA-256 instead of copying attachment data
into confirmation keys. Stale snapshot writes cannot erase shared identities.

Review corrections also repair earlier SQLite send-record schemas without
discarding valid records; incompatible records fail closed. Disposable native
PostgreSQL verification exercised the actual schema and route SQL with mocked
Gmail: 12 concurrent identical requests caused one Gmail attempt. This checks SQL
and concurrency through a local PostgreSQL adapter, not Neon transport or live
delivery. Production migration and a deliberately approved internal send remain
release checks. Scheduler recovery and the Sheets ledger/outbox remain separate.

## Done

### Access containment in the application

On `main`, from the containment work and the modules it left behind:

- `proxy.ts` authenticates pages and APIs. OAuth start/callback are the browser exceptions. The cron path requires `CRON_SECRET`.
- Sessions are versioned signed claims bound to the Google subject (`lib/auth-policy.ts`, `lib/session.ts`). Admission is an exact email allowlist. Missing `JWT_SECRET` or an empty allowlist fails closed.
- Gmail credentials are encrypted separately and opened only for the same subject and email.
- API handlers call `authorizeRequest` before provider work. Cookie-authenticated mutations require a matching `Origin`.
- Browser state is scoped to the signed-in subject (`lib/browser-storage.ts`, `UserStorageBoundary`).
- Vercel refuses to start the database layer when `POSTGRES_URL` is missing.
- `tests/security.cjs` covers this boundary with mocks. Those tests do not prove live Google, Gmail, or IAM behaviour.

Operator follow-through (revocation evidence, history purge, production secret installation) stays open. Removing a credential from HEAD does not remove it from git history. Do not rewrite history in an application pull request.

### OpenAI-only provider

AI routes use the shared OpenAI modules. `scripts/check-provider-policy.mjs`, `config/env.schema.json`, and `config/deployment.json` are the guards. The retired SDK is not a dependency.

Not done from that corrective plan: an automated Preview smoke test and a production canary. Neither exists under `.github/workflows/`. `verify` builds and runs mocked suites only.

### Lusha discovery and reveal

The critical four-part repair is on `main` (`lib/lusha.ts`, `app/api/lookup-contacts/route.ts`, both contact pickers, `tests/lusha.cjs`, `tests/lusha-ui.cjs`):

- Search starts at page 0, does not send the unsupported per-company cap, and returns pagination metadata.
- Load more merges by provider id and keeps addresses already revealed.
- Placeholder people, emails, and phones are gone. No-match, configuration, credentials, credits, rate limit, and failure are distinct.
- Reveal is explicit, requests emails only, and turns waterfall off. A mismatched Google subject is rejected before the provider call. Work addresses are preferred. Private or unknown types need an explicit choice. The composer treats the current To field as authoritative and does not reveal on selection.

**Done in #3.** Contact search resolves the dossier through Lusha's company search and searches by canonical company id. When the name and the domain point at different companies, the user chooses. Pagination keeps the chosen id.

Still deferred, on purpose, from that repair: a durable revealed-contact store, cross-process deduplication of paid reveals, asynchronous waterfall and job polling, department or seniority filters, and any promise that a second reveal will not spend credits.

### Gmail send failures

**Done in #2.** `lib/gmail.ts` classifies authentication, permission, policy, quota, temporary, and unknown Gmail failures. The immediate send path retries once only after an authentication failure, keeps success once Gmail has accepted the message, and returns a safe error to the composer. Coverage is in `tests/security.cjs` and `tests/email-provider.cjs`.

### Brand search

**Done in #4.** Previously researched dossiers are listed with saved suggestions, deduplicated, and opened without paying for research again.

### Outreach templates

**Done in #5, #6, and #7.**

- #5 restores the company template library with a one-time database seed, maps real job titles onto role groups, and applies the best matching template when the user has not chosen one.
- #6 removes follow-up copy that claimed an introduction deck was attached, stops the prompt from demanding several buying signals when the dossier has fewer, and carries original subject and date into template follow-ups.
- #7 makes selection order: user role-specific, user General, recovered role-specific, recovered General. Product-marketing titles map to the CMO group.

User edits survive the seed. Tests live in `tests/email-content.cjs`.

### Signature editor empty state

**Done on branch `fix/signature-empty-state`** (PR number to be filled at merge). The signature editor button no longer reads "Saved" when nothing is saved. A new pure helper `signatureEditorState` in `lib/email-signature.ts` distinguishes empty (button "Save signature", disabled until text is entered, "No signature saved yet" hint shown), unchanged ("Saved", disabled), edited ("Save signature", enabled), and clearing (empty editor over a saved signature stays enabled so a signature can still be removed). Unit coverage in `tests/email-signature.cjs`.

## Partial

### Scheduled sending

Later commits after containment turned scheduled sending back on for **new** jobs. That is what the code does now. `SECURITY_CONTAINMENT.md` still says the scheduler returns 503 and that scheduling is paused. Do not "fix" the worker back to a blanket 503 unless Rory asks.

What is on `main`:

- New jobs are inserted as `pending` with owner subject, owner email, sealed credentials, timezone, and payload (`app/api/schedule-email/route.ts`).
- The column default for unmigrated rows is `legacy_quarantined`. The worker selects only `pending`.
- Postgres claims with `FOR UPDATE SKIP LOCKED`. Local SQLite claims inside a transaction. Claimed jobs move to `sending`.
- Success stores `sent`, `sent_at`, and `gmail_message_id`. Failures become `needs_reauth` or `needs_review` and are not automatically retried (`app/api/cron/send-scheduled-emails/route.ts`).
- The dashboard lists pending, sending, needs_reauth, and needs_review for the signed-in owner. `paused` is false.
- Local time conversion rejects a wall-clock time that does not exist in the chosen zone.

Recovery patch prepared for review (21 October 2026):

- Token-bound `claimed` preparation precedes durable `sending` intent. After five
  minutes, interrupted preparation can return to pending; a send attempt becomes
  `needs_review` and never automatically retries. A late Gmail id can resolve only
  that original attempt. Legacy quarantined jobs remain untouched.
- Cancellation atomically fences pending/preparing jobs before intent. Only the
  owner may explicitly resume a pre-intent `needs_reauth` job using freshly verified
  credentials. Recipients, message and scheduled time remain unchanged.
- Token-refresh outages back off before intent; a revoked grant needs reconnection.
  SQLite normalizes schedule timestamps before comparing them with the clock.
- The dashboard refreshes independently of pipeline/cron responses, flags jobs over
  30 minutes late, preserves failed actions, and checks the captured browser owner.
- SQLite regressions and browser scenarios cover recovery, fencing, uncertainty,
  cancellation, explicit resume, account changes, refresh races and timezone display.
  Disposable native PostgreSQL verification covers the actual schema and store SQL,
  concurrent claims/workers and lost write acknowledgments with synthetic providers.
  These checks do not prove Neon transport or live Gmail acceptance.

Remaining work:

- A shared immediate/scheduled job model with schedule-request idempotency and frozen
  revisions. This patch does not deduplicate repeated schedule submissions.
- Durable Sheets sync status/outbox and recovery after a crash following Gmail
  acceptance. Retrying export must never send Gmail again.
- External monitoring/alerts when nobody has the dashboard open. The overdue warning
  is polled by the dashboard; it is not an installed independent uptime monitor.
- Verify the live Vercel plan permits the configured 15-minute interval. Recovery
  runs on the next successful worker invocation, not a separate timer.
- Human review before activating any quarantined row. None are activated here.

### Draft handoff

Reveal, select, and draft keep the chosen address, manual To edits win over a late result, and send requires `to`. Still open from the drafting spec:

- A server-owned draft with stable id, revision, owner, and attachment references.
- Confirmation that freezes the whole revision. A later edit must not send a mix of old and new fields.
- Persistence that survives a corrupt or legacy browser store with a visible recovery path.
- Attachment bytes somewhere other than the browser, with ownership and retention.

### Sheets pipeline

Outbox patch prepared for review (21 October 2026):

- New accepted sends atomically enqueue an owner-scoped export with a frozen
  pipeline snapshot. Both immediate and scheduled acceptance writes use database
  triggers. Repeated acceptance does not create another event; legacy rows are
  not backfilled or reclassified.
- Exports have globally unique, stable outreach IDs. A confirmed write creates a new Sheet1 row
  and its developer metadata in one batch; subsequent status/notes edits target
  that metadata instead of a remembered row position.
- Pre-write failures can retry. A possibly committed write only reconciles by ID;
  an absent ID does not authorize another append. Export workers never call Gmail.
- The pipeline page shows pending/failed/uncertain exports and owner-bound retry
  controls independently of the pipeline read. The existing cron services one
  queued export per run; newly accepted sends also attempt their own export.
- Setup, rollback, data boundaries and live acceptance checks are documented in
  `doc/SHEETS_EXPORTS.md`. Sheet1 R:S must be explicitly reserved before export.

Sheets remains the pipeline read source. This is not a migration of existing
Sheets history into a canonical database pipeline. Legacy brand-only edits are
allowed only for one unambiguous row and retain the old positional-write limit:
operators must avoid sorting/inserting/deleting during these edits. Legacy
metadata migration, contact-history repair after crashes, a dedicated export
worker and a rehearsed canonical-ledger cutover remain open.

## Open

### Data-quality banner copy

The "Limited ANZ data found. Verify before outreach." banner (`app/dossier/page.tsx`, fires on `data_quality === 'insufficient'`) is misleading for non-ANZ brands: the condition is generic low data quality, not ANZ-specific absence. Rename to "Limited data found. Verify before outreach." One-line copy change; no scoring logic affected. Follow-ons (separate items): native-currency revenue display alongside AUD banding; region-aware research prompt for non-ANZ brands.

### Ledger, then Copper

Do this after durable send states exist.

- The database becomes the outreach ledger only after a rehearsed migration. Until that cutover, Sheets stays the pipeline the UI reads.
- An accepted-send record and a Sheets/CRM outbox event commit together. Destination workers retry without calling Gmail.
- Export rows are keyed by outreach id. Failed and unsent jobs do not appear as accepted sends.
- Legacy rows with no trustworthy owner or Gmail id stay unknown. Do not backfill them as verified sends.
- Copper is a pilot after that, against the tenant's real objects and fields. Match people by exact email or a stored Copper id. Ambiguous matches stop for a person. Create an activity only after Gmail acceptance. Uncertain CRM writes are not blindly repeated.
- Decide the shared fields before any backfill. Default exclusion: BCC, body, attachments, tokens, and mailbox metadata.

### Release probes

Not in the tree today, and not part of the current CI job:

- `GET /api/health` returning status, commit, and environment, with no provider calls.
- A post-deploy check that the health response matches the deployed commit, an anonymous API call is denied, `/` redirects to Google sign-in, and quarantined rows are still not sent.
- Rollback via the Vercel project, using a token that lives in GitHub Actions and not in an agent environment.

### Doc drift left on purpose

| File | What is stale |
|---|---|
| `doc/TECHNICAL_HANDOFF.md` | Still says Next.js 14 and Node.js 18, and still points operators at a retired coding tool |
| `doc/PROMPTS.md`, `Prompts/` | Still describe the retired model by name |
| `doc/HANDOVER.md` | Workflow guide. It publishes the pipeline spreadsheet id |
| `SECURITY_CONTAINMENT.md` | Scheduler described as paused and returning 503 |
| `doc/CORRECTIVE_ACTION_PLAN_API_PROVIDER_DRIFT.md` | Execution plan from before the provider migration finished. Keep it as history |

Fix those in a docs pull request. Do not copy private addresses, prospect names, or credential material out of older notes into the repo.

## Operator checklist (not code)

These were still open when this roadmap was written. Confirm before treating production as settled:

- Branch ruleset on `main` requiring the `verify` check, with code-owner review for `.github/CODEOWNERS`. The active ruleset "Automatic Copilot review" only requests Copilot review. It does not require `verify`.
- Vercel Git integration on the project in `config/deployment.json`, production branch `main`, previews for pull requests. Absence of Vercel commit statuses on `main` means this was not confirmed from the repository.
- Secret scanning and push protection stay on. The repository is public.
- Approved named-user list installed in the target environment, distinct from any preview allowlist.
- Live Lusha checks only under an agreed credit budget. The mocked suites do not prove a live reveal.
- Whether anyone should activate a `legacy_quarantined` job. Default is no.
