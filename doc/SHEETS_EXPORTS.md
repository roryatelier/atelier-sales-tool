# Durable Sheets exports

This patch records new pipeline exports alongside Gmail acceptance. It does not
change message recipients/content, activate quarantined jobs, backfill old mail,
or make the database the source of truth for the existing pipeline page.

## Setup and first live check

Before enabling exports, an operator must inspect the configured spreadsheet and
reserve **Sheet1!R1 = Outreach ID** and **Sheet1!S1 = Recipient Email**. Existing
columns A:Q retain their meanings. Do not overwrite occupied columns: reconcile
them first. Until these headers exist, messages can still be accepted by Gmail;
their export remains visibly failed and can retry after setup.

No deployment credentials or spreadsheet contents are required for local tests.
The PR does not modify the production spreadsheet. After code/schema review,
use an explicitly approved internal recipient for live acceptance testing:

1. Confirm an immediate and a scheduled send each creates one accepted source
   record and one `outreach_exports` event.
2. Confirm each exported row contains the expected ID and actual To address.
   The row and `atelier_outreach_id` developer metadata are created atomically.
3. Retry the export and confirm no new email or duplicate row appears.
4. Check a pre-write permission/configuration failure stays visible and can retry.
5. Check status/notes for two contacts at one brand target different outreach IDs.
   On a disposable sheet, move a complete row and confirm metadata-targeted edits
   still affect the intended outreach. Partial-column sorts can break record
   identity and must not be used on the pipeline table.
6. Confirm the live cron runs at its configured interval. This patch adds no new
   cron entry and does not establish independent monitoring.

## State and recovery

An acceptance update and its export event commit together using database triggers.
The trigger function is versioned and installed once under a PostgreSQL transaction
lock; repeated/concurrent request initialization does not replace it. SQLite uses
inline migrations and equivalent triggers. No historical event is inferred.

An export starts `pending`, is atomically `claimed`, then records `writing` only
immediately before the actual Sheets write. Each attempt has a token. A stale
claim without a write intent may retry after five minutes. An interrupted write
becomes `needs_review`. A fresh attempt always looks for the existing outreach ID
before writing. If it finds that ID exactly once, it marks the export `synced`.

A timeout or missing response after write intent does not prove a failed write.
The **Check Sheets** action only reconciles by ID and never makes a second append
for that uncertain attempt. If no ID appears, an operator must resolve the outcome
against Sheets/provider evidence. There is no force-append control in this patch.
Pre-write failures use a 15-minute backoff; an owner may retry explicitly sooner.

The existing scheduled-email cron services one queued export per invocation to
bound the added work. New accepted messages also attempt their own export. A
Gmail configuration failure does not prevent the queued Sheets work from running.
Export retries have no Gmail operation. If cron stops, the UI can still retry;
external alerting and a dedicated export worker remain separate work.

A destination is bound durably before the first Sheets attempt. Changing the
configured spreadsheet pauses exports bound to the old destination; the worker
does not silently redirect them into a new spreadsheet.

## Record identity and data

The outbox stores the existing pipeline fields and actual To address. It does not
store BCC, attachments, credential material, or unrelated dossier fields. The email
body remains an existing pipeline field. Gmail message IDs remain in the database
and are not added to Sheets. The owner-scoped status API omits body/provider IDs.

Exported outreach IDs are random 128-bit values. Internal source keys deduplicate
events without exposing database row numbers or colliding with another database
that shares the spreadsheet.

Each new row is inserted and written with its row metadata in one Sheets batch.
Insertion shifts concurrent rows instead of overwriting a pre-read empty cell.
Status/notes updates use a unique metadata ID, with nulls leaving unrelated cells
unchanged. Missing/duplicated metadata fails closed. Metadata is identification,
not an access control; sheet access and named application admission still apply.

Legacy rows have no durable metadata. Brand-only edits require exactly one match,
and still use a row position; avoid structural changes while those writes run.
A separate, reviewed legacy migration is needed to remove this remaining limit.
The database has not replaced Sheets as the pipeline read source.

The implementation follows Google's [batch update contract](https://developers.google.com/workspace/sheets/api/guides/batchupdate)
and [developer metadata API](https://developers.google.com/workspace/sheets/api/guides/metadata).
Local adapter tests assert request shapes; native PostgreSQL tests cover actual
schema/trigger/claim SQL with synthetic Sheets. Neither proves Google's live
response behavior or Neon transport. The live checks above remain required.

## Rollback

Pause immediate and scheduled sending before reverting the application squash
commit. Preserve the new columns, outbox and triggers. Old code does not create
new snapshots or drain the outbox, but pre-existing frozen source records can
still enqueue events while an older worker also performs its untracked append.
Review outstanding events AND frozen pending source records before resuming that
older path. Reconcile Sheets/provider evidence first; do not blindly reset
uncertain writes to pending. No existing data or quarantined send should be
deleted or automatically activated during rollback.
