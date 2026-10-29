<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Working on the Atelier Sales Intelligence Tool

This is the maintained repository: `roryatelier/atelier-sales-tool`. It is a **public** Next.js application for brand research, contact lookup, outreach drafting, Gmail sending, and a Google Sheets pipeline. An autonomous engineer may open and merge pull requests here. Limits that matter are enforced in GitHub (required `verify` check, code owners) and by never putting production credentials in the agent environment. This file is the working agreement.

Critique the change against the invariants below before you call it done. If you are unsure, say so in the pull request instead of guessing.

## Stack

- Next.js 16.2.9 (App Router, TypeScript), React 19, Tailwind 4. Request interception lives in `proxy.ts`. There is no `middleware.ts`.
- AI calls go through the shared OpenAI modules (`lib/openai.ts`, `lib/openai-email.ts`, `lib/openai-research.ts`) using the Responses API. Do not add another model vendor or call a provider directly from a route.
- Data: Neon/Vercel Postgres when `POSTGRES_URL` is set; `better-sqlite3` file `atelier.db` locally. On Vercel, missing Postgres configuration must fail closed (`lib/db.ts`). Schema changes are inline `CREATE`/`ALTER` statements in `lib/db.ts`, not a separate migrations directory.
- Access: Google OAuth, versioned `jose` session cookies, exact named-user allowlist (`APP_ALLOWED_EMAILS`). No domain-wide admission.
- Integrations: Lusha v3 (`lib/lusha.ts`), Gmail send (`lib/gmail.ts`, `app/api/send-email/`), Google Sheets (`lib/sheets.ts`).

## Layout

| Area | Where to start |
|---|---|
| Pages | `app/page.tsx` (dashboard), `app/portfolio`, `app/dossier`, `app/contacts`, `app/email`, `app/pipeline`, `app/templates`, `app/saved` |
| HTTP API | `app/api/*` (research, email, lookup-contacts, send-email, schedule-email, pipeline, cron) |
| Auth boundary | `proxy.ts`, `lib/auth-policy.ts`, `lib/api-auth.ts`, `lib/session.ts`, `app/api/auth/` |
| Browser account scope | `lib/browser-storage.ts`, `app/components/UserStorageBoundary.tsx` |
| Release checks | `scripts/check-*.mjs`, `config/deployment.json`, `config/env.schema.json` |
| Tests | `tests/*.cjs` (`node:test`; Lusha UI uses Playwright) |
| Backlog | `doc/ROADMAP.md` |

GitHub Issues are disabled. Track unfinished work in `doc/ROADMAP.md`.

## Commands

CI uses Node.js 20. Next.js 16 needs Node.js 20.9 or newer.

```bash
npm ci
npm run dev          # http://localhost:3000
npm run verify:ci    # the check GitHub Actions job `verify` runs
```

`verify:ci` is typecheck, eleven test suites (including the Playwright browser suites), provider policy, environment schema, and `next build`. Run it before opening a pull request.

Focused suites:

| Script | Covers |
|---|---|
| `npm run test:security` | sessions, allowlist, API auth, scheduling ownership |
| `npm run test:email` | Gmail send failure handling |
| `npm run test:email-content` | templates, titles, generation rules |
| `npm run test:research` / `test:provider` | research and OpenAI provider behaviour |
| `npm run test:lusha` | Lusha adapter and route |
| `npm run test:lusha:ui` | both contact pickers in a browser |

`test:lusha:ui` needs Playwright Chromium (`npx playwright install chromium` locally; CI installs it). It binds localhost port 3173 and must not call paid providers.

`npm run verify:release` is the local release gate: `verify:ci` plus `check:env` plus `check:deployment-target`. The last check reads `.vercel/project.json` and refuses a target other than `config/deployment.json`. It is not part of CI. Do not pull production environment variables in order to run it.

## Product invariants

Keep these true in code and in tests:

- Every non-public API authenticates before any provider or database work. Mutations require an exact matching `Origin`. Missing security configuration fails closed.
- No email is sent without an explicit user confirmation. The request's `to` field is the recipient. Never silently substitute a stored contact address.
- A scheduled, claimed, or Gmail-accepted state is not proof the recipient read or received the message. Gmail acceptance means a nonempty message id.
- Retrying Sheets (or any future CRM) sync must never send the email again. Ambiguous Gmail outcomes are reviewed, not automatically retried.
- Legacy scheduled rows stay `legacy_quarantined`. The worker claims only `pending` jobs. Do not auto-send or auto-activate quarantined rows.
- Lusha search reports real pagination and partial coverage. Empty coverage, missing configuration, credits, rate limits, and provider failures are distinct. Reveal is explicit, email-only, and does not invent people, addresses, or a verified badge. Do not automatically retry a paid reveal.
- Prospect, customer, and mailbox data does not belong in fixtures, snapshots, pull requests, or issues.

