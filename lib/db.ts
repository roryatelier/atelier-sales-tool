export const isVercel = !!process.env.POSTGRES_URL

function assertDatabaseConfiguration() {
  if (process.env.VERCEL && !isVercel) throw new Error('Production database configuration unavailable')
}

// Shared with the local test harness so a temporary database cannot drift from
// the schema initialiseDb actually creates.
export const SEND_RECORDS_SQLITE_DDL = `CREATE TABLE IF NOT EXISTS send_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_google_sub TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','sending','accepted','failed_auth','failed','needs_review')),
        gmail_message_id TEXT,
        last_error_code TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        accepted_at TEXT,
        pipeline_payload TEXT,
        UNIQUE (request_id),
        CHECK (status != 'accepted' OR (gmail_message_id IS NOT NULL AND gmail_message_id != ''))
      )`

// The trigger runs inside the acceptance write: a committed acceptance cannot
// lose its export event if the request stops immediately afterwards. No backfill.
export const OUTREACH_EXPORTS_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS outreach_exports (
  outreach_id TEXT PRIMARY KEY DEFAULT ('outreach:' || lower(hex(randomblob(16)))), source_key TEXT NOT NULL UNIQUE, owner_google_sub TEXT NOT NULL, payload TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL CHECK(length(trim(gmail_message_id)) > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','writing','synced','failed','needs_review')),
  destination_id TEXT NOT NULL DEFAULT '', claim_token TEXT, claimed_at TEXT, write_intent_at TEXT,
  next_attempt_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
  sheet_range TEXT, accepted_at TEXT NOT NULL, synced_at TEXT
);
CREATE TRIGGER IF NOT EXISTS enqueue_immediate_export AFTER UPDATE OF status ON send_records
WHEN NEW.status IN ('accepted','needs_review') AND NEW.gmail_message_id IS NOT NULL AND length(trim(NEW.gmail_message_id)) > 0 AND NEW.pipeline_payload IS NOT NULL
BEGIN
  INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,accepted_at)
    VALUES ('immediate:' || NEW.id,NEW.owner_google_sub,NEW.pipeline_payload,NEW.gmail_message_id,COALESCE(NEW.accepted_at,datetime('now')))
    ON CONFLICT(source_key) DO NOTHING;
END;
`

function sqliteSendRecordsReady(sql: string, columns: Set<string>): boolean {
  const normalized = sql.replace(/\s+/g, ' ').toLowerCase()
  const statuses = normalized.match(/check\s*\(\s*status\s+in\s*\(([^)]+)\)\s*\)/)?.[1]
    .split(',').map(value => value.trim()) ?? []
  const requiredStatuses = ['recorded', 'sending', 'accepted', 'failed_auth', 'failed', 'needs_review']
  const requiredColumns = ['id', 'owner_google_sub', 'owner_email', 'request_id', 'payload_hash', 'status',
    'gmail_message_id', 'last_error_code', 'last_error', 'created_at', 'updated_at', 'accepted_at']
  return requiredColumns.every(column => columns.has(column))
    && /unique\s*\(\s*request_id\s*\)/.test(normalized)
    && statuses.length === requiredStatuses.length
    && requiredStatuses.every(status => statuses.includes(`'${status}'`))
    && /check\s*\(\s*status\s*(?:!=|<>)\s*'accepted'\s+or\s*\(\s*gmail_message_id\s+is\s+not\s+null\s+and\s+gmail_message_id\s*(?:!=|<>)\s*''\s*\)\s*\)/.test(normalized)
}

// CREATE TABLE IF NOT EXISTS leaves an older send_records table untouched, so a
// preview database from an earlier draft can lack columns or either invariant,
// even when request_id is already unique. A failed rebuild rolls back and
// initialiseDb throws, which refuses the send before Gmail is contacted.
function ensureSqliteSendRecords(db: { prepare: (sql: string) => { get: (...args: unknown[]) => { sql?: string } | undefined; all: (...args: unknown[]) => { name: string }[] }; exec: (sql: string) => void; transaction: (fn: () => void) => () => void }) {
  const existing = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'send_records'`).get()
  if (!existing?.sql) return
  const columns = new Set(db.prepare('PRAGMA table_info(send_records)').all().map(column => column.name))
  if (sqliteSendRecordsReady(existing.sql, columns)) return
  const rebuild = db.transaction(() => {
    db.exec('ALTER TABLE send_records RENAME TO send_records_legacy')
    db.exec(SEND_RECORDS_SQLITE_DDL)
    const legacy = new Set(db.prepare('PRAGMA table_info(send_records_legacy)').all().map(column => column.name))
    const columns = db.prepare('PRAGMA table_info(send_records)').all().map(column => column.name).filter(name => legacy.has(name))
    if (columns.length > 0) {
      const list = columns.map(name => `"${name.replace(/"/g, '')}"`).join(', ')
      db.exec(`INSERT INTO send_records (${list}) SELECT ${list} FROM send_records_legacy`)
    }
    db.exec('DROP TABLE send_records_legacy')
  })
  rebuild()
}

