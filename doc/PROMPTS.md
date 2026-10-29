# Prompt Documentation

This file documents the final working prompts used in the Atelier Sales Intelligence Tool. These prompts are the core of the product — changes should be made carefully and tested thoroughly.

All AI calls go through the shared OpenAI modules (`lib/openai.ts`, `lib/openai-email.ts`, `lib/openai-research.ts`) using the Responses API. Model choice and configuration live in those modules, not in the prompts.

---

## 1. Brand Research Prompt

**File:** `lib/research.ts` → `buildResearchPrompt()`

**Purpose:** Researches a brand using web search and returns a structured JSON dossier with ICP scoring.

**Key design decisions:**
- Uses web search tool with max 5 uses to find current data
- Explicitly calls out prestige retailers to look for (Mecca, Sephora, David Jones etc)
- Scoring rubric is embedded in the prompt to guide the model's scoring
- Requires JSON output only — no preamble or markdown
- Caps are enforced server-side in `researchBrand()` to prevent model over-scoring
- `competitors` field added to support competitor signal detection
- Celebrity/influencer founder detection added as a signal type

**What was changed from the original:**
- Added `score_explanations` field so the VP can see why each criterion was scored
- Added `competitors` array for competitor signal detection
- Broadened retail distribution to include global prestige retailers not just ANZ
- Changed market presence from AU+NZ minimum to US+AU focus
- Added celebrity/influencer brand detection

---

## 2. Email Generation Prompt

**File:** `app/api/email/route.ts` → `buildEmailPrompt()`

**Purpose:** Generates a personalised cold outreach email for a specific role at a target brand.

**Key design decisions:**
- 3-paragraph structure enforced (signal → relevance → CTA)
- 100 word cap to keep emails concise and readable
- Opens with a buying signal not company stats
- Role-specific message matrix (CEO vs CMO vs Head of NPD have different focuses)
- Trust gate checks brand name appears in email body
- Supports template personalisation — uses saved template as style guide
- Supports `pitch_bullet` injection — weaves a specific talking point into the email
- Supports `follow_up` context — references original email and offers new angle
- Addresses recipient by first name

**What was changed from the original:**
- Removed formal address by last name — changed to first name for warmer tone
- Added pitch_bullet injection for targeted talking points
- Added follow_up context for follow-up email generation
- Added PRIORITY TALKING POINT instruction when pitch bullet is provided

**MESSAGE MATRIX (role → focus):**

| Role | Focus | Proof Points |
|------|-------|--------------|
| CEO | More products to market faster, topline growth | Funding, retail expansion, acquisition |
| CFO | Operating margin, cost efficiency | Revenue scale, capital in product dev |
| COO | Capacity without headcount | SKU complexity, portfolio breadth |
| CMO | Speed to market, trend responsiveness | Launch cadence, category trends |
| VP Product | Scaling NPD without in-house manufacturing | SKU complexity, NPD pipeline |
| VP Operations | Operational efficiency, supply chain | Manufacturing capacity, lead times |
| Head of NPD | Formulation capabilities, faster to market | Formulation depth, SKU complexity |
| Head of Marketing | Campaign-led launches, speed to market | Launch cadence, retail expansion |

---

## 3. Pitch Angle Prompt

**File:** `app/api/pitch-angle/route.ts`

**Purpose:** Generates 3 specific talking points per stakeholder role, dynamically selected based on brand signals.

**Key design decisions:**
- Roles are selected dynamically based on signal types (not hardcoded)
- `selectRoles()` function scores each possible role based on signal types
- Returns top 3 roles + recommended role with highest score
- Each role gets 3 bullet points tailored to that role's concerns
- 3 parallel API calls (one per role) for speed

**Signal → role mapping:**
- `npd_launch`, `launch` → Head of NPD, VP Product
- `acquisition`, `investment`, `funding` → CEO, CFO
- `retail_expansion`, `retail_distribution` → CMO, Head of Marketing
- `hiring`, `vp_field_sales_hiring` → COO, VP Operations
- `partnership` → CMO, CEO

---

## 4. Industry Signals Prompt

**File:** `app/api/competitor-signals/route.ts`

**Purpose:** Scans for recent news from the prestige beauty, health and wellness industry.

**Key design decisions:**
- Uses web search with max 4 uses
- Explicitly includes celebrity/influencer brand launches as a category
- Returns 6-8 signals per scan
- Each signal includes `why_it_matters` — a one sentence Atelier-specific outreach angle
- Signal types: funding, launch, retail, leadership, expansion, trend, celebrity

---

## 5. Market Pulse Prompt

**File:** `app/api/market-pulse/route.ts`

**Purpose:** Scans for global supply chain and trade signals affecting beauty manufacturing.

**Key design decisions:**
- Focuses on manufacturing-relevant signals (tariffs, shipping, raw materials, regulation)
- Each signal includes an `outreach_angle` — how Atelier can use this in outreach
- Urgency levels: high, medium, low
- Positions Atelier's local ANZ manufacturing as an advantage against global disruptions

---

## 6. Trend Matching Prompt

**File:** `app/api/trend-matching/route.ts`

**Purpose:** Matches current beauty trends against pipeline and saved brands.

**Key design decisions:**
- Uses web search to find current trending beauty categories
- Matches trends against brand names, categories, and key signals
- Returns momentum level: rising, peak, established
- Each match includes a specific `outreach_angle` for Atelier

---

## 7. Outreach Timing Prompt

**File:** `app/api/outreach-timing/route.ts`

**Purpose:** Recommends the best day and urgency level to reach out to a specific brand.

**Key design decisions:**
- Combines rule-based logic (day of week) with web search for brand-specific news
- Day recommendation: Tuesday–Thursday are optimal B2B outreach days
- Urgency based on: recent news (last 14 days) + signal strength + days since last contact
- Returns `within_hours` for high urgency signals (48h or 72h window)
- Does NOT factor in timezone (intentional — adds complexity without guaranteed accuracy)

---

## Prompt Iteration Notes

### What we learned
1. **JSON output is fragile** — the model needs explicit instructions to return JSON only with no preamble. The `jsonMatch` regex extractor is a safety net for when the model adds markdown fences.
2. **Trust gate is essential** — without it the model occasionally generates emails that don't mention the brand at all, especially for obscure brands with limited data.
3. **Role-specific prompts outperform generic ones** — a CMO-specific prompt produces significantly better emails than a generic "decision maker" prompt.
4. **Signal-first opening matters** — emails that open with a specific buying signal (not "I came across your brand") get much better results.
5. **Word caps need enforcement** — models ignore soft word count suggestions. The 100 word cap is enforced by the prompt structure (3 paragraphs with specific sentence counts per paragraph).
6. **Score caps must be server-side** — the model will over-score if not constrained. The `maxScores` cap in `researchBrand()` is essential.
