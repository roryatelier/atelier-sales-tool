# Email Prompt Template
**Atelier AI Sales Intelligence Tool**
Version 1.0 — June 2026
Sprint 2 Blocker — Version-control before Sprint 2 begins.

---

## Usage

Inject into `/api/email` backend route. Replace all `{{PLACEHOLDERS}}` at call time from the stored dossier and VP's role selection.
This prompt is supplied to the shared OpenAI Responses API client for Workflow 2, Step 2.
Model: `OPENAI_EMAIL_MODEL`, then `OPENAI_MODEL`, default `gpt-5-mini`

Trust gate check runs **server-side after OpenAI returns** — it is not part of this prompt.

---

## Inputs (injected at call time)

| Placeholder | Source |
|---|---|
| `{{BRAND_NAME}}` | `dossier.brand_name` |
| `{{CONTACT_NAME}}` | Lusha enrichment |
| `{{CONTACT_ROLE}}` | VP's dropdown selection (CFO / COO / CMO / CEO) |
| `{{REVENUE_ESTIMATE}}` | `dossier.revenue_estimate` |
| `{{RETAILERS}}` | `dossier.retailers[]` joined as a readable list |
| `{{KEY_SIGNALS}}` | `dossier.signals[]` — top 2–3 most relevant, formatted as bullet points |
| `{{ROLE_MESSAGE_FOCUS}}` | Injected from message matrix below — one sentence |
| `{{ROLE_PROOF_POINTS}}` | Injected from message matrix below — comma-separated |

---

## Message Matrix (embed in backend — not UI only)

This matrix must be embedded in the prompt construction logic in `/api/email`. The backend selects the correct row based on the VP's role selection and injects it into `{{ROLE_MESSAGE_FOCUS}}` and `{{ROLE_PROOF_POINTS}}`.

| Role | Message Focus | Key Proof Points |
|---|---|---|
| CFO | Operating margin uplift and cost efficiency of outsourced manufacturing | Revenue scale, capital deployed in product development |
| COO | Capacity without headcount and operational scale | SKU complexity, portfolio breadth, growth trajectory |
| CMO | Speed to market — moving at the speed of culture | Launch cadence, category trends, competitive context |
| CEO | More products to market faster and topline revenue growth | Funding, retail expansion, acquisition activity |

---

## Prompt

```
You are writing a cold outreach email on behalf of Atelier, an ANZ contract manufacturer serving beauty, health, and wellness brands. Atelier helps brands get more products to market faster by providing outsourced manufacturing capacity — removing the need to invest in plant, equipment, or specialist headcount.

Write a short, direct, personalised cold outreach email to a senior executive at a brand Atelier is considering approaching.

---

RECIPIENT

Name: {{CONTACT_NAME}}
Role: {{CONTACT_ROLE}}
Brand: {{BRAND_NAME}}
Revenue (estimated): {{REVENUE_ESTIMATE}}
Retail presence: {{RETAILERS}}

---

BRAND SIGNALS (use these to personalise — reference at least two in the email body)

{{KEY_SIGNALS}}

---

ROLE-SPECIFIC MESSAGE FOCUS

This executive's primary concern is: {{ROLE_MESSAGE_FOCUS}}

Anchor the email to this focus. The most relevant proof points for this role are: {{ROLE_PROOF_POINTS}}.

---

EMAIL GUIDELINES

Tone: direct, peer-to-peer, confident but not pushy. This is a first contact — not a pitch deck. Write as if you are a senior person reaching out to another senior person.

Length: 4–6 sentences maximum. No long paragraphs. No bullet points in the email body.

Structure:
1. One opening sentence that references something specific and real about {{BRAND_NAME}} — use the signals above. Do not open with "I hope this finds you well" or any generic opener.
2. One or two sentences that connect that signal to the role's primary concern ({{ROLE_MESSAGE_FOCUS}}).
3. One sentence positioning Atelier as the solution — keep it factual, not salesy.
4. One clear, low-friction call to action — a 15-minute call, not a demo or a proposal.

Signature: sign off as "The Atelier team" — do not invent a sender name.

Subject line: short and specific. Reference the brand or the signal. No "Reaching out" or "Quick question" subject lines.

---

OUTPUT FORMAT

Return valid JSON only. No preamble, no explanation, no markdown fences. The response must begin with { and end with }.

Required schema:

{
  "subject": "string",
  "body": "string"
}

The "body" field must be plain text. No HTML, no markdown. Line breaks between paragraphs are fine.
```

---

## Trust Gate (server-side, post-generation)

The backend runs this check **after** Claude returns and **before** the email is sent to the frontend.

A brand-specific fact is defined as: a string that matches a value in `dossier.retailers[]`, `dossier.signals[]`, `dossier.revenue_estimate`, or `dossier.brand_name` appearing in a meaningful context (not just as the salutation).

Check: substring match of email body against these dossier fields.

- **Gate pass**: at least 2 brand-specific facts found → email returned to frontend for VP review.
- **Gate fail**: fewer than 2 brand-specific facts → return `{ "warning": "Insufficient brand data to personalise — verify research and retry." }`. Email body is not returned. VP sees warning and decides whether to add a specific angle manually or write from scratch.

---

## Version History

| Version | Date | Change |
|---------|------|--------|
| 1.0 | June 2026 | Initial version |