## Branching and pull requests

Branch from up-to-date `main`:

- `fix/<topic>` behaviour fixes
- `feat/<topic>` new behaviour
- `chore/<topic>`, `docs/<topic>`, `test/<topic>` for those kinds of change

One purpose per branch. Prefer a diff under a few hundred lines; split larger work.

Pull request titles use Conventional Commits: `fix:`, `feat:`, `docs:`, `chore:`, `test:`, with a specific imperative summary. The body states the problem, the change, the risk, how it was validated, and how to roll it back.

Behaviour changes need a focused regression test in `tests/` that fails before the fix and passes after. Documentation-only changes say so and still need a green `verify` check.

Wait for the `verify` check. Address substantive review comments. Merge is squash. Self-merge is allowed only when `verify` is green, the diff touches no path in `.github/CODEOWNERS`, and the change is not in the ask-first list. Otherwise request a review from `@roryatelier`.

## Ask first

These need Rory's review even when you believe the patch is safe. `.github/CODEOWNERS` makes GitHub require that review once the `main` ruleset enables code-owner review:

- Auth, session, and admission: `proxy.ts`, `lib/auth-policy.ts`, `lib/api-auth.ts`, `lib/session.ts`, `lib/browser-storage.ts`, `app/components/UserStorageBoundary.tsx`, `app/api/auth/`, `lib/safe-log.ts`
- Gmail sending and scheduling: `lib/gmail.ts`, `app/api/send-email/`, `app/api/schedule-email/`, `app/api/cron/`
- Lusha: `lib/lusha.ts`, `lib/lusha-contact.ts`, `app/api/lookup-contacts/`, `app/components/useLushaContacts.ts`, `app/components/ContactEmailActions.tsx`
- Schema: `lib/db.ts`
- Environment and deploy config: `config/`, `vercel.json`, `scripts/check-*.mjs`
- Workflows and ownership: `.github/**`
- Dependencies: `package.json`, `package-lock.json`

Also ask before changing what a prospect is sent, re-enabling a send path for quarantined jobs, deleting stored data, or increasing provider spend (model, Lusha reveal, web search).

## Secrets and remotes

Never commit or paste credentials, tokens, cookies, service-account JSON, `.env*` contents, or production connection strings. Not in code, tests, fixtures, pull requests, commit messages, or logs. Use the existing safe-log helpers. If you find a secret in the tree or in history, stop and tell Rory. Deleting a file from HEAD does not remove it from history; do not rewrite history yourself.

The tracked ignore rules already exclude `.env*`, `service-account*.json`, and `atelier.db*`. Leave them ignored.

This repo is public. Do not add customer or prospect names, private email addresses, dossier contents, or internal-only deployment notes to files that will be committed.

Push and open pull requests only on `roryatelier/atelier-sales-tool`. Never push to `aina-cmyk/atelier`, and do not add that repository as a remote.

`npm run check:provider-policy` fails if application code, tests, `README.md`, `doc/HANDOVER.md`, `doc/TECHNICAL_HANDOOFF.md`, or `Prompts/` mention the retired model vendor, a retired Claude model id, or the retired production hostname. Do not reintroduce them.

## Definition of done

- The patch does what the pull request says, and does not widen into a drive-by refactor.
- New or changed behaviour has a focused test, or the pull request explains why the change cannot be observed in a test (docs, copy, config comments).
- `npm run verify:ci` passes locally, and the GitHub Actions job `verify` is green.
- No secrets, prospect data, or forbidden provider/deployment references.
- Owned paths and ask-first changes are waiting on Rory, not self-merged.
- You can name the rollback (revert the squash commit). Do not roll back by restoring quarantined sends, removed credentials, or a retired provider.

## Deploys

Vercel builds this application. Production is the project recorded in `config/deployment.json` (`atelier-sales-preview`, alias `atelier-sales-preview.vercel.app`). A merge to `main` is what ships, once that project's Git integration is connected: preview deployments for pull requests, production deployments for `main`.

There is no deploy workflow in this repository and no post-deploy canary workflow yet. Do not deploy with the Vercel CLI, do not change Vercel project settings, and do not add a Vercel token to the agent environment. `vercel.json` only sets function duration and the scheduled-email cron path.