export async function initialiseDb() {
  assertDatabaseConfiguration()
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    await sql`CREATE TABLE IF NOT EXISTS dossiers (id SERIAL PRIMARY KEY, brand_name TEXT NOT NULL, brand_name_normalised TEXT NOT NULL UNIQUE, dossier_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`
    await sql`CREATE TABLE IF NOT EXISTS usage_log (id SERIAL PRIMARY KEY, brand_name TEXT NOT NULL, call_type TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, rate_per_million_input REAL NOT NULL, rate_per_million_output REAL NOT NULL, estimated_cost_usd REAL NOT NULL, created_at TIMESTAMP DEFAULT NOW())`
    await sql`CREATE TABLE IF NOT EXISTS templates (id SERIAL PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, target_role TEXT DEFAULT '', source TEXT DEFAULT 'user', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`
    await sql`ALTER TABLE templates ADD COLUMN IF NOT EXISTS target_role TEXT DEFAULT ''`
    await sql`ALTER TABLE templates ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'user'`
    await sql`CREATE TABLE IF NOT EXISTS email_guidance (id INTEGER PRIMARY KEY, content TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW())`
    await sql`ALTER TABLE email_guidance ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'unknown'`
    await sql`CREATE TABLE IF NOT EXISTS content_migrations (key TEXT PRIMARY KEY, applied_at TIMESTAMP DEFAULT NOW())`
    await sql`CREATE TABLE IF NOT EXISTS email_signatures (owner_google_sub TEXT PRIMARY KEY, owner_email TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', updated_at TIMESTAMP DEFAULT NOW())`
    await sql`CREATE TABLE IF NOT EXISTS contact_history (id SERIAL PRIMARY KEY, brand_name TEXT NOT NULL, contact_role TEXT NOT NULL, contact_name TEXT NOT NULL, contact_email TEXT NOT NULL, method TEXT DEFAULT 'email', sent_at TIMESTAMP DEFAULT NOW())`
    await sql`CREATE TABLE IF NOT EXISTS saved_suggestions (id SERIAL PRIMARY KEY, brand_name TEXT NOT NULL UNIQUE, category TEXT NOT NULL, reason TEXT NOT NULL, signal TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`
    await sql`CREATE TABLE IF NOT EXISTS scheduled_emails (id SERIAL PRIMARY KEY, to_email TEXT NOT NULL, cc TEXT, bcc TEXT, subject TEXT NOT NULL, body TEXT NOT NULL, brand_name TEXT, contact_name TEXT, scheduled_at TIMESTAMPTZ NOT NULL, sent BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW(), gmail_access_token TEXT, gmail_refresh_token TEXT, timezone TEXT DEFAULT 'Australia/Sydney', sent_by TEXT DEFAULT '', dossier_json TEXT DEFAULT '', owner_google_sub TEXT, owner_email TEXT, credential_ciphertext TEXT, delivery_status TEXT DEFAULT 'legacy_quarantined', attempt_count INTEGER DEFAULT 0, claimed_at TIMESTAMP, sent_at TIMESTAMP, gmail_message_id TEXT, last_error_code TEXT)`
    await sql`CREATE TABLE IF NOT EXISTS send_records (
      id SERIAL PRIMARY KEY,
      owner_google_sub TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','sending','accepted','failed_auth','failed','needs_review')),
      gmail_message_id TEXT,
      last_error_code TEXT,
      last_error TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      accepted_at TIMESTAMP,
      CONSTRAINT send_records_request UNIQUE (request_id),
      CONSTRAINT send_records_accepted_has_message CHECK (status != 'accepted' OR (gmail_message_id IS NOT NULL AND gmail_message_id != ''))
    )`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Australia/Sydney'`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS sent_by TEXT DEFAULT ''`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS dossier_json TEXT DEFAULT ''`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS owner_google_sub TEXT`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS owner_email TEXT`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS credential_ciphertext TEXT`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'legacy_quarantined'`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS gmail_message_id TEXT`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS last_error_code TEXT`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS claim_token TEXT`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS send_intent_at TIMESTAMPTZ`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ`
    await sql`ALTER TABLE send_records ADD COLUMN IF NOT EXISTS owner_google_sub TEXT NOT NULL DEFAULT ''`
    await sql`ALTER TABLE send_records ADD COLUMN IF NOT EXISTS owner_email TEXT NOT NULL DEFAULT ''`
    await sql`ALTER TABLE send_records ADD COLUMN IF NOT EXISTS request_id TEXT NOT NULL DEFAULT ''`
    await sql`ALTER TABLE send_records ADD COLUMN IF NOT EXISTS payload_hash TEXT NOT NULL DEFAULT ''`
    await sql`ALTER TABLE send_records ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'recorded'`
    await sql`ALTER TABLE send_records ADD COLUMN IF NOT EXISTS gmail_message_id TEXT`
    await sql`ALTER TABLE send_records ADD COLUMN IF NOT EXISTS last_error_code TEXT`
    await sql`ALTER TABLE send_records ADD COLUMN IF NOT EXISTS last_error TEXT`
    await sql`ALTER TABLE send_records ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`
    await sql`ALTER TABLE send_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`
    await sql`ALTER TABLE send_records ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP`
    await sql`ALTER TABLE send_records ADD COLUMN IF NOT EXISTS pipeline_payload TEXT`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS pipeline_payload TEXT`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS request_id TEXT`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS payload_hash TEXT`
    // Idempotent scheduling: a request id binds one schedule submission to one job.
    // Existing NULL request ids (legacy rows) never collide on a partial index.
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS scheduled_emails_request_id ON scheduled_emails (request_id) WHERE request_id IS NOT NULL`
    await sql`CREATE TABLE IF NOT EXISTS outreach_exports (
      outreach_id TEXT PRIMARY KEY DEFAULT ('outreach:' || replace(gen_random_uuid()::text,'-','')), source_key TEXT NOT NULL UNIQUE, owner_google_sub TEXT NOT NULL, payload TEXT NOT NULL,
      gmail_message_id TEXT NOT NULL CHECK(length(trim(gmail_message_id)) > 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','writing','synced','failed','needs_review')),
      destination_id TEXT NOT NULL DEFAULT '', claim_token TEXT, claimed_at TIMESTAMPTZ, write_intent_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ, attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
      sheet_range TEXT, accepted_at TIMESTAMPTZ NOT NULL, synced_at TIMESTAMPTZ
    )`
    // Install this version once under a transaction-scoped lock. Replacing a
    // function on every request races concurrent initializations in Postgres.
    await sql`DO $migration$ BEGIN
      PERFORM pg_advisory_xact_lock(742091631);
      IF to_regprocedure('public.enqueue_outreach_export_v2()') IS NULL THEN
        EXECUTE $function$ CREATE FUNCTION public.enqueue_outreach_export_v2() RETURNS trigger AS $body$
    BEGIN
      IF NEW.pipeline_payload IS NOT NULL AND NEW.gmail_message_id IS NOT NULL AND length(trim(NEW.gmail_message_id)) > 0 THEN
        IF TG_TABLE_NAME = 'send_records' THEN
          IF NEW.status IN ('accepted','needs_review') THEN
            INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,accepted_at)
            VALUES ('immediate:' || NEW.id,NEW.owner_google_sub,NEW.pipeline_payload,NEW.gmail_message_id,NOW())
            ON CONFLICT(source_key) DO NOTHING;
          END IF;
        ELSE
          IF NEW.delivery_status = 'sent' THEN
            INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,accepted_at)
            VALUES ('scheduled:' || NEW.id,NEW.owner_google_sub,NEW.pipeline_payload,NEW.gmail_message_id,NOW())
            ON CONFLICT(source_key) DO NOTHING;
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END;
        $body$ LANGUAGE plpgsql $function$;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.send_records'::regclass AND tgname = 'enqueue_immediate_export' AND tgfoid = 'public.enqueue_outreach_export_v2()'::regprocedure) THEN
        DROP TRIGGER IF EXISTS enqueue_immediate_export ON send_records;
        CREATE TRIGGER enqueue_immediate_export AFTER UPDATE OF status ON send_records FOR EACH ROW EXECUTE FUNCTION public.enqueue_outreach_export_v2();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.scheduled_emails'::regclass AND tgname = 'enqueue_scheduled_export' AND tgfoid = 'public.enqueue_outreach_export_v2()'::regprocedure) THEN
        DROP TRIGGER IF EXISTS enqueue_scheduled_export ON scheduled_emails;
        CREATE TRIGGER enqueue_scheduled_export AFTER UPDATE OF delivery_status ON scheduled_emails FOR EACH ROW EXECUTE FUNCTION public.enqueue_outreach_export_v2();
      END IF;
    END $migration$`
    // ON CONFLICT (request_id) needs a unique index on that column. An older
    // table created before the constraint existed will not get one from
    // CREATE TABLE IF NOT EXISTS. Fail the init (and therefore the send) if
    // duplicates make the index impossible to add.
    await sql`DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_index i
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND t.relname = 'send_records' AND i.indisunique
            AND (
              SELECT array_agg(a.attname::text ORDER BY cols.ord)
              FROM unnest(i.indkey) WITH ORDINALITY AS cols(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = cols.attnum
            ) = ARRAY['request_id']::text[]
        ) THEN
          CREATE UNIQUE INDEX send_records_request_id_key ON send_records (request_id);
        END IF;
      END $$`
    await sql`DO $$
      DECLARE
        constraint_name text;
        definition text;
      BEGIN
        FOR constraint_name, definition IN
          SELECT c.conname, pg_get_constraintdef(c.oid)
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND t.relname = 'send_records' AND c.contype = 'c'
        LOOP
          IF definition ILIKE '%status%' AND definition NOT ILIKE '%needs_review%' AND definition NOT ILIKE '%gmail_message_id%' THEN
            EXECUTE format('ALTER TABLE send_records DROP CONSTRAINT %I', constraint_name);
          END IF;
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND t.relname = 'send_records' AND c.contype = 'c'
            AND pg_get_constraintdef(c.oid) ILIKE '%needs_review%'
        ) THEN
          ALTER TABLE send_records ADD CONSTRAINT send_records_status_allowed
            CHECK (status IN ('recorded','sending','accepted','failed_auth','failed','needs_review'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND t.relname = 'send_records' AND c.contype = 'c'
            AND pg_get_constraintdef(c.oid) ILIKE '%gmail_message_id%'
        ) THEN
          ALTER TABLE send_records ADD CONSTRAINT send_records_accepted_has_message
            CHECK (status <> 'accepted' OR (gmail_message_id IS NOT NULL AND gmail_message_id <> ''));
        END IF;
      END $$`
    await sql`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'scheduled_emails'
          AND column_name = 'scheduled_at' AND data_type = 'timestamp without time zone'
      ) THEN
        ALTER TABLE scheduled_emails ALTER COLUMN scheduled_at TYPE TIMESTAMPTZ USING scheduled_at AT TIME ZONE 'UTC';
      END IF;
    END $$`
  } else {
    const Database = require('better-sqlite3')
    const path = require('path')
    const db = new Database(path.join(process.cwd(), 'atelier.db'))
    try {
      db.pragma('journal_mode = WAL')
      db.exec(`
        CREATE TABLE IF NOT EXISTS dossiers (id INTEGER PRIMARY KEY AUTOINCREMENT, brand_name TEXT NOT NULL, brand_name_normalised TEXT NOT NULL UNIQUE, dossier_json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, brand_name TEXT NOT NULL, call_type TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, rate_per_million_input REAL NOT NULL, rate_per_million_output REAL NOT NULL, estimated_cost_usd REAL NOT NULL, created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, target_role TEXT DEFAULT '', source TEXT DEFAULT 'user', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS email_guidance (id INTEGER PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS content_migrations (key TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS email_signatures (owner_google_sub TEXT PRIMARY KEY, owner_email TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS contact_history (id INTEGER PRIMARY KEY AUTOINCREMENT, brand_name TEXT NOT NULL, contact_role TEXT NOT NULL, contact_name TEXT NOT NULL, contact_email TEXT NOT NULL, method TEXT DEFAULT 'email', sent_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS saved_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, brand_name TEXT NOT NULL UNIQUE, category TEXT NOT NULL, reason TEXT NOT NULL, signal TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS scheduled_emails (id INTEGER PRIMARY KEY AUTOINCREMENT, to_email TEXT NOT NULL, cc TEXT, bcc TEXT, subject TEXT NOT NULL, body TEXT NOT NULL, brand_name TEXT, contact_name TEXT, scheduled_at TEXT NOT NULL, sent INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), gmail_access_token TEXT, gmail_refresh_token TEXT, timezone TEXT DEFAULT 'Australia/Sydney', sent_by TEXT DEFAULT '', dossier_json TEXT DEFAULT '');
      `)
      db.exec(SEND_RECORDS_SQLITE_DDL)
      try { db.exec(`ALTER TABLE email_guidance ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'`) } catch (error) {
        if (!String(error).includes('duplicate column name')) throw error
      }
      try { db.exec(`ALTER TABLE templates ADD COLUMN target_role TEXT DEFAULT ''`) } catch {}
      try { db.exec(`ALTER TABLE templates ADD COLUMN source TEXT DEFAULT 'user'`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN timezone TEXT DEFAULT 'Australia/Sydney'`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN sent_by TEXT DEFAULT ''`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN dossier_json TEXT DEFAULT ''`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN owner_google_sub TEXT`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN owner_email TEXT`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN credential_ciphertext TEXT`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN delivery_status TEXT DEFAULT 'legacy_quarantined'`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN attempt_count INTEGER DEFAULT 0`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN claimed_at TEXT`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN sent_at TEXT`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN gmail_message_id TEXT`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN last_error_code TEXT`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN claim_token TEXT`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN send_intent_at TEXT`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN next_attempt_at TEXT`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN request_id TEXT`) } catch {}
      try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN payload_hash TEXT`) } catch {}
      // Idempotent scheduling: partial unique index keeps legacy NULL request ids out.
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS scheduled_emails_request_id ON scheduled_emails (request_id) WHERE request_id IS NOT NULL`)
      ensureSqliteSendRecords(db)
      for (const table of ['send_records', 'scheduled_emails']) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        if (!columns.some(column => column.name === 'pipeline_payload')) db.exec(`ALTER TABLE ${table} ADD COLUMN pipeline_payload TEXT`)
      }
      db.transaction(() => {
        const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'enqueue_immediate_export'").get() as { sql: string } | undefined
        if (trigger && !trigger.sql.includes("NEW.status IN ('accepted','needs_review')")) db.exec('DROP TRIGGER enqueue_immediate_export')
        db.exec(OUTREACH_EXPORTS_SQLITE_DDL)
      })()
      db.exec(`CREATE TRIGGER IF NOT EXISTS enqueue_scheduled_export AFTER UPDATE OF delivery_status ON scheduled_emails
        WHEN NEW.delivery_status = 'sent' AND NEW.gmail_message_id IS NOT NULL AND length(trim(NEW.gmail_message_id)) > 0 AND NEW.pipeline_payload IS NOT NULL
        BEGIN
          INSERT INTO outreach_exports(source_key,owner_google_sub,payload,gmail_message_id,accepted_at)
          VALUES ('scheduled:' || NEW.id,NEW.owner_google_sub,NEW.pipeline_payload,NEW.gmail_message_id,COALESCE(NEW.sent_at,datetime('now')))
          ON CONFLICT(source_key) DO NOTHING;
        END;`)
    } finally {
      db.close()
    }
  }
}

export function getLocalDb() {
  assertDatabaseConfiguration()
  const Database = require('better-sqlite3')
  const path = require('path')
  return new Database(path.join(process.cwd(), 'atelier.db'))
}

export function normaliseBrandName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}
