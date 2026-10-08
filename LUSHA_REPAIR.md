# Critical Lusha repair

The lookup route now searches from page zero with an uncapped company limit, validates supplied domains and returns pagination metadata. Both contact pickers expose Load more and merge by provider ID without clearing revealed addresses. Missing domains require correction; no brandname.com addresses are guessed.

Placeholder people, emails and phones are removed. No-match, configuration, provider credentials, credit failures, rate limits and uncertain reveal outcomes have distinct responses. All lookup responses and provider fetches opt out of caching. Logs do not expose provider payloads or credentials.

Reveal is an explicit action. Requests include the displayed account's expected Google subject, request emails only and disable waterfall. Missing/mismatched owner denies before provider work. Work emails are preferred; private/unknown addresses need explicit selection. Confidence is not converted into a verified badge. Users can enter a known address manually.

Contact state belongs to the parent, not mutable cards. Proceed/Customize require a valid selected address, and navigation writes the updated contact. The composer retains an already revealed address, never automatically reveals on selection, and uses the current To field in send requests and confirmation. Query/account/tab guards discard stale results. Automatic paid retries are disabled.

## Validation

- `npm run test:lusha`: seven mocked adapter/route/merge tests, originally failing against the old route.
- `npm run test:security`: existing ten containment tests.
- `npm run test:lusha:ui`: real browser against an isolated fixture app. Both pickers browse 95 contacts; unrevealed selection does not spend; reveal carries the exact email to the draft; credits failure leaves To unchanged; private selection is explicit; late results cannot overwrite manual To or another tab.
- TypeScript, production build, diff whitespace checking and new-module lint. Existing large-page lint findings remain; this change introduces no additional findings.

Browser setup uses signed synthetic sessions through the real proxy/layout, replaces unrelated fixture APIs/database access, and substitutes the Lusha transport. It copies no environment or credential files and blocks external browser/server fetches. It makes no paid requests or email sends. Install development dependencies and a Playwright Chromium browser (`npx playwright install chromium`); on macOS the test also supports installed Google Chrome. The fixture reserves localhost port 3173.

## Release boundary

This is local implementation evidence, not a production repair confirmation. Publishing is blocked while roryatelier has read-only repository access. Existing security configuration/key-rotation/deployment gates still apply. Before enabling live use, approve a numerical credit budget and designated domain/contact, then verify first/next page and one synchronous email-only reveal with waterfall disabled.

Waterfall-only addresses and background jobs remain unsupported. An unexpected job preserves synchronous work email or displays a pending limitation. There is no durable cross-tab/reload/server-instance/crash deduplication; a deliberate new reveal may charge again. No database migration, shared contact cache, worker or CRM integration is included.
