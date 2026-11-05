'use strict';
// Async DB layer with two drivers:
//   - PostgreSQL when DATABASE_URL / POSTGRES_URL is set (Vercel + Neon, or any hosted Postgres)
//   - SQLite (node:sqlite) otherwise, for a single VPS / local use
// SQL is written once with `?` placeholders; the Postgres driver rewrites them to $1, $2, ...
//
// Multi-tenant: every tenant is an "organization" (one company = one infrastructure). Users,
// servers, enrollment tokens, secrets, tasks, alerts and audit entries all carry org_id, and the
// API scopes every query to the caller's organization. A platform_admin user can manage orgs.
const config = require('./config');

const TABLES = (pg) => `
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer','operator','admin','owner')),
    platform_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    hostname TEXT,
    ip TEXT,
    os TEXT,
    platform TEXT NOT NULL DEFAULT 'linux',
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
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
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
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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

  CREATE TABLE IF NOT EXISTS metrics_history (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    cpu REAL, mem REAL, disk REAL, load1 REAL
  );
  CREATE INDEX IF NOT EXISTS metrics_server_ts ON metrics_history(server_id, ts);

  CREATE TABLE IF NOT EXISTS audit_log (
    id ${pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
    org_id TEXT,
    ts TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    actor_label TEXT,
    action TEXT NOT NULL,
    target TEXT,
    details TEXT,
    ip TEXT
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    first_at TEXT NOT NULL
  );

  -- Network scan: devices discovered on the infrastructure by an enrolled agent.
  CREATE TABLE IF NOT EXISTS scanned_devices (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    dkey TEXT NOT NULL,                 -- dedupe key within org: mac, else subnet|ip
    scanner_server_id TEXT,            -- the agent that observed it
    ip TEXT,
    mac TEXT,
    vendor TEXT,
    hostname TEXT,
    device_type TEXT,
    subnet TEXT,                       -- CIDR the device sits in
    vlan TEXT,                         -- VLAN id/name when detectable
    open_ports TEXT NOT NULL DEFAULT '[]',
    snmp TEXT,                         -- JSON: sysName, sysDescr, model, serial, ...
    is_gateway INTEGER NOT NULL DEFAULT 0,
    managed_server_id TEXT,            -- linked server once an agent is installed
    status TEXT NOT NULL DEFAULT 'discovered',  -- discovered | connecting | managed
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );

  -- Network scan: subnets / VLANs discovered, for the topology model.
  CREATE TABLE IF NOT EXISTS network_subnets (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    cidr TEXT NOT NULL,
    vlan TEXT,
    gateway_ip TEXT,
    scanner_server_id TEXT,
    device_count INTEGER NOT NULL DEFAULT 0,
    last_scan TEXT NOT NULL
  );
`;

// Column additions applied to databases created by an older schema version.
// Each entry: [table, column, "DDL type/default"]. Added only if missing.
const ADD_COLUMNS = [
  ['users', 'org_id', 'TEXT'],
  ['users', 'platform_admin', 'INTEGER NOT NULL DEFAULT 0'],
  ['servers', 'org_id', 'TEXT'],
  ['servers', 'platform', "TEXT NOT NULL DEFAULT 'linux'"],
  ['servers', 'agent_capabilities', "TEXT NOT NULL DEFAULT '[]'"],
  ['enrollment_tokens', 'org_id', 'TEXT'],
  ['tasks', 'org_id', 'TEXT'],
  ['secrets', 'org_id', 'TEXT'],
  ['alerts', 'org_id', 'TEXT'],
  ['audit_log', 'org_id', 'TEXT'],
];

