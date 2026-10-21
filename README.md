# Atelier Sales Intelligence Tool

Agents working in this repository should read [AGENTS.md](AGENTS.md) and the backlog in [doc/ROADMAP.md](doc/ROADMAP.md) before changing code.

## What It Does

The Atelier Sales Intelligence Tool is an AI-powered B2B outreach platform built for Atelier's VP of Client Partnerships. It automates brand research, ICP scoring, contact finding, and personalised email generation for prestige beauty brands across ANZ and the US. The tool researches any brand using live web search, scores it against Atelier's Ideal Customer Profile, surfaces buying signals, finds decision-maker contacts via Lusha, generates personalised cold outreach emails, and tracks all activity in a Google Sheets pipeline.

---

## Tech Stack

- **Framework:** Next.js 16.2.9 (App Router, TypeScript), React 19, Tailwind 4
- **AI:** OpenAI Responses API with web search, through the shared modules in `lib/openai*.ts`
- **Database:** Neon/Vercel Postgres when `POSTGRES_URL` is set; SQLite via better-sqlite3 locally. On Vercel, a missing Postgres URL fails closed.
- **Auth:** Google OAuth2 (Gmail send scope + userinfo), exact named-user allowlist
- **Integrations:** Lusha API v3 (contacts), Google Sheets API v4 (pipeline), Gmail API (send)
- **Deployment:** Vercel project `atelier-sales-preview` (see `config/deployment.json`). Production ships when Vercel builds `main`. CI job `verify` runs `npm run verify:ci`.
- **Session:** versioned JWT via the jose library

---

## Prerequisites

- Node.js 20.9+ (CI uses Node.js 20)
- npm 9+
- OpenAI API key
- Google Cloud project with OAuth2 credentials and a service account
- Lusha API key
- A Google Sheet set up as the pipeline

---

## Running Locally

### 1. Clone the repo
```bash
git clone https://github.com/roryatelier/atelier-sales-tool.git
cd atelier-sales-tool
```

### 2. Install dependencies
```bash
npm ci
```

### 3. Set up environment variables
Create a `.env.local` file in the root:

OPENAI_API_KEY=your_openai_api_key

APP_ALLOWED_EMAILS=user@example.com

GMAIL_CLIENT_ID=your_google_oauth_client_id

GMAIL_CLIENT_SECRET=your_google_oauth_client_secret

GOOGLE_SHEETS_ID=your_spreadsheet_id

GOOGLE_SERVICE_ACCOUNT={"type":"service_account","project_id":"..."}

LUSHA_API_KEY=your_lusha_api_key

JWT_SECRET=replace-with-a-random-string-of-at-least-32-characters

POSTGRES_URL=your_isolated_database_url

PRODUCTION_URL=http://localhost:3000

> Note: `GOOGLE_SERVICE_ACCOUNT` is the full JSON content of the service account key file as a single line string. `JWT_SECRET` must be at least 32 characters. Local development may set `PRODUCTION_URL` to `http://localhost:3000`. `npm run verify:release` requires that value to be `https` when it is set, because that command checks the deployment environment contract.

### 4. Run the development server
```bash
npm run dev
```

Open http://localhost:3000. You will be redirected to Google OAuth on first load.

---

## Deploying

Production deploys when Vercel builds `main` for the project in `config/deployment.json` (`atelier-sales-preview`, alias `https://atelier-sales-preview.vercel.app`). Pull requests get Preview deployments only after that project's Git integration is connected. This repository does not deploy itself, and a push does not deploy until that integration is in place.

The canonical project is the one named in `config/deployment.json`. Do not point releases at any other Vercel project.

On a machine already linked to that project, the local release gate is:

```bash
npm run verify:release
```

That runs `verify:ci`, checks the environment against `config/env.schema.json`, and refuses to continue when `.vercel/project.json` does not match `config/deployment.json`. CI itself runs `verify:ci` only.

Environment variables for Preview and Production are set in the Vercel project, not in git. Postgres is the production database. The OAuth client needs this authorised redirect URI:

`https://atelier-sales-preview.vercel.app/api/auth/callback`

There is no post-deploy canary workflow in the repo yet. See [doc/ROADMAP.md](doc/ROADMAP.md).

---

## API Endpoint Reference

### POST /api/research
Researches a brand using the OpenAI Responses API with web search and returns an ICP dossier.

**Request:**
```json
{ "brand_name": "Rhode" }
```

**Response:**
```json
{
  "success": true,
  "dossier": {
    "brand_name": "Rhode",
    "website": "https://rhodeskin.com",
    "revenue_estimate": "AUD $150M+",
    "icp_score": 84,
    "score_band": "Hot",
    "retailers": [{"name": "Sephora", "confidence": "high"}],
    "signals": [{"type": "npd_launch", "description": "...", "source": "..."}],
    "competitors": ["Glossier", "Summer Fridays"],
    "score_breakdown": {
      "annual_revenue": 28,
      "retail_distribution": 20,
      "market_presence": 10,
      "product_category": 15,
      "order_viability": 11
    },
    "score_explanations": { "annual_revenue": "..." },
    "score_band": "Hot",
    "data_quality": "sufficient"
  }
}
```

