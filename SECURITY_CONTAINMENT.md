# Security containment release checklist

This branch hardens application access and quarantines the legacy scheduler. It does not revoke external credentials or implement the functional repair plan.

## Required configuration

- `APP_ALLOWED_EMAILS`: comma-separated exact verified Google email addresses approved by the operator. There is no domain-wide admission. Without this value the application fails closed.
- `JWT_SECRET`: a newly generated secret with at least 32 bytes. Rotation invalidates previous application sessions and encrypted Gmail cookies. Do not reuse the exposed/chat-supplied password.
- `CRON_SECRET`: a newly generated service secret. The authenticated cron route deliberately returns 503 while scheduling is paused.
- Existing Gmail OAuth configuration and approved callback URL remain necessary for named users to reconnect.
- Vercel requires the production Postgres configuration; missing configuration must not fall back to SQLite.
- Replace the exposed Google service-account credential through the administrator's secure secret workflow, after revoking the old key in IAM. Never commit credentials.

Do not copy production credentials/stores into previews. Sensitive environment values shown blank by tooling do not establish their absence.

## Behavior changes

All application APIs authenticate before contacting providers. Cookie-authenticated mutations require an exact matching Origin. OAuth start/callback have state validation; the exact cron endpoint uses service authorization. Legacy JWTs and token cookies are rejected. Gmail credentials and confirmed sender identity must match the admitted Google account.

Legacy browser drafts have no reliable owner and are cleared. New browser state is scoped to the current Google subject; other open tabs stop accessing state on account changes. The composer rejects a delayed identity lookup that differs from the identity which unlocked its draft.

Scheduling is paused in the composer and dashboard. Existing jobs remain preserved and quarantined; they cannot be sent, listed as trustworthy user-owned jobs, or deleted through the legacy scheduling endpoint. Resume only after verified ownership migration and a durable send lifecycle; do not redeploy the previous worker.

Sheets writes inside sending now use a server-only helper. Existing functional limitations, including non-durable sync failure handling and absence of reliable send idempotency, remain for the subsequent repair phases.

The credential and SQLite files are removed from the tracked tree and excluded from deployment. Ignored local originals may remain for controlled operator recovery. Deleting HEAD does not purge Git history or revoke the exposed key. Preserve required data in restricted storage before any cleanup.

## Verification and rollout

Run `npm run test:security`, `npx tsc --noEmit`, `npm run build` and changed-file lint. The security suite mocks provider calls; it never proves actual email delivery or IAM revocation.

Before production release, obtain the approved named-user list, authoritative revocation evidence, install rotated secrets/replacement credentials, publish the reviewed source and verify the exact deployment identity. Use an isolated preview with test configuration for authorized login validation.

After rollout, anonymous calls to each application API must deny without provider work, old sessions must fail, valid named users must reconnect successfully, cross-origin mutations must fail, and the scheduler must remain visibly paused. A controlled send check requires a designated test recipient and records Gmail acceptance separately from downstream synchronization.

Rollback must retain these authorization controls, revoked-key replacement and job quarantine. Do not restore exposed credentials or the old scheduler. The consolidated functional repair plan lives alongside the checkout in `CONSOLIDATED_REPAIR_PLAN.md`.