async function migrate(d, pg) {
  // 1. add any missing columns
  const existing = async (table) => {
    if (pg) return (await d.all('SELECT column_name AS n FROM information_schema.columns WHERE table_name = ?', table)).map((r) => r.n);
    return (await d.all(`PRAGMA table_info(${table})`)).map((r) => r.name);
  };
  for (const [table, col, ddl] of ADD_COLUMNS) {
    const cols = await existing(table);
    if (!cols.includes(col)) await d.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
  // 2. drop the old global-unique constraint on secrets.name (Postgres only; SQLite installs are fresh)
  if (pg) {
    await d.run('ALTER TABLE secrets DROP CONSTRAINT IF EXISTS secrets_name_key').catch(() => {});
    await d.run('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key').catch(() => {});
    await d.run('CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email))').catch(() => {});
  }
  // 3. backfill a default organization for any pre-tenant rows
  const orphan = await d.one('SELECT COUNT(*) AS n FROM users WHERE org_id IS NULL');
  if (orphan && orphan.n > 0) {
    let org = await d.one('SELECT id FROM organizations ORDER BY created_at LIMIT 1');
    if (!org) {
      const id = `org_${Math.random().toString(36).slice(2, 11)}`;
      await d.run('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)', id, 'Mặc định', new Date().toISOString());
      org = { id };
    }
    for (const t of ['users', 'servers', 'enrollment_tokens', 'tasks', 'secrets', 'alerts']) {
      await d.run(`UPDATE ${t} SET org_id = ? WHERE org_id IS NULL`, org.id).catch(() => {});
    }
    // the first/oldest owner becomes the platform admin
    const owner = await d.one("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1");
    if (owner) await d.run('UPDATE users SET platform_admin = 1 WHERE id = ?', owner.id);
  }
  // 4. indexes that reference org_id — created here (after the columns exist) so an
  //    older database that predates multi-tenancy can be upgraded in place.
  await d.run('CREATE INDEX IF NOT EXISTS servers_org ON servers(org_id)').catch(() => {});
  await d.run('CREATE INDEX IF NOT EXISTS alerts_status ON alerts(org_id, status)').catch(() => {});
  await d.run('CREATE UNIQUE INDEX IF NOT EXISTS secrets_org_name ON secrets(org_id, name)').catch(() => {});
  await d.run('CREATE UNIQUE INDEX IF NOT EXISTS scanned_devices_org_dkey ON scanned_devices(org_id, dkey)').catch(() => {});
  await d.run('CREATE INDEX IF NOT EXISTS scanned_devices_org ON scanned_devices(org_id)').catch(() => {});
  await d.run('CREATE UNIQUE INDEX IF NOT EXISTS network_subnets_org_cidr ON network_subnets(org_id, cidr)').catch(() => {});
}

function sqliteDriver(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(TABLES(false));
  const raw = {
    one: async (sql, ...a) => db.prepare(sql).get(...a),
    all: async (sql, ...a) => db.prepare(sql).all(...a),
    run: async (sql, ...a) => ({ changes: Number(db.prepare(sql).run(...a).changes) }),
  };
  const d = {
    kind: 'sqlite',
    async one(sql, ...a) { await d.ready; return raw.one(sql, ...a); },
    async all(sql, ...a) { await d.ready; return raw.all(sql, ...a); },
    async run(sql, ...a) { await d.ready; return raw.run(sql, ...a); },
    async close() { db.close(); },
  };
  d.ready = migrate(raw, false);
  return d;
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
  const d = {
    kind: 'postgres',
    async one(sql, ...a) { await d.ready; return (await q(sql, a)).rows[0]; },
    async all(sql, ...a) { await d.ready; return (await q(sql, a)).rows; },
    async run(sql, ...a) { await d.ready; return { changes: (await q(sql, a)).rowCount }; },
    async close() { await pool.end(); },
  };
  // init schema then migrate, once per process
  d.ready = (async () => {
    await pool.query(TABLES(true));
    // run migrate with a version of the driver that doesn't await d.ready (avoids deadlock)
    await migrate({ one: async (s, ...a) => (await q(s, a)).rows[0], all: async (s, ...a) => (await q(s, a)).rows, run: async (s, ...a) => ({ changes: (await q(s, a)).rowCount }) }, true);
  })();
  return d;
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
