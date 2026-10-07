export const isVercel = !!process.env.POSTGRES_URL

function assertDatabaseConfiguration() {
  if (process.env.VERCEL && !isVercel) throw new Error('Production database configuration unavailable')
}

export async function initialiseDb() {
  assertDatabaseConfiguration()
  if (isVercel) {
    const { sql } = await import('@vercel/postgres')
    await sql`CREATE TABLE IF NOT EXISTS dossiers (id SERIAL PRIMARY KEY, brand_name TEXT NOT NULL, brand_name_normalised TEXT NOT NULL UNIQUE, dossier_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`
    await sql`CREATE TABLE IF NOT EXISTS usage_log (id SERIAL PRIMARY KEY, brand_name TEXT NOT NULL, call_type TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, rate_per_million_input REAL NOT NULL, rate_per_million_output REAL NOT NULL, estimated_cost_usd REAL NOT NULL, created_at TIMESTAMP DEFAULT NOW())`
    await sql`CREATE TABLE IF NOT EXISTS templates (id SERIAL PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, target_role TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`
    await sql`ALTER TABLE templates ADD COLUMN IF NOT EXISTS target_role TEXT DEFAULT ''`
    await sql`CREATE TABLE IF NOT EXISTS contact_history (id SERIAL PRIMARY KEY, brand_name TEXT NOT NULL, contact_role TEXT NOT NULL, contact_name TEXT NOT NULL, contact_email TEXT NOT NULL, method TEXT DEFAULT 'email', sent_at TIMESTAMP DEFAULT NOW())`
    await sql`CREATE TABLE IF NOT EXISTS saved_suggestions (id SERIAL PRIMARY KEY, brand_name TEXT NOT NULL UNIQUE, category TEXT NOT NULL, reason TEXT NOT NULL, signal TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`
    await sql`CREATE TABLE IF NOT EXISTS scheduled_emails (id SERIAL PRIMARY KEY, to_email TEXT NOT NULL, cc TEXT, bcc TEXT, subject TEXT NOT NULL, body TEXT NOT NULL, brand_name TEXT, contact_name TEXT, scheduled_at TIMESTAMP NOT NULL, sent BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW(), gmail_access_token TEXT, gmail_refresh_token TEXT, timezone TEXT DEFAULT 'Australia/Sydney', sent_by TEXT DEFAULT '', dossier_json TEXT DEFAULT '')`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Australia/Sydney'`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS sent_by TEXT DEFAULT ''`
    await sql`ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS dossier_json TEXT DEFAULT ''`
  } else {
    const Database = require('better-sqlite3')
    const path = require('path')
    const db = new Database(path.join(process.cwd(), 'atelier.db'))
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS dossiers (id INTEGER PRIMARY KEY AUTOINCREMENT, brand_name TEXT NOT NULL, brand_name_normalised TEXT NOT NULL UNIQUE, dossier_json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, brand_name TEXT NOT NULL, call_type TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, rate_per_million_input REAL NOT NULL, rate_per_million_output REAL NOT NULL, estimated_cost_usd REAL NOT NULL, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, target_role TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS contact_history (id INTEGER PRIMARY KEY AUTOINCREMENT, brand_name TEXT NOT NULL, contact_role TEXT NOT NULL, contact_name TEXT NOT NULL, contact_email TEXT NOT NULL, method TEXT DEFAULT 'email', sent_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS saved_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, brand_name TEXT NOT NULL UNIQUE, category TEXT NOT NULL, reason TEXT NOT NULL, signal TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS scheduled_emails (id INTEGER PRIMARY KEY AUTOINCREMENT, to_email TEXT NOT NULL, cc TEXT, bcc TEXT, subject TEXT NOT NULL, body TEXT NOT NULL, brand_name TEXT, contact_name TEXT, scheduled_at TEXT NOT NULL, sent INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), gmail_access_token TEXT, gmail_refresh_token TEXT, timezone TEXT DEFAULT 'Australia/Sydney', sent_by TEXT DEFAULT '', dossier_json TEXT DEFAULT '');
    `)
    try { db.exec(`ALTER TABLE templates ADD COLUMN target_role TEXT DEFAULT ''`) } catch {}
    try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN timezone TEXT DEFAULT 'Australia/Sydney'`) } catch {}
    try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN sent_by TEXT DEFAULT ''`) } catch {}
    try { db.exec(`ALTER TABLE scheduled_emails ADD COLUMN dossier_json TEXT DEFAULT ''`) } catch {}
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