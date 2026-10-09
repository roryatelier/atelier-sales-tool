# Copilot code review instructions

- Treat authentication, authorization, credential handling, and external-provider failures as release-critical. Flag secrets, private keys, tokens, or complete credentials added to tracked files.
- Require every non-public API route to enforce the named-user authentication policy. Check both the happy path and unauthorized access.
- Keep AI requests behind the shared OpenAI provider modules. Flag direct provider calls, retired provider references, and errors that conceal a provider failure from the user.
- For email and pipeline changes, verify durable state transitions, explicit failure states, and idempotent retries. A scheduled or accepted state must not be presented as successful delivery.
- For Lusha and brand research changes, require pagination and partial-result behavior to be covered, and preserve truthful warnings when enrichment is incomplete.
- Expect focused regression coverage for changed behavior and a passing `npm run verify:ci` before merge.
