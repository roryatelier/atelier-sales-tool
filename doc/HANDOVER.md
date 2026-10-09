# Atelier Sales Intelligence Tool — Handover Guide

**Prepared by:** Aina Sekido 
**Date:** June 2026  
**Handover to:** Nick / Atelier team

---

## Quick Reference

| Item | Details |
|------|---------|
| Live URL | https://atelier-sales-preview.vercel.app |
| GitHub | https://github.com/roryatelier/atelier-sales-tool |
| Google Sheets Pipeline | https://docs.google.com/spreadsheets/d/1t2dGrIg9sQYGuqhU38qYcHBRM9XYmk3LFa_k_mA4cd8 |
| Vercel Project | atelier-sales-preview |
| Primary user | Samara (VP of Client Partnerships) |

---

## How to Use the Tool (VP Workflow)

### Step 1 — Research a brand
1. Open https://atelier-sales-preview.vercel.app
2. Sign in with your Google account
3. Type a brand name in the search box and click **Search**
4. Wait ~20 seconds for the research dossier to load
5. Review the ICP score, signals, and score breakdown

### Step 2 — Find contacts
1. On the dossier page click **Find contacts**
2. Browse contacts grouped by department
3. Click **Reveal email** to use a Lusha credit and get the contact's email
4. Click **Select** to choose a contact for outreach

### Step 3 — Generate and send email
1. On the email generator review the pre-generated email
2. Optionally click **Pitch angles by role** to see talking points
3. Click **Use in email** on a bullet point to inject it into the email
4. Edit the subject and body as needed
5. Click **Send email** → review in the confirm modal → click **Confirm send**

### Step 4 — Track in pipeline
1. Go to **Pipeline** in the sidebar
2. Update the status as the lead progresses (Researched → Sent → Replied → Qualified)
3. Add notes inline by clicking the notes cell
4. Use filters to view by status or score band

---

## Daily Workflow Tips

- Check **⏰ Due for follow-up** on the dashboard each morning — these are Sent leads with no reply after 7 days
- Click **Scan industry** to see the latest beauty industry signals
- Click **Match trends** to see which pipeline brands align with current beauty trends
- Click **Scan market** to see global supply chain signals that could be used in outreach
- The **📅 Best time to reach out** banner on the email generator uses live web search to recommend urgency

---

## Adding a New User

An administrator first adds the named user to `APP_ALLOWED_EMAILS` in Preview and Production and redeploys. The new user then:
1. Opens https://atelier-sales-preview.vercel.app
2. Gets redirected to Google OAuth
3. Signs in with their Google account
4. Grants permission to send emails
5. They're in — emails will send from their own Gmail

---

## Managing API Keys

### OpenAI
- Manage at https://platform.openai.com/api-keys
- To rotate: create a replacement key, update Preview and Production, revoke the old key, redeploy and run the provider canary

### Lusha (contacts)
- Manage at https://dashboard.lusha.com
- Current key: in Vercel environment variables as `LUSHA_API_KEY`
- Daily limit: 2000 API calls
- Credits consumed: 1 per email reveal, 5 per phone reveal

### Google OAuth (Gmail)
- Manage at https://console.cloud.google.com
- Project: atelier-sales-tool
- Each user authenticates individually — no shared credentials
- Sessions last 30 days then require re-authentication

### Google Service Account (Sheets)
- Used for reading/writing the pipeline Google Sheet
- Credentials stored as `GOOGLE_SERVICE_ACCOUNT` in Vercel environment variables
- To rotate: create new service account key in Google Cloud Console → update Vercel env var → redeploy
- Make sure the new service account has Editor access to the Google Sheet

---

## Updating Environment Variables on Vercel

1. Go to https://vercel.com
2. Open the atelier-sales-preview project
3. Go to **Settings** → **Environment Variables**
4. Find the variable to update → click **Edit**
5. Paste the new value → click **Save**
6. Go to **Deployments** → click **Redeploy** on the latest deployment

---

## Clearing the Dossier Cache

Cached dossiers are stored in Vercel Postgres. To force a brand to be re-researched:

**Clear a single brand:**
DELETE FROM dossiers WHERE brand_name_normalised = 'brand name here';

**Clear all cached dossiers:**
Visit: `https://atelier-sales-preview.vercel.app/api/clear-cache` with a DELETE request, or connect to the Vercel Postgres database directly via the Vercel dashboard → Storage → your database → Query.

---

## Deploying Updates

Any push to the `main` branch on GitHub automatically triggers a Vercel deployment. To deploy:

```bash
git add .
git commit -m "description of changes"
git push
```

Vercel will build and deploy in ~2 minutes. Check the Vercel dashboard for build status.

---

## Known Issues & Workarounds

| Issue | Workaround |
|-------|-----------|
| Brand scores too low | Clear cache and re-research — old dossiers use outdated scoring |
| No contacts found for a brand | Use the LinkedIn search links on the contacts page |
| Gmail auth expired | Click the re-authenticate banner or go to /api/auth/gmail |
| Email subject has garbled characters | Fixed in latest version — re-send the email |
| Dossier shows insufficient data | Brand may have limited public presence — verify manually |
| Placeholder contacts showing | Fixed in latest version — contacts page filters these out |

---

## What's Not Built Yet

These features were scoped out of the MVP but are recommended for v2:

1. **Automatic reply detection** — connect Gmail read scope to auto-update pipeline when a brand replies
2. **Email sequence generator** — generate a full 3-email sequence in one click
3. **Sales Navigator integration** — requires LinkedIn Team account (contact Peter)
4. **Mobile optimisation** — tool is desktop-only currently
5. **Email open tracking** — add tracking pixel to detect when emails are opened
6. **Bulk status update** — select multiple pipeline leads and update status in one click
7. **Dark mode** — full dark mode toggle

---

## Cost Estimates

| Operation | Estimated Cost |
|-----------|---------------|
| Brand research | ~$0.05–0.10 per brand |
| Email generation | ~$0.01–0.02 per email |
| Pitch angles | ~$0.03–0.06 per brand |
| Industry signals scan | ~$0.02–0.04 per scan |
| Market pulse scan | ~$0.02–0.04 per scan |
| Trend matching | ~$0.02–0.03 per scan |
| Outreach timing | ~$0.01–0.02 per brand |

At moderate usage (10 brands/day, 5 emails/day) estimated monthly cost: **~$15–30 USD** in OpenAI API credits.

Lusha credits are separate — 1 credit per email reveal, 5 per phone reveal.

---

## Contact for Questions

- **Built by:** Aina Sekido (intern, June 2026)
- **GitHub:** https://github.com/roryatelier/atelier-sales-tool
- **For technical questions:** Refer to README.md and docs/PROMPTS.md in the repo
