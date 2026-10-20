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
        UNIQUE (request_id),
        CHECK (status != 'accepted' OR (gmail_message_id IS NOT NULL AND gmail_message_id != ''))
      )`

function sqliteSendRecordsReady(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, ' ').toLowerCase()
  return /unique\s*\(\s*request_id\s*\)/.test(normalized)
    && normalized.includes('gmail_message_id')
    && normalized.includes('accepted')
}

// CREATE TABLE IF NOT EXISTS leaves an older send_records table untouched, so a
// preview database from an earlier draft of this branch can lack the unique
// request_id target. Rebuild only in that case. A failed rebuild rolls back and
// initialiseDb throws, which refuses the send before Gmail is contacted.
function ensureSqliteSendRecords(db: { prepare: (sql: string) => { get: (...args: unknown[]) => { sql?: string } | undefined; all: (...args: unknown[]) => { name: string }[] }; exec: (sql: string) => void; transaction: (fn: () => void) => () => void }) {
  const existing = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'send_records'`).get()
  if (!existing?.sql || sqliteSendRecordsReady(existing.sql)) return
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
    ensureSqliteSendRecords(db)
    db.close()
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
