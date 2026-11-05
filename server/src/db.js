'use strict';
// Async DB layer with two drivers:
//   - PostgreSQL when DATABASE_URL / POSTGRES_URL is set (Vercel + Neon, or any hosted Postgres)
//   - SQLite (node:sqlite) otherwise, for a single VPS / local use
// SQL is written once with `?` placeholders; the Postgres driver rewrites them to $1, $2, ...
const config = require('./config');

const TABLES = (pg) => `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer','operator','admin','owner')),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT,
    ip TEXT,
    os TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    agent_token_hash TEXT UNIQUE,
    agent_version TEXT,
    agent_capabilities TEXT NOT NULL DEFAULT '[]',
    allow_shell INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    last_seen_at TEXT,
    metrics TEXT,
    facts TEXT,
    created_at TEXT NOT NULL,
    enrolled_by TEXT
  );

  CREATE TABLE IF NOT EXISTS enrollment_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    server_id TEXT
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    dispatched_at TEXT,
    finished_at TEXT,
    exit_code INTEGER,
    output TEXT,
    result TEXT
  );
  CREATE INDEX IF NOT EXISTS tasks_server_status ON tasks(server_id, status);

  CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
    dedupe_key TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    acknowledged_by TEXT
  );
  CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status);

  CREATE TABLE IF NOT EXISTS metrics_history (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    cpu REAL, mem REAL, disk REAL, load1 REAL
  );
  CREATE INDEX IF NOT EXISTS metrics_server_ts ON metrics_history(server_id, ts);

  CREATE TABLE IF NOT EXISTS audit_log (
    id ${pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
    ts TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    actor_label TEXT,
    action TEXT NOT NULL,
    target TEXT,
    details TEXT,
    ip TEXT
  );

  -- login throttling lives in the DB so it works across serverless instances
  CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    first_at TEXT NOT NULL
  );
`;

function sqliteDriver(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(TABLES(false));
  return {
    kind: 'sqlite',
    async one(sql, ...a) { return db.prepare(sql).get(...a); },
    async all(sql, ...a) { return db.prepare(sql).all(...a); },
    async run(sql, ...a) { return { changes: Number(db.prepare(sql).run(...a).changes) }; },
    async close() { db.close(); },
  };
}

function pgDriver(url) {
  const pg = require('pg');
  pg.types.setTypeParser(20, (v) => Number(v)); // COUNT(*) / BIGINT as JS numbers
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 3),
    idleTimeoutMillis: 10000,
    ssl: local || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: process.env.PG_SSL_NO_VERIFY !== '1' },
  });
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const q = (sql, a) => pool.query(toPg(sql), a);
  let ready;
  const init = () => (ready ||= pool.query(TABLES(true)).catch((e) => { ready = null; throw e; }));
  return {
    kind: 'postgres',
    async one(sql, ...a) { await init(); return (await q(sql, a)).rows[0]; },
    async all(sql, ...a) { await init(); return (await q(sql, a)).rows; },
    async run(sql, ...a) { await init(); return { changes: (await q(sql, a)).rowCount }; },
    async close() { await pool.end(); },
  };
}

function open(target) {
  const url = target && /^postgres(ql)?:/.test(target) ? target
    : !target ? (process.env.DATABASE_URL || process.env.POSTGRES_URL) : null;
  if (url) return pgDriver(url);
  if (process.env.VERCEL) {
    throw new Error('On Vercel a Postgres database is required: connect Neon (Storage tab) so DATABASE_URL is set.');
  }
  return sqliteDriver(target || config.DB_FILE);
}

const now = () => new Date().toISOString();
const parseJson = (s, fallback = null) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

module.exports = { open, now, parseJson };