---

### POST /api/email
Generates a personalised cold outreach email based on the dossier.

**Request:**
```json
{
  "dossier": { "..." },
  "role": "CMO",
  "contact_name": "Jane Smith",
  "template": { "subject": "...", "body": "..." },
  "pitch_bullet": "Optional talking point to weave in",
  "follow_up": { "original_subject": "...", "date_sent": "17/06/2026" }
}
```

**Response:**
```json
{
  "success": true,
  "email": {
    "subject": "Rhode's Peptide push — a word on speed to market",
    "body": "Jane, ..."
  }
}
```

---

### POST /api/send-email
Sends the email via the authenticated user's Gmail account.

**Request:**
```json
{
  "request_id": "b9ce8719-df35-44e6-8568-95b640bedb14",
  "expectedGoogleSub": "signed-in-google-subject",
  "to": "jane@brand.com",
  "cc": "optional@cc.com",
  "bcc": "optional@bcc.com",
  "subject": "...",
  "emailBody": "...",
  "contactName": "Jane Smith",
  "role": "CMO",
  "leadSource": "Outbound",
  "dossier": { "..." }
}
```

**Response:**
```json
{ "success": true, "outcome": "accepted", "message_id": "gmail-message-id", "pipeline_synced": true }
```

The composer saves one UUID with the confirmed recipient, content, and attachments before sending. Retrying that same confirmation reuses the UUID and returns the recorded outcome without sending again. Reusing it with changed content returns `409`. Gmail acceptance requires a message ID; it does not prove inbox delivery. An uncertain outcome instructs the user to check Sent mail and is never automatically resent. Browser storage failure prevents a new send attempt.

An accepted replay may not know whether the original Sheets sync completed. Check the pipeline separately; resending the email is not a sync retry. Closing a draft or clearing browser storage discards its local confirmation history. A newly created draft is a new confirmation.

---

### POST /api/save-to-sheets
Saves a lead to the Google Sheets pipeline.

**Request:**
```json
{
  "brand_name": "Rhode",
  "website": "https://rhodeskin.com",
  "lead_source": "Outbound",
  "revenue_estimate": "AUD $150M+",
  "retailers": [{"name": "Sephora"}],
  "category": "Skincare",
  "icp_score": 84,
  "score_band": "Hot",
  "signals": ["..."],
  "status": "Researched"
}
```

**Response:**
```json
{ "success": true }
```

---

## Google Sheets Integration

- **Sheet ID:** the `GOOGLE_SHEETS_ID` environment variable. It is not stored in the repository.
- **Tab name:** `Sheet1`
- **Column layout (A–Q), as written by `lib/sheets.ts`:**

| Col | Field |
|-----|-------|
| A | Brand Name |
| B | Website |
| C | Lead Source |
| D | Revenue Estimate |
| E | Retailers |
| F | Category |
| G | ICP Score |
| H | Score Band |
| I | Key Signals |
| J | Target Role |
| K | Contact Name |
| L | Email Subject |
| M | Email Body |
| N | Date Added |
| O | Status |
| P | Notes |
| Q | Sent by |

- **Service account:** Must have Editor access to the sheet. Share the sheet with the service account email found in the JSON credentials file.
- **Auth:** The `GOOGLE_SERVICE_ACCOUNT` env var contains the full service account JSON as a string.

---

## Environment Variables Reference

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `OPENAI_API_KEY` | OpenAI project API key | https://platform.openai.com/api-keys |
| `APP_ALLOWED_EMAILS` | Comma-separated named users allowed to sign in | Atelier administrator |
| `GMAIL_CLIENT_ID` | Google OAuth client ID | Google Cloud Console → OAuth2 credentials |
| `GMAIL_CLIENT_SECRET` | Google OAuth client secret | Google Cloud Console → OAuth2 credentials |
| `GOOGLE_SHEETS_ID` | Pipeline spreadsheet ID | From the Google Sheets URL |
| `GOOGLE_SERVICE_ACCOUNT` | Full service account JSON string | Google Cloud Console → Service Accounts |
| `LUSHA_API_KEY` | Lusha contact enrichment key | https://dashboard.lusha.com |
| `JWT_SECRET` | Secret for signing session cookies | A new random string (min 32 chars). Rotation signs everyone out. |
| `CRON_SECRET` | Bearer token for `/api/cron/send-scheduled-emails` | A new random string, distinct per environment. Optional in the schema; the cron route rejects calls without it. |
| `PRODUCTION_URL` | Base URL used to build the OAuth callback | The deployment origin, for example `https://atelier-sales-preview.vercel.app` |
| `POSTGRES_URL` | Postgres connection string | The database connected to that Vercel environment |

> **Important:** Never commit `.env.local` to GitHub. It is already in `.gitignore`.

---

## ICP Scoring Criteria

Brands are scored out of 100 across 5 criteria:

