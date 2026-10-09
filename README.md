# Atelier Sales Intelligence Tool

## What It Does

The Atelier Sales Intelligence Tool is an AI-powered B2B outreach platform built for Atelier's VP of Client Partnerships. It automates brand research, ICP scoring, contact finding, and personalised email generation for prestige beauty brands across ANZ and the US. The tool researches any brand using live web search, scores it against Atelier's Ideal Customer Profile, surfaces buying signals, finds decision-maker contacts via Lusha, generates personalised cold outreach emails, and tracks all activity in a Google Sheets pipeline.

---

## Tech Stack

- **Framework:** Next.js 14 (App Router, TypeScript)
- **AI:** OpenAI Responses API with web search
- **Database:** Vercel Postgres (production), SQLite via better-sqlite3 (local)
- **Auth:** Google OAuth2 (Gmail send scope + userinfo)
- **Integrations:** Lusha API v3 (contacts), Google Sheets API v4 (pipeline), Gmail API (send)
- **Deployment:** Vercel project `atelier-sales-preview`; releases must pass CI, Preview smoke tests and production canaries
- **Session:** JWT via jose library

---

## Prerequisites

- Node.js 18+
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
cd atelier
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set up environment variables
Create a `.env.local` file in the root:

OPENAI_API_KEY=your_openai_api_key

APP_ALLOWED_EMAILS=samara@atelier.co,ella@atelier.co,peter@atelier.co

GMAIL_CLIENT_ID=your_google_oauth_client_id

GMAIL_CLIENT_SECRET=your_google_oauth_client_secret

GOOGLE_SHEETS_ID=1t2dGrIg9sQYGuqhU38qYcHBRM9XYmk3LFa_k_mA4cd8

GOOGLE_SERVICE_ACCOUNT={"type":"service_account","project_id":"..."}

LUSHA_API_KEY=your_lusha_api_key

JWT_SECRET=any_random_secret_string

POSTGRES_URL=your_isolated_database_url

PRODUCTION_URL=http://localhost:3000

> Note: `GOOGLE_SERVICE_ACCOUNT` is the full JSON content of the service account key file as a single line string.

### 4. Run the development server
```bash
npm run dev
```

Open http://localhost:3000. You will be redirected to Google OAuth on first load.

---

## Deploying to Vercel

### 1. Push to GitHub
```bash
git add .
git commit -m "your message"
git push
```

### 2. Connect to Vercel
- Go to https://vercel.com
- Import the GitHub repo
- Vercel auto-detects Next.js

### 3. Add environment variables
In Vercel project settings → Environment Variables, add all variables from `.env.local` above.

### 4. Add Vercel Postgres
- In Vercel dashboard → Storage → Create Postgres database
- Vercel auto-adds `POSTGRES_URL` to environment variables

### 5. Update OAuth redirect URI
In Google Cloud Console → OAuth2 credentials → Add authorised redirect URI:
https://your-vercel-url.vercel.app/api/auth/callback

### 6. Deploy
Production releases use the identity in `config/deployment.json` and must pass `npm run verify:release`, an isolated Preview smoke test and the production canary.

---

## API Endpoint Reference

### POST /api/research
Researches a brand using Claude + web search and returns an ICP dossier.

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
{ "success": true }
```

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

- **Sheet ID:** `1t2dGrIg9sQYGuqhU38qYcHBRM9XYmk3LFa_k_mA4cd8`
- **Tab name:** `Sheet1`
- **Column layout (A–P):**

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
| `JWT_SECRET` | Secret for signing session cookies | Any random string (min 32 chars) |
| `PRODUCTION_URL` | Live Vercel URL | Vercel dashboard |
| `POSTGRES_URL` | Vercel Postgres connection string | Auto-added by Vercel |

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
- Google Sheets pipeline sync
- Follow-up reminders for Sent leads 7+ days old
- Industry signals, market pulse, trend matching
- Outreach timing recommendations with web search
- Celebrity and influencer brand signal detection

### Known issues
- **Malformed JSON on obscure brands:** Claude occasionally returns malformed JSON for brands with very limited public data. The tool catches this and returns a `data_quality: insufficient` flag
- **Lusha placeholder contacts:** Brands with no Lusha coverage return placeholder contacts — these are filtered from the UI but Lusha credits are still consumed on the lookup
- **Cached dossiers:** Old dossiers cached in Vercel Postgres won't have the `competitors` field or updated ICP scoring — clear cache via `/api/clear-cache` after major prompt updates
- **SavedCount badge:** The sidebar saved brands count only updates on full page refresh
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
- Timezone-aware send time recommendations

---

## Handover Checklist

- [ ] **Live URL:** https://atelier-sales-preview.vercel.app
- [ ] **GitHub repo:** https://github.com/roryatelier/atelier-sales-tool
- [ ] **Google Sheets pipeline:** https://docs.google.com/spreadsheets/d/1t2dGrIg9sQYGuqhU38qYcHBRM9XYmk3LFa_k_mA4cd8
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
- **Claude returns malformed JSON:** Caught by regex JSON extractor, returns `data_quality: insufficient`
- **Lusha returns no contacts:** Returns placeholder contacts, filtered from UI, empty state shown with LinkedIn links
- **Gmail OAuth expired:** API returns `reauth: true`, UI shows re-authenticate banner
- **Google Sheets API error:** Logged server-side, UI shows save failed message
- **Brand not found:** Claude web search returns limited data, `data_quality: insufficient` warning shown on dossier
