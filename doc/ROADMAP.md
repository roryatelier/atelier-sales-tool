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

### PR #13: immediate-send retries (prepared, not merged)

The PR adds durable send records, payload-bound request IDs, atomic claims,
accepted/failed/review outcomes, and replay without another Gmail call. The
composer saves the confirmation before contacting the server, restores each
tab's attachments and request identity after reload, and routes late outcomes
to the originating draft. Browser storage failure blocks that attempt.

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

What the durable-sending spec still requires:

- One job model shared by immediate and scheduled sends, with idempotency key, payload hash, and a frozen recipient snapshot.
- Explicit states for queued, claimed, sending, accepted, failed, needs_auth, cancelled, and ambiguous, including the case where Gmail may have accepted the message and the database write did not.
- A lease that cannot cause a second send after a durable send intent.
- The same MIME builder for both paths. Immediate send is HTML plus attachments (`app/api/send-email/route.ts`). Scheduled send uses the plain-text builder in `lib/gmail.ts`.
- Cancellation rules for a job already claimed, an overdue-job alert independent of the cron ping, and a documented decision before any quarantined row is activated.
- The cron schedule in `vercel.json` is every 15 minutes. Whether the live Vercel plan allows that interval is an operator check, not something the repo can prove.

### Draft handoff

Reveal, select, and draft keep the chosen address, manual To edits win over a late result, and send requires `to`. Still open from the drafting spec:

- A server-owned draft with stable id, revision, owner, and attachment references.
- Confirmation that freezes the whole revision. A later edit must not send a mix of old and new fields.
- Persistence that survives a corrupt or legacy browser store with a visible recovery path.
- Attachment bytes somewhere other than the browser, with ownership and retention.

### Sheets pipeline

Appends go through `lib/sheets.ts` (`Sheet1!A:Q`, including a sender column). Status updates still change the first row whose brand name matches, on column O. Notes and status for a second contact at the same brand can hit the wrong row. Scheduled sends log a Sheets failure and still leave the job `sent`. There is no outreach id, outbox, or sync status.

The October review saw the live pipeline read fail. This reconciliation did not call production. Treat a current 500 as something to diagnose from sanitized provider errors (credential, spreadsheet id, sharing, tab name, quota), not as a known single cause.

## Open

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
