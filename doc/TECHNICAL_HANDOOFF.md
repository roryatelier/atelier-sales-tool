
---

# Atelier Sales Intelligence Tool — Technical Handoff
**Prepared by:** Aina Sekido
**Date:** June 2026
**Handoff to:** Nick & Jess

---

## Overview

The Atelier Sales Intelligence Tool is a full-stack web application built with Next.js 14 and TypeScript, deployed on Vercel. It automates brand research, ICP scoring, contact finding, and personalised email outreach for Atelier's sales team.

**Live URL:** https://atelier-sales-preview.vercel.app
**GitHub:** https://github.com/roryatelier/atelier-sales-tool
**Google Sheets Pipeline:** https://docs.google.com/spreadsheets/d/1t2dGrIg9sQYGuqhU38qYcHBRM9XYmk3LFa_k_mA4cd8

---

## Step 1 — Get Access to Everything

The designated Atelier administrator grants access to:

- [ ] **GitHub repo** — https://github.com/roryatelier/atelier-sales-tool
- [ ] **Vercel project** — `atelier-sales-preview` in team `rory-ateliercos-projects`
- [ ] **Google Cloud Console** — the project that holds the OAuth credentials and service account
- [ ] **OpenAI Platform** — https://platform.openai.com/api-keys for the API key
- [ ] **Lusha Dashboard** — https://dashboard.lusha.com for the contacts API key
- [ ] **Google Sheets** — make sure Nick and Jess have Editor access to the pipeline sheet

---

## Step 2 — Set Up Locally

To run the tool on your own machine:

**Prerequisites:**
- Install Node.js 18+ from https://nodejs.org
- Install Git from https://git-scm.com
- Install VS Code from https://code.visualstudio.com

**Clone and install:**
```bash
git clone https://github.com/roryatelier/atelier-sales-tool.git
cd atelier
npm install
```

**Create environment file:**
Create a file called `.env.local` in the root of the project and add values from the approved secret stores:

```
OPENAI_API_KEY=
APP_ALLOWED_EMAILS=
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GOOGLE_SHEETS_ID=1t2dGrIg9sQYGuqhU38qYcHBRM9XYmk3LFa_k_mA4cd8
GOOGLE_SERVICE_ACCOUNT=
LUSHA_API_KEY=
JWT_SECRET=
POSTGRES_URL=
PRODUCTION_URL=http://localhost:3000
```

**Run locally:**
```bash
npm run dev
```

Open http://localhost:3000 in your browser.

---

## Step 3 — Understand the Codebase

The project is organised like this:

```
atelier/
├── app/
│   ├── page.tsx          — Dashboard
│   ├── portfolio/        — Brand Search
│   ├── dossier/          — Research Dossier
│   ├── contacts/         — Contacts
│   ├── email/            — Email Generator
│   ├── pipeline/         — Pipeline
│   ├── templates/        — Templates
│   ├── saved/            — Saved Brands
│   ├── api/              — All backend API routes
│   │   ├── research/     — Brand research with Claude
│   │   ├── email/        — Email generation
│   │   ├── send-email/   — Gmail send
│   │   ├── pipeline/     — Google Sheets read
│   │   ├── save-to-sheets/ — Google Sheets write
│   │   ├── lookup-contacts/ — Lusha contacts
│   │   ├── pitch-angle/  — Pitch angle generation
│   │   ├── outreach-timing/ — Best time to reach out
│   │   ├── schedule-email/ — Schedule send save
│   │   └── cron/         — Scheduled send cron job
│   ├── components/
│   │   └── NavItems.tsx  — Sidebar navigation
│   ├── layout.tsx        — App shell and sidebar
│   └── globals.css       — All styling
├── lib/
│   ├── research.ts       — Brand research logic and prompt
│   └── db.ts             — Database setup (Postgres + SQLite)
├── doc/
│   ├── HANDOVER.md       — Full handover guide
│   └── PROMPTS.md        — All AI prompts documented
├── README.md             — Setup instructions
└── vercel.json           — Cron job config
```

---

## Step 4 — How to Make Changes

**For simple changes (labels, colours, text):**
1. Open the file in VS Code
2. Make the change
3. Save with Cmd+S
4. Run `npm run build` to check for errors
5. Run `git add . && git commit -m "description" && git push` to deploy

**For complex changes (new features, bug fixes):**
Use Claude Code — an AI assistant that reads and edits your code directly in the terminal:

```bash
# Install Claude Code (one time only)
sudo npm install -g @openai/codex

# Start Claude Code in your project
cd atelier
claude
```

Then type what you want in plain English:
- "Add a new column to the pipeline table showing the last activity date"
- "Fix the bug where contacts aren't loading for Aesop"
- "Change the dashboard greeting font size to 24px"

Claude Code will read the relevant files, make the changes, and verify they work.

---

## Step 5 — How to Deploy

Every time you push to GitHub, Vercel automatically deploys:

```bash
git add .
git commit -m "describe what you changed"
git push
```

Check the deployment status at https://vercel.com → atelier-sales-preview → Deployments.

Build takes ~2 minutes. If it fails check the build logs in Vercel for the error.

---

## Step 6 — Managing API Keys

All API keys are stored in Vercel environment variables. To update them:

1. Go to https://vercel.com → atelier-sales-preview → Settings → Environment Variables
2. Add the replacement to Preview and Production without exposing it in chat or Git
3. Revoke the old credential, deploy both targets and run their canaries

**Key rotation schedule:**
- OpenAI API key — rotate after exposure and on the company rotation schedule
- Lusha API key — rotate if compromised
- Gmail OAuth — users re-authenticate via `/api/auth/gmail` if session expires
- Google Service Account — rotate if compromised via Google Cloud Console

---

## Step 7 — Adding New Users

Only approved users can sign in. Add their email to `APP_ALLOWED_EMAILS` in Preview and Production, redeploy, then:
1. Open https://atelier-sales-preview.vercel.app
2. Sign in with their Google account
3. Grant Gmail permission
4. They're ready to use the tool

To ensure their Google account works, add their email as a test user in Google Cloud Console → APIs & Services → OAuth consent screen → Test users.

---

## Step 8 — Common Issues and Fixes

| Issue | Fix |
|-------|-----|
| Gmail auth required banner | Go to /api/auth/gmail and re-authenticate |
| Pipeline not loading | Check GOOGLE_SHEETS_ID in Vercel env vars |
| Contacts not showing | Check LUSHA_API_KEY in Vercel env vars |
| Emails not generating | Check OPENAI_API_KEY in Vercel env vars and run the provider canary |
| Scheduled sends not firing | Check Vercel → Settings → Crons, verify CRON_SECRET is set |
| Build failing | Run npm run build locally and fix the error shown |
| Brand scores seem wrong | Clear dossier cache — delete from dossiers table in Vercel Postgres |

---

## Step 9 — Costs to Monitor

| Service | Cost | Monitor at |
|---------|------|------------|
| OpenAI | ~$0.02-0.10 per action | platform.openai.com |
| Lusha (contacts) | 1 credit per email reveal | dashboard.lusha.com |
| Vercel (hosting) | Pro plan ~$20/month | vercel.com |
| Vercel Postgres | Included in Pro | vercel.com |

---

## Step 10 — Where to Get Help

- **Documentation:** `doc/HANDOVER.md` and `doc/PROMPTS.md` in the GitHub repo
- **README:** Full setup guide at the root of the repo
- **Claude Code:** For any code changes — type what you want in plain English
- **This chat:** For questions about the tool's architecture and design decisions

---