| Criterion | Max | Description |
|-----------|-----|-------------|
| Annual Revenue | 35 | $200M+ = 35, $100–199M = 28, $50–99M = 21, $20–49M = 10 |
| Retail Distribution | 20 | 3+ prestige retailers globally = 20, 2 = 14, 1 = 7, DTC only = 0 |
| Order Viability | 20 | Store count (8) + funding signals (7) + NPD/launches (5) |
| Product Category | 15 | Skincare/haircare/colour/body = 15, wellness/fragrance = 10 |
| Market Presence | 10 | US + AU = 10, one + others = 7, one only = 4 |

**Score bands:** 80–100 = Hot, 60–79 = Warm, 40–59 = Watch, 0–39 = Pass

---

## Known Limitations & Open Items

### What works well
- Brand research with live web search and ICP scoring
- Gmail OAuth with per-user sending
- Lusha contact enrichment with on-demand reveal
- Google Sheets append after an immediate send, with `pipeline_synced` on the send response
- Follow-up reminders for Sent leads 7+ days old
- Industry signals, market pulse, trend matching
- Outreach timing recommendations with web search
- Celebrity and influencer brand signal detection

### Known issues
- **Cached dossiers:** Dossiers already stored in Postgres keep the JSON written at research time. Re-research a brand after scoring or prompt changes rather than assuming old rows gained new fields.
- **Saved-brands badge:** The sidebar count refreshes when the route changes. An in-page save does not update it until the next navigation.
- **Scheduled pipeline sync:** A scheduled send can be accepted by Gmail and still fail to append the Sheets row. The job stays `sent`. See [doc/ROADMAP.md](doc/ROADMAP.md).
- **Gmail OAuth re-auth:** Sessions expire after 30 days — users need to re-authenticate via `/api/auth/gmail`
- **Industry signals API cost:** Auto-loads on every dashboard open — consider caching results daily to reduce API costs

### Not built yet
- Automatic reply detection (requires Gmail read scope)
- Email open tracking
- Sales Navigator API integration (requires LinkedIn Team account)
- Mobile optimisation
- Dark mode
- Bulk pipeline status update
- Email sequence generator (3-email sequence in one click)

---

## Handover Checklist

- [ ] **Live URL:** https://atelier-sales-preview.vercel.app
- [ ] **GitHub repo:** https://github.com/roryatelier/atelier-sales-tool
- [ ] **Google Sheets pipeline:** the spreadsheet in `GOOGLE_SHEETS_ID`, shared with the service account as an editor
- [ ] **Vercel project:** `atelier-sales-preview` (`prj_SYLwZGYtiQQryVAMB5n0aAUALEnj`)
- [ ] **Service account credentials:** Held and rotated by a designated Atelier administrator
- [ ] **OpenAI API key:** In Vercel environment variables — rotate via https://platform.openai.com/api-keys
- [ ] **Lusha API key:** In Vercel environment variables — manage via https://dashboard.lusha.com
- [ ] **Gmail OAuth:** Each user authenticates with their own Google account on first login
- [ ] **Adding a new user:** Add the user to `APP_ALLOWED_EMAILS`, update Preview and Production, redeploy, then have them sign in with Google
- [ ] **Rotating API keys:** Replace in both Preview and Production, revoke the old key, redeploy each target and run its canary

---

## Architecture Overview
User (browser)

↓

Next.js App Router (Vercel)

↓

API Routes (/api/*)

↓

┌─────────────────────────────────────┐

│  OpenAI Responses API             │

│  - Web search tool (5 uses max)     │

│  - Brand research                   │

│  - Email generation                 │

│  - Pitch angles                     │

│  - Industry signals                 │

│  - Market pulse                     │

│  - Trend matching                   │

│  - Outreach timing                  │

└─────────────────────────────────────┘

↓

┌─────────────────────────────────────┐

│  Lusha API v3                       │

│  - Contact prospecting by domain    │

│  - On-demand email/phone reveal     │

└─────────────────────────────────────┘

↓

┌─────────────────────────────────────┐

│  Google APIs                        │

│  - Sheets API (pipeline sync)       │

│  - Gmail API (send emails)          │

│  - OAuth2 (user authentication)     │

└─────────────────────────────────────┘

↓

┌─────────────────────────────────────┐

│  Database                           │

│  - Vercel Postgres (production)     │

│  - SQLite / better-sqlite3 (local)  │

│  Tables: dossiers, usage_log,       │

│  saved_suggestions, templates,      │

│  contact_history                    │

└─────────────────────────────────────┘

### Error flows
- **Research cannot support a dossier:** The structured response sets `data_quality: insufficient`
- **Lusha returns no contacts:** Empty status, no fabricated people. The UI shows an empty state.
- **Gmail OAuth expired:** API returns `reauth: true`, UI shows a re-authenticate banner
- **Google Sheets API error:** Immediate send reports whether the pipeline append succeeded. Scheduled send records Gmail acceptance even if the Sheets append fails; that sync gap is still open (`doc/ROADMAP.md`).
- **Brand not found:** Limited public data comes back as `data_quality: insufficient` on the dossier
