'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const sec = require('./security');
const { now, parseJson } = require('./db');
const { Router, HttpError, readJson, send, clientIp } = require('./http');
const { ACTIONS, validateParams, ValidationError } = require('./actions');

const WEB_DIR = path.join(__dirname, '..', 'web');
// agent/ sits next to server/ in the repo; the Vercel bundle places a copy inside server/agent.
const AGENT_DIR = path.resolve(process.env.AGENT_DIR
  || [path.join(__dirname, '..', 'agent'), path.join(__dirname, '..', '..', 'agent')].find((d) => fs.existsSync(path.join(d, 'infra_agent.py')))
  || path.join(__dirname, '..', '..', 'agent'));
const PLAN_LIMITS = { basic: 10, professional: 100, enterprise: Infinity, government: Infinity };
const MAX_OUTPUT = 256 * 1024;
const POLL_INTERVAL = 10;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

function createApp(db) {
  const r = new Router();
  const { one, all, run } = db;

  // ------------------------------------------------------------------ helpers
  async function audit(ctx, action, target, details) {
    const actor = ctx.user ? { type: 'user', id: ctx.user.id, label: ctx.user.email }
      : ctx.server ? { type: 'agent', id: ctx.server.id, label: ctx.server.name }
      : { type: 'system', id: null, label: 'system' };
    const orgId = ctx.orgId ?? ctx.user?.org_id ?? ctx.server?.org_id ?? null;
    await run('INSERT INTO audit_log (org_id, ts, actor_type, actor_id, actor_label, action, target, details, ip) VALUES (?,?,?,?,?,?,?,?,?)',
      orgId, now(), actor.type, actor.id, actor.label, action, target ?? null, details ? JSON.stringify(details) : null, ctx.ip ?? null);
  }

  const publicUser = (u) => u && ({ id: u.id, org_id: u.org_id, email: u.email, name: u.name, role: u.role, platform_admin: !!u.platform_admin, disabled: !!u.disabled, created_at: u.created_at, last_login_at: u.last_login_at });
  const publicServer = (s) => s && ({
    id: s.id, org_id: s.org_id, name: s.name, hostname: s.hostname, ip: s.ip, os: s.os, platform: s.platform || 'linux', tags: parseJson(s.tags, []),
    agent_version: s.agent_version, agent_capabilities: parseJson(s.agent_capabilities, []),
    allow_shell: !!s.allow_shell, status: s.status, last_seen_at: s.last_seen_at,
    metrics: parseJson(s.metrics), facts: parseJson(s.facts), created_at: s.created_at,
  });
  const publicDevice = (d) => d && ({
    id: d.id, org_id: d.org_id, scanner_server_id: d.scanner_server_id, ip: d.ip, mac: d.mac,
    vendor: d.vendor, hostname: d.hostname, device_type: d.device_type, subnet: d.subnet, vlan: d.vlan,
    open_ports: parseJson(d.open_ports, []), snmp: parseJson(d.snmp), is_gateway: !!d.is_gateway,
    managed_server_id: d.managed_server_id, status: d.status, first_seen: d.first_seen, last_seen: d.last_seen,
  });
  const publicAssessment = (a) => a && ({
    id: a.id, server_id: a.server_id, score: a.score, counts: parseJson(a.counts, {}),
    findings: parseJson(a.findings, []), inventory: parseJson(a.inventory), created_at: a.created_at,
  });
  const publicTask = (t, { full = false } = {}) => t && ({
    id: t.id, server_id: t.server_id, action: t.action, title: ACTIONS[t.action]?.title, params: parseJson(t.params, {}),
    status: t.status, created_by: t.created_by, created_at: t.created_at, dispatched_at: t.dispatched_at,
    finished_at: t.finished_at, exit_code: t.exit_code,
    ...(full ? { output: t.output, result: parseJson(t.result) } : {}),
  });

  function baseUrl(req) {
    if (config.PUBLIC_URL) return config.PUBLIC_URL.replace(/\/$/, '');
    const proto = (process.env.TRUST_PROXY === '1' || config.SERVERLESS) && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http';
    return `${proto}://${req.headers.host}`;
  }

  async function upsertAlert(orgId, serverId, key, severity, type, message) {
    const existing = await one("SELECT * FROM alerts WHERE dedupe_key = ? AND status != 'resolved'", key);
    if (existing) {
      if (existing.severity !== severity || existing.message !== message) {
        await run('UPDATE alerts SET severity = ?, message = ?, updated_at = ? WHERE id = ?', severity, message, now(), existing.id);
      }
      return;
    }
    await run('INSERT INTO alerts (id, org_id, server_id, dedupe_key, severity, type, message, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      sec.newId('alr'), orgId, serverId, key, severity, type, message, 'open', now(), now());
  }
  async function resolveAlert(key) {
    await run("UPDATE alerts SET status = 'resolved', updated_at = ? WHERE dedupe_key = ? AND status != 'resolved'", now(), key);
  }

  async function evaluateMetrics(server, m) {
    const org = server.org_id;
    const checks = [
      ['cpu', m.cpu_percent, 90, 97, 'CPU'],
      ['mem', m.mem_percent, 90, 97, 'RAM'],
      ['disk', m.disk_percent, 80, 92, 'Ổ đĩa'],
    ];
    for (const [k, value, warn, crit, label] of checks) {
      const key = `${server.id}:${k}`;
      if (typeof value !== 'number') continue;
      if (value >= crit) await upsertAlert(org, server.id, key, 'critical', k, `${label} ${value.toFixed(0)}% trên ${server.name}`);
      else if (value >= warn) await upsertAlert(org, server.id, key, 'warning', k, `${label} ${value.toFixed(0)}% trên ${server.name}`);
      else await resolveAlert(key);
    }
    const sk = `${server.id}:security_updates`;
    if (typeof m.security_updates === 'number' && m.security_updates > 0) {
      await upsertAlert(org, server.id, sk, 'warning', 'security', `${m.security_updates} bản vá bảo mật chưa cài trên ${server.name}`);
    } else if (m.security_updates === 0) await resolveAlert(sk);
    const rk = `${server.id}:reboot_required`;
    if (m.reboot_required) await upsertAlert(org, server.id, rk, 'info', 'reboot', `${server.name} cần khởi động lại để áp dụng cập nhật`);
    else await resolveAlert(rk);
  }

  // Periodic housekeeping: mark silent agents offline, time out stuck tasks, trim history.
  async function tick() {
    const cutoff = new Date(Date.now() - config.AGENT_OFFLINE_AFTER_SECONDS * 1000).toISOString();
    for (const s of await all("SELECT * FROM servers WHERE status = 'online' AND last_seen_at < ?", cutoff)) {
      await run("UPDATE servers SET status = 'offline' WHERE id = ?", s.id);
      await upsertAlert(s.org_id, s.id, `${s.id}:offline`, 'critical', 'offline', `Mất kết nối với agent trên ${s.name}`);
      await audit({ orgId: s.org_id }, 'server.offline', s.id);
    }
    const taskCutoff = new Date(Date.now() - config.TASK_TIMEOUT_SECONDS * 1000).toISOString();
    await run("UPDATE tasks SET status = 'timeout', finished_at = ? WHERE status = 'dispatched' AND dispatched_at < ?", now(), taskCutoff);
    await run("DELETE FROM metrics_history WHERE ts < ?", new Date(Date.now() - 7 * 86400 * 1000).toISOString());
  }

  // Replace {"$secret": name} with decrypted values, scoped to the server's org. Returns [params, secretValues].
  async function resolveSecrets(params, orgId) {
    const values = [];
    const out = {};
    for (const [k, v] of Object.entries(params)) {
      if (v && typeof v === 'object' && v.$secret) {
        const row = await one('SELECT * FROM secrets WHERE name = ? AND org_id = ?', v.$secret, orgId);
        if (!row) throw new Error(`Secret not found: ${v.$secret}`);
        const plain = sec.decrypt(row);
        values.push(plain);
        out[k] = plain;
      } else out[k] = v;
    }
    return [out, values];
  }
  const redact = (text, values) => values.reduce((t, v) => (v ? t.split(v).join('***') : t), text);

  // ------------------------------------------------------------------ auth middleware
  function requireUser(minRole = 'viewer') {
    return async (req, ctx) => {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const payload = m && sec.verifyJwt(m[1]);
      if (!payload) throw new HttpError(401, 'Not authenticated');
      const user = await one('SELECT * FROM users WHERE id = ?', payload.sub);
      if (!user || user.disabled) throw new HttpError(401, 'Not authenticated');
      if (payload.pwv !== user.password_hash.slice(-12)) throw new HttpError(401, 'Session expired');
      if (!sec.hasRole(user, minRole)) throw new HttpError(403, `Requires role ${minRole}`);
      ctx.user = user;
      // Platform admins may act within any organization by selecting it with the X-Org-Id header.
      let orgId = user.org_id;
      const selected = req.headers['x-org-id'];
      if (selected && selected !== user.org_id) {
        if (!user.platform_admin) throw new HttpError(403, 'Không có quyền truy cập tổ chức này');
        const org = await one('SELECT * FROM organizations WHERE id = ?', String(selected));
        if (!org) throw new HttpError(404, 'Tổ chức không tồn tại');
        orgId = org.id;
      }
      ctx.orgId = orgId;
    };
  }
  const requirePlatformAdmin = async (req, ctx) => {
    if (!ctx.user?.platform_admin) throw new HttpError(403, 'Chỉ quản trị nền tảng mới được thực hiện');
  };
  async function requireAgent(req, ctx) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const server = m && await one('SELECT * FROM servers WHERE agent_token_hash = ?', sec.sha256(m[1]));
    if (!server) throw new HttpError(401, 'Invalid agent token');
    ctx.server = server;
    ctx.orgId = server.org_id;
  }
  const issueToken = (user) => sec.signJwt({ sub: user.id, role: user.role, pwv: user.password_hash.slice(-12) });

  function checkPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Mật khẩu phải có ít nhất 10 ký tự');
  }
  const validEmail = (e) => /^[^@\s]+@[^@\s]+$/.test(e);

  // ------------------------------------------------------------------ setup & auth
  r.get('/api/health', async () => ({ ok: true, time: now() }));
  r.get('/api/setup/status', async () => ({
    needs_setup: (await one('SELECT COUNT(*) AS n FROM users')).n === 0,
    setup_token_required: !!config.SETUP_TOKEN,
  }));
  r.post('/api/setup', async (req, ctx) => {
    if ((await one('SELECT COUNT(*) AS n FROM users')).n > 0) throw new HttpError(409, 'Already set up');
    if (config.SERVERLESS && !config.SETUP_TOKEN) throw new HttpError(503, 'SETUP_TOKEN chưa được cấu hình trên server');
    if (config.SETUP_TOKEN && !sec.safeEqual(ctx.body.setup_token || '', config.SETUP_TOKEN)) {
      await audit(ctx, 'setup.rejected', null);
      throw new HttpError(403, 'Mã khởi tạo không đúng');
    }
    const { name, password } = ctx.body;
    const email = String(ctx.body.email || '').trim().toLowerCase();
    const orgName = String(ctx.body.org_name || '').trim() || 'Công ty của tôi';
    if (!validEmail(email)) throw new HttpError(400, 'Email không hợp lệ');
    checkPassword(password);
    const orgId = sec.newId('org');
    await run('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)', orgId, orgName, now());
    const user = { id: sec.newId('usr'), org_id: orgId, email, name: name || email, password_hash: sec.hashPassword(password), role: 'owner', platform_admin: 1, created_at: now() };
    await run('INSERT INTO users (id, org_id, email, name, password_hash, role, platform_admin, created_at) VALUES (?,?,?,?,?,?,?,?)',
      user.id, user.org_id, user.email, user.name, user.password_hash, user.role, 1, user.created_at);
    ctx.user = user; ctx.orgId = orgId;
    await audit(ctx, 'setup.owner_created', user.id, { org: orgName });
    return { token: issueToken(user), user: publicUser(user) };
  });

  r.post('/api/auth/login', async (req, ctx) => {
    const { password } = ctx.body;
    const email = String(ctx.body.email || '').trim().toLowerCase();
    const key = `${ctx.ip}|${email}`;
    const windowStart = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const rec = await one('SELECT * FROM login_attempts WHERE key = ?', key);
    const recent = rec && rec.first_at > windowStart;
    if (recent && rec.count >= 10) throw new HttpError(429, 'Quá nhiều lần đăng nhập sai, thử lại sau 15 phút');
    const user = email && await one('SELECT * FROM users WHERE email = ?', email);
    const orgOk = user && (user.platform_admin || !(await one('SELECT disabled FROM organizations WHERE id = ?', user.org_id))?.disabled);
    const ok = user && !user.disabled && orgOk && sec.verifyPassword(password || '', user.password_hash);
    if (!ok) {
      if (recent) await run('UPDATE login_attempts SET count = count + 1 WHERE key = ?', key);
      else if (rec) await run('UPDATE login_attempts SET count = 1, first_at = ? WHERE key = ?', now(), key);
      else await run('INSERT INTO login_attempts (key, count, first_at) VALUES (?, 1, ?)', key, now());
      if (user) ctx.orgId = user.org_id; // attribute the failed attempt to the real account's org
      await audit(ctx, 'auth.login_failed', user?.id ?? null, { email });
      throw new HttpError(401, 'Sai email hoặc mật khẩu');
    }
    if (rec) await run('DELETE FROM login_attempts WHERE key = ?', key);
    await run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), user.id);
    ctx.user = user; ctx.orgId = user.org_id;
    await audit(ctx, 'auth.login', user.id);
    return { token: issueToken(user), user: publicUser(user) };
  });

  async function meResponse(ctx) {
    const org = await one('SELECT id, name FROM organizations WHERE id = ?', ctx.user.org_id);
    const res = { user: publicUser(ctx.user), org, plan: config.PLAN };
    if (ctx.user.platform_admin) {
      res.organizations = await all('SELECT id, name, disabled FROM organizations ORDER BY created_at');
    }
    return res;
  }
  r.get('/api/auth/me', requireUser(), async (req, ctx) => meResponse(ctx));
  r.post('/api/auth/change-password', requireUser(), async (req, ctx) => {
    const { current_password, new_password } = ctx.body;
    if (!sec.verifyPassword(current_password || '', ctx.user.password_hash)) throw new HttpError(400, 'Mật khẩu hiện tại không đúng');
    checkPassword(new_password);
    await run('UPDATE users SET password_hash = ? WHERE id = ?', sec.hashPassword(new_password), ctx.user.id);
    await audit(ctx, 'auth.password_changed', ctx.user.id);
    const user = await one('SELECT * FROM users WHERE id = ?', ctx.user.id);
    return { token: issueToken(user) };
  });

  // ------------------------------------------------------------------ organizations (platform admin)
  r.get('/api/orgs', requireUser('admin'), requirePlatformAdmin, async () => {
    const orgs = await all('SELECT * FROM organizations ORDER BY created_at');
    const counts = await all('SELECT org_id, COUNT(*) AS n FROM servers GROUP BY org_id');
    const users = await all('SELECT org_id, COUNT(*) AS n FROM users GROUP BY org_id');
    const cmap = Object.fromEntries(counts.map((c) => [c.org_id, c.n]));
    const umap = Object.fromEntries(users.map((c) => [c.org_id, c.n]));
    return { organizations: orgs.map((o) => ({ id: o.id, name: o.name, disabled: !!o.disabled, created_at: o.created_at, servers: cmap[o.id] || 0, users: umap[o.id] || 0 })) };
  });
  r.post('/api/orgs', requireUser('admin'), requirePlatformAdmin, async (req, ctx) => {
    const name = String(ctx.body.name || '').trim();
    if (!name) throw new HttpError(400, 'Cần tên công ty');
    const id = sec.newId('org');
    await run('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)', id, name, now());
    await audit(ctx, 'org.created', id, { name });
    // optionally create the org's first admin account
    const adminEmail = String(ctx.body.admin_email || '').trim().toLowerCase();
    if (adminEmail) {
      if (!validEmail(adminEmail)) throw new HttpError(400, 'Email quản trị không hợp lệ');
      checkPassword(ctx.body.admin_password);
      if (await one('SELECT id FROM users WHERE email = ?', adminEmail)) throw new HttpError(409, 'Email quản trị đã tồn tại');
      const uid = sec.newId('usr');
      await run('INSERT INTO users (id, org_id, email, name, password_hash, role, platform_admin, created_at) VALUES (?,?,?,?,?,?,?,?)',
        uid, id, adminEmail, ctx.body.admin_name || adminEmail, sec.hashPassword(ctx.body.admin_password), 'owner', 0, now());
      await audit(ctx, 'user.created', uid, { email: adminEmail, role: 'owner', org: id });
    }
    return { organization: { id, name } };
  });
  r.patch('/api/orgs/:id', requireUser('admin'), requirePlatformAdmin, async (req, ctx) => {
    const org = await one('SELECT * FROM organizations WHERE id = ?', ctx.params.id);
    if (!org) throw new HttpError(404, 'Tổ chức không tồn tại');
    const { name, disabled } = ctx.body;
    await run('UPDATE organizations SET name = COALESCE(?, name), disabled = COALESCE(?, disabled) WHERE id = ?',
      name ?? null, disabled === undefined ? null : (disabled ? 1 : 0), org.id);
    await audit(ctx, 'org.updated', org.id, { name, disabled });
    return { ok: true };
  });

  // ------------------------------------------------------------------ users (scoped to current org)
  r.get('/api/users', requireUser('admin'), async (req, ctx) => ({
    users: (await all('SELECT * FROM users WHERE org_id = ? ORDER BY created_at', ctx.orgId)).map(publicUser),
  }));
  r.post('/api/users', requireUser('admin'), async (req, ctx) => {
    const { name, password, role = 'viewer' } = ctx.body;
    const email = String(ctx.body.email || '').trim().toLowerCase();
    if (!validEmail(email)) throw new HttpError(400, 'Email không hợp lệ');
    if (!sec.ROLES.includes(role)) throw new HttpError(400, 'Vai trò không hợp lệ');
    if (sec.roleRank(role) > sec.roleRank(ctx.user.role)) throw new HttpError(403, 'Không thể cấp vai trò cao hơn vai trò của bạn');
    checkPassword(password);
    if (await one('SELECT id FROM users WHERE email = ?', email)) throw new HttpError(409, 'Email đã tồn tại');
    const id = sec.newId('usr');
    await run('INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)', id, ctx.orgId, email, name || email, sec.hashPassword(password), role, now());
    await audit(ctx, 'user.created', id, { email, role });
    return { user: publicUser(await one('SELECT * FROM users WHERE id = ?', id)) };
  });
  r.patch('/api/users/:id', requireUser('admin'), async (req, ctx) => {
    const target = await one('SELECT * FROM users WHERE id = ? AND org_id = ?', ctx.params.id, ctx.orgId);
    if (!target) throw new HttpError(404, 'User not found');
    if (sec.roleRank(target.role) > sec.roleRank(ctx.user.role)) throw new HttpError(403, 'Không thể sửa người có vai trò cao hơn');
    const { name, role, disabled, password } = ctx.body;
    if (role !== undefined) {
      if (!sec.ROLES.includes(role)) throw new HttpError(400, 'Vai trò không hợp lệ');
      if (sec.roleRank(role) > sec.roleRank(ctx.user.role)) throw new HttpError(403, 'Không thể cấp vai trò cao hơn vai trò của bạn');
    }
    const demotingOwner = target.role === 'owner' && ((role && role !== 'owner') || disabled);
    if (demotingOwner && (await one("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0 AND org_id = ?", ctx.orgId)).n <= 1) {
      throw new HttpError(400, 'Phải còn ít nhất một owner');
    }
    if (password !== undefined) checkPassword(password);
    await run('UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), disabled = COALESCE(?, disabled), password_hash = COALESCE(?, password_hash) WHERE id = ?',
      name ?? null, role ?? null, disabled === undefined ? null : (disabled ? 1 : 0), password ? sec.hashPassword(password) : null, target.id);
    await audit(ctx, 'user.updated', target.id, { name, role, disabled, password_reset: !!password });
    return { user: publicUser(await one('SELECT * FROM users WHERE id = ?', target.id)) };
  });

  // ------------------------------------------------------------------ overview
  r.get('/api/overview', requireUser(), async (req, ctx) => {
    const servers = await all('SELECT status, COUNT(*) AS n FROM servers WHERE org_id = ? GROUP BY status', ctx.orgId);
    const alerts = await all("SELECT severity, COUNT(*) AS n FROM alerts WHERE org_id = ? AND status != 'resolved' GROUP BY severity", ctx.orgId);
    const tasks = await all("SELECT status, COUNT(*) AS n FROM tasks WHERE org_id = ? AND created_at > ? GROUP BY status", ctx.orgId, new Date(Date.now() - 86400000).toISOString());
    const toMap = (rows, k) => Object.fromEntries(rows.map((x) => [x[k], x.n]));
    return {
      plan: config.PLAN, server_limit: Number.isFinite(PLAN_LIMITS[config.PLAN]) ? PLAN_LIMITS[config.PLAN] : null,
      servers: toMap(servers, 'status'), alerts: toMap(alerts, 'severity'), tasks_24h: toMap(tasks, 'status'),
      recent_tasks: (await all('SELECT * FROM tasks WHERE org_id = ? ORDER BY created_at DESC LIMIT 10', ctx.orgId)).map((t) => publicTask(t)),
    };
  });

  // ------------------------------------------------------------------ servers
  const getServer = (id, orgId) => one('SELECT * FROM servers WHERE id = ? AND org_id = ?', id, orgId);
  r.get('/api/servers', requireUser(), async (req, ctx) => ({ servers: (await all('SELECT * FROM servers WHERE org_id = ? ORDER BY name', ctx.orgId)).map(publicServer) }));
  r.get('/api/servers/:id', requireUser(), async (req, ctx) => {
    const s = await getServer(ctx.params.id, ctx.orgId);
    if (!s) throw new HttpError(404, 'Server not found');
    const history = await all('SELECT ts, cpu, mem, disk, load1 FROM metrics_history WHERE server_id = ? AND ts > ? ORDER BY ts',
      s.id, new Date(Date.now() - 6 * 3600 * 1000).toISOString());
    return { server: publicServer(s), history };
  });
  r.patch('/api/servers/:id', requireUser('operator'), async (req, ctx) => {
    const s = await getServer(ctx.params.id, ctx.orgId);
    if (!s) throw new HttpError(404, 'Server not found');
    const { name, tags, allow_shell } = ctx.body;
    if (allow_shell !== undefined && !sec.hasRole(ctx.user, 'admin')) throw new HttpError(403, 'Requires role admin');
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string'))) throw new HttpError(400, 'tags must be a string array');
    await run('UPDATE servers SET name = COALESCE(?, name), tags = COALESCE(?, tags), allow_shell = COALESCE(?, allow_shell) WHERE id = ?',
      name ?? null, tags ? JSON.stringify(tags) : null, allow_shell === undefined ? null : (allow_shell ? 1 : 0), s.id);
    await audit(ctx, 'server.updated', s.id, { name, tags, allow_shell });
    return { server: publicServer(await getServer(s.id, ctx.orgId)) };
  });
  r.delete('/api/servers/:id', requireUser('admin'), async (req, ctx) => {
    const s = await getServer(ctx.params.id, ctx.orgId);
    if (!s) throw new HttpError(404, 'Server not found');
    await run('DELETE FROM servers WHERE id = ?', s.id); // revokes the agent token
    await audit(ctx, 'server.removed', s.id, { name: s.name });
    return { ok: true };
  });

  // ------------------------------------------------------------------ enrollment
  r.get('/api/enrollment-tokens', requireUser('admin'), async (req, ctx) => ({
    tokens: (await all('SELECT id, name, tags, created_by, created_at, expires_at, used_at, server_id FROM enrollment_tokens WHERE org_id = ? ORDER BY created_at DESC LIMIT 100', ctx.orgId))
      .map((t) => ({ ...t, tags: parseJson(t.tags, []) })),
  }));
  r.post('/api/enrollment-tokens', requireUser('admin'), async (req, ctx) => {
    const { name, tags = [] } = ctx.body;
    if (!name || typeof name !== 'string') throw new HttpError(400, 'Cần đặt tên cho server');
    const limit = PLAN_LIMITS[config.PLAN] ?? Infinity;
    if ((await one('SELECT COUNT(*) AS n FROM servers WHERE org_id = ?', ctx.orgId)).n >= limit) throw new HttpError(402, `Gói ${config.PLAN} chỉ cho phép tối đa ${limit} server`);
    const token = sec.randomToken('enr');
    const id = sec.newId('enr');
    const expires = new Date(Date.now() + config.ENROLL_TOKEN_TTL_SECONDS * 1000).toISOString();
    await run('INSERT INTO enrollment_tokens (id, org_id, token_hash, name, tags, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
      id, ctx.orgId, sec.sha256(token), name, JSON.stringify(tags), ctx.user.id, now(), expires);
    await audit(ctx, 'enrollment.token_created', id, { name });
    const base = baseUrl(req);
    return {
      id, token, expires_at: expires,
      install_command: `curl -fsSL ${base}/agent/install.sh | sudo bash -s -- --server ${base} --token ${token}`,
      install_command_windows: `iwr ${base}/agent/install.ps1 -UseBasicParsing | iex; Install-InfraAgent -Server '${base}' -Token '${token}'`,
    };
  });
  r.delete('/api/enrollment-tokens/:id', requireUser('admin'), async (req, ctx) => {
    await run('DELETE FROM enrollment_tokens WHERE id = ? AND org_id = ? AND used_at IS NULL', ctx.params.id, ctx.orgId);
    await audit(ctx, 'enrollment.token_revoked', ctx.params.id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ actions & tasks
  r.get('/api/actions', requireUser(), async () => ({ actions: ACTIONS }));

  r.post('/api/servers/:id/tasks', requireUser(), async (req, ctx) => {
    const s = await getServer(ctx.params.id, ctx.orgId);
    if (!s) throw new HttpError(404, 'Server not found');
    const { action, params = {}, confirm = false } = ctx.body;
    const spec = ACTIONS[action];
    if (!spec) throw new HttpError(400, `Unknown action: ${action}`);
    if (spec.internal) throw new HttpError(400, 'Thao tác này chỉ được tạo qua chức năng chuyên biệt');
    if (spec.platforms && !spec.platforms.includes(s.platform || 'linux')) throw new HttpError(400, `Thao tác này không hỗ trợ ${s.platform}`);
    if (!sec.hasRole(ctx.user, spec.minRole)) throw new HttpError(403, `Thao tác này cần vai trò ${spec.minRole}`);
    if (spec.destructive && confirm !== true) throw new HttpError(400, 'Thao tác nguy hiểm: cần xác nhận (confirm: true)');
    if (spec.requiresShell && !s.allow_shell) throw new HttpError(403, 'Server này chưa bật quyền chạy shell');
    let clean;
    try { clean = validateParams(action, params); } catch (e) { if (e instanceof ValidationError) throw new HttpError(400, e.message); throw e; }
    for (const v of Object.values(clean)) {
      if (v && v.$secret && !await one('SELECT id FROM secrets WHERE name = ? AND org_id = ?', v.$secret, ctx.orgId)) throw new HttpError(400, `Không tìm thấy secret: ${v.$secret}`);
    }
    if (s.status === 'pending') throw new HttpError(409, 'Agent chưa kết nối');
    const id = sec.newId('tsk');
    await run('INSERT INTO tasks (id, org_id, server_id, action, params, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, ctx.orgId, s.id, action, JSON.stringify(clean), 'queued', ctx.user.email, now());
    await audit(ctx, 'task.created', id, { server: s.name, action, params: clean });
    return { task: publicTask(await one('SELECT * FROM tasks WHERE id = ?', id)) };
  });
  r.get('/api/servers/:id/tasks', requireUser(), async (req, ctx) => {
    const s = await getServer(ctx.params.id, ctx.orgId);
    if (!s) throw new HttpError(404, 'Server not found');
    return { tasks: (await all('SELECT * FROM tasks WHERE server_id = ? ORDER BY created_at DESC LIMIT 50', s.id)).map((t) => publicTask(t)) };
  });
  r.get('/api/tasks', requireUser(), async (req, ctx) => ({ tasks: (await all('SELECT * FROM tasks WHERE org_id = ? ORDER BY created_at DESC LIMIT 100', ctx.orgId)).map((t) => publicTask(t)) }));
  r.get('/api/tasks/:id', requireUser(), async (req, ctx) => {
    const t = await one('SELECT * FROM tasks WHERE id = ? AND org_id = ?', ctx.params.id, ctx.orgId);
    if (!t) throw new HttpError(404, 'Task not found');
    return { task: publicTask(t, { full: true }) };
  });
  r.post('/api/tasks/:id/cancel', requireUser('operator'), async (req, ctx) => {
    const res = await run("UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE id = ? AND org_id = ? AND status = 'queued'", now(), ctx.params.id, ctx.orgId);
    if (!res.changes) throw new HttpError(409, 'Chỉ huỷ được lệnh đang chờ');
    await audit(ctx, 'task.cancelled', ctx.params.id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ network scan & devices
  async function assertSecret(name, orgId) {
    if (!await one('SELECT id FROM secrets WHERE name = ? AND org_id = ?', name, orgId)) throw new HttpError(400, `Không tìm thấy secret: ${name}`);
  }

  // Trigger a network scan from an enrolled Linux agent.
  r.post('/api/servers/:id/scan', requireUser('operator'), async (req, ctx) => {
    const s = await getServer(ctx.params.id, ctx.orgId);
    if (!s) throw new HttpError(404, 'Server not found');
    if (!['linux', 'windows'].includes(s.platform || 'linux')) throw new HttpError(400, 'Chỉ quét được từ agent Linux hoặc Windows');
    if (s.status === 'pending') throw new HttpError(409, 'Agent chưa kết nối');
    const { targets = '', ports = '', deep = false, snmp_secret } = ctx.body;
    const params = {};
    if (targets) params.targets = targets;
    if (ports) params.ports = ports;
    if (deep) params.deep = true;
    if (snmp_secret) { await assertSecret(snmp_secret, ctx.orgId); params.snmp_community = { $secret: snmp_secret }; }
    let clean;
    try { clean = validateParams('net.scan', params); } catch (e) { if (e instanceof ValidationError) throw new HttpError(400, e.message); throw e; }
    const id = sec.newId('tsk');
    await run('INSERT INTO tasks (id, org_id, server_id, action, params, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, ctx.orgId, s.id, 'net.scan', JSON.stringify(clean), 'queued', ctx.user.email, now());
    await audit(ctx, 'task.created', id, { server: s.name, action: 'net.scan', params: { ...clean, snmp_community: snmp_secret ? '***' : undefined } });
    return { task: publicTask(await one('SELECT * FROM tasks WHERE id = ?', id)) };
  });

  r.get('/api/devices', requireUser(), async (req, ctx) => {
    const subnet = ctx.query.get('subnet');
    const status = ctx.query.get('status');
    const where = ['org_id = ?'];
    const args = [ctx.orgId];
    if (subnet) { where.push('subnet = ?'); args.push(subnet); }
    if (status) { where.push('status = ?'); args.push(status); }
    const rows = await all(`SELECT * FROM scanned_devices WHERE ${where.join(' AND ')} ORDER BY subnet, ip`, ...args);
    return { devices: rows.map(publicDevice) };
  });

  // Network topology model: subnets (optionally grouped by VLAN) with the devices in each.
  r.get('/api/topology', requireUser(), async (req, ctx) => {
    const subnets = await all('SELECT * FROM network_subnets WHERE org_id = ? ORDER BY cidr', ctx.orgId);
    const devices = (await all('SELECT * FROM scanned_devices WHERE org_id = ? ORDER BY ip', ctx.orgId)).map(publicDevice);
    const bySubnet = {};
    for (const d of devices) (bySubnet[d.subnet] = bySubnet[d.subnet] || []).push(d);
    const nodes = subnets.map((sn) => ({
      cidr: sn.cidr, vlan: sn.vlan, gateway_ip: sn.gateway_ip, scanner_server_id: sn.scanner_server_id,
      device_count: sn.device_count, last_scan: sn.last_scan, devices: bySubnet[sn.cidr] || [],
    }));
    // group subnets by VLAN for multi-VLAN infrastructures
    const vlans = {};
    for (const n of nodes) { const k = n.vlan || '—'; (vlans[k] = vlans[k] || []).push(n.cidr); }
    return { subnets: nodes, vlans, device_total: devices.length };
  });

  r.delete('/api/devices/:id', requireUser('operator'), async (req, ctx) => {
    const res = await run('DELETE FROM scanned_devices WHERE id = ? AND org_id = ?', ctx.params.id, ctx.orgId);
    if (!res.changes) throw new HttpError(404, 'Không tìm thấy thiết bị');
    await audit(ctx, 'device.removed', ctx.params.id);
    return { ok: true };
  });

  // Store a credential the admin typed inline as a short-lived vault secret, so it flows through
  // the normal encrypt + redact pipeline. It is deleted automatically when the task finishes.
  async function transientSecret(orgId, actor, value) {
    const name = `__conn_${sec.randomToken('').replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}`;
    const enc = sec.encrypt(value);
    await run('INSERT INTO secrets (id, org_id, name, description, ciphertext, iv, tag, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      sec.newId('sec'), orgId, name, 'thông tin đăng nhập tạm thời (tự xoá)', enc.ciphertext, enc.iv, enc.tag, actor, now(), now());
    return name;
  }

  // Manage the agent on a discovered device over SSH from a scanner agent: install (and register
  // the new server) or uninstall. Credentials are typed inline or taken from the vault.
  r.post('/api/devices/:id/connect', requireUser('admin'), async (req, ctx) => {
    const dev = await one('SELECT * FROM scanned_devices WHERE id = ? AND org_id = ?', ctx.params.id, ctx.orgId);
    if (!dev) throw new HttpError(404, 'Không tìm thấy thiết bị');
    if (!dev.ip) throw new HttpError(400, 'Thiết bị chưa có địa chỉ IP để kết nối');
    const b = ctx.body;
    const operation = b.operation === 'uninstall' ? 'uninstall' : 'install';
    if (b.confirm !== true) throw new HttpError(400, 'Thao tác thay đổi thiết bị: cần xác nhận (confirm: true)');
    const osName = b.os === 'windows' ? 'windows' : 'linux';
    let scanner = null;
    if (b.scanner_server_id) {
      scanner = await getServer(b.scanner_server_id, ctx.orgId);
    } else {
      // Pick any online agent (Linux or Windows) that can install remotely. Prefer a Linux
      // runner for a Linux target (SSH key/password) and a Windows runner for a Windows target
      // (WinRM), falling back to whatever online runner can do it.
      const candidates = await all("SELECT * FROM servers WHERE org_id = ? AND status = 'online' ORDER BY last_seen_at DESC", ctx.orgId);
      const canInstall = candidates.filter((s) => {
        let caps = s.agent_capabilities;
        if (typeof caps === 'string') { try { caps = JSON.parse(caps); } catch { caps = []; } }
        return Array.isArray(caps) && caps.includes('net.remote_install');
      });
      scanner = canInstall.find((s) => (s.platform || 'linux') === osName) || canInstall[0] || null;
    }
    if (!scanner) throw new HttpError(400, 'Cần một agent (Linux hoặc Windows) đang online và hỗ trợ cài từ xa để thực hiện');
    if (scanner.status === 'pending') throw new HttpError(409, 'Agent quét chưa kết nối');

    // resolve credentials: inline password/key -> transient secret; else named vault secret
    let passRef = null;
    let keyRef = null;
    if (typeof b.ssh_password === 'string' && b.ssh_password) passRef = await transientSecret(ctx.orgId, ctx.user.email, b.ssh_password);
    else if (b.ssh_password_secret) { await assertSecret(b.ssh_password_secret, ctx.orgId); passRef = b.ssh_password_secret; }
    if (typeof b.ssh_key === 'string' && b.ssh_key) keyRef = await transientSecret(ctx.orgId, ctx.user.email, b.ssh_key);
    else if (b.ssh_key_secret) { await assertSecret(b.ssh_key_secret, ctx.orgId); keyRef = b.ssh_key_secret; }

    const base = { host: dev.ip, os: osName, ssh_user: b.ssh_user || 'root', ssh_port: Number(b.ssh_port) || 22, server_url: baseUrl(req) };
    if (passRef) base.ssh_password = { $secret: passRef };
    if (keyRef) base.ssh_key = { $secret: keyRef };

    let action; let params;
    if (operation === 'install') {
      // mint a one-time enrollment token so the remote agent can enrol itself
      const token = sec.randomToken('enr');
      const srvName = String(b.name || dev.hostname || dev.ip);
      const expires = new Date(Date.now() + config.ENROLL_TOKEN_TTL_SECONDS * 1000).toISOString();
      await run('INSERT INTO enrollment_tokens (id, org_id, token_hash, name, tags, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
        sec.newId('enr'), ctx.orgId, sec.sha256(token), srvName, JSON.stringify(['scanned', dev.subnet].filter(Boolean)), ctx.user.id, now(), expires);
      action = 'net.remote_install';
      params = { ...base, enroll_token: token };
    } else {
      action = 'net.remote_uninstall';
      params = { ...base, purge: b.purge === true };
    }
    let clean;
    try { clean = validateParams(action, params); } catch (e) { if (e instanceof ValidationError) throw new HttpError(400, e.message); throw e; }
    const id = sec.newId('tsk');
    await run('INSERT INTO tasks (id, org_id, server_id, action, params, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, ctx.orgId, scanner.id, action, JSON.stringify(clean), 'queued', ctx.user.email, now());
    await run('UPDATE scanned_devices SET status = ? WHERE id = ?', operation === 'install' ? 'connecting' : 'discovered', dev.id);
    await audit(ctx, operation === 'install' ? 'device.connect' : 'device.uninstall', dev.id, { host: dev.ip, scanner: scanner.name, os: osName });
    return { task: publicTask(await one('SELECT * FROM tasks WHERE id = ?', id)), scanner_server_id: scanner.id };
  });

  // ------------------------------------------------------------------ security assessments & report
  r.get('/api/assessments', requireUser(), async (req, ctx) => {
    const servers = await all('SELECT id, name, platform, status FROM servers WHERE org_id = ? ORDER BY name', ctx.orgId);
    const rows = await all('SELECT * FROM assessments WHERE org_id = ? ORDER BY created_at DESC', ctx.orgId);
    const latest = {};
    for (const a of rows) if (!latest[a.server_id]) latest[a.server_id] = a;
    const list = servers.map((s) => ({ server: { id: s.id, name: s.name, platform: s.platform || 'linux', status: s.status }, assessment: latest[s.id] ? publicAssessment(latest[s.id]) : null }));
    const scored = list.filter((x) => x.assessment && typeof x.assessment.score === 'number');
    const sum = (f) => scored.reduce((a, b) => a + (f(b.assessment) || 0), 0);
    const summary = {
      servers: servers.length, assessed: scored.length,
      avg_score: scored.length ? Math.round(scored.reduce((a, b) => a + b.assessment.score, 0) / scored.length) : null,
      critical: sum((a) => a.counts.critical), high: sum((a) => a.counts.high), medium: sum((a) => a.counts.medium), low: sum((a) => a.counts.low),
    };
    return { assessments: list, summary };
  });
  r.get('/api/servers/:id/assessment', requireUser(), async (req, ctx) => {
    const s = await getServer(ctx.params.id, ctx.orgId);
    if (!s) throw new HttpError(404, 'Server not found');
    const a = await one('SELECT * FROM assessments WHERE server_id = ? ORDER BY created_at DESC LIMIT 1', s.id);
    const history = await all('SELECT id, score, counts, created_at FROM assessments WHERE server_id = ? ORDER BY created_at DESC LIMIT 20', s.id);
    return { assessment: publicAssessment(a), history: history.map((h) => ({ id: h.id, score: h.score, counts: parseJson(h.counts, {}), created_at: h.created_at })) };
  });

  const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  r.get('/api/report', requireUser(), async (req, ctx) => {
    const org = await one('SELECT name FROM organizations WHERE id = ?', ctx.orgId);
    const servers = await all('SELECT id, name, platform FROM servers WHERE org_id = ? ORDER BY name', ctx.orgId);
    const rows = await all('SELECT * FROM assessments WHERE org_id = ? ORDER BY created_at DESC', ctx.orgId);
    const latest = {};
    for (const a of rows) if (!latest[a.server_id]) latest[a.server_id] = publicAssessment(a);
    const sevLabel = { critical: 'Nghiêm trọng', high: 'Cao', medium: 'Trung bình', low: 'Thấp' };
    const now2 = new Date().toISOString();
    const scored = servers.filter((s) => latest[s.id] && typeof latest[s.id].score === 'number');
    const avg = scored.length ? Math.round(scored.reduce((a, s) => a + latest[s.id].score, 0) / scored.length) : null;
    let body = `<h1>Báo cáo đánh giá an toàn hạ tầng</h1>
      <p class="meta">Công ty: <strong>${esc(org?.name)}</strong> · Lập lúc: ${esc(new Date(now2).toLocaleString('vi-VN'))} · Số server: ${servers.length} · Điểm trung bình: ${avg ?? '—'}/100</p>`;
    for (const s of servers) {
      const a = latest[s.id];
      body += `<section><h2>${esc(s.name)} <span class="plat">${esc(s.platform || 'linux')}</span></h2>`;
      if (!a) { body += '<p class="muted">Chưa đánh giá.</p></section>'; continue; }
      const inv = a.inventory || {};
      body += `<p class="score score-${a.score < 60 ? 'bad' : a.score < 80 ? 'warn' : 'ok'}">Điểm an toàn: ${a.score}/100</p>
        <p class="meta">OS: ${esc(inv.os || '—')} · Kernel: ${esc(inv.kernel || '—')} · Phần mềm: ${esc(inv.packages_count ?? '—')} · Đánh giá: ${esc(new Date(a.created_at).toLocaleString('vi-VN'))}</p>`;
      if (!a.findings.length) body += '<p class="muted">Không phát hiện vấn đề.</p>';
      else {
        body += '<table><thead><tr><th>Mức</th><th>Vấn đề</th><th>Chi tiết</th><th>Khuyến nghị khắc phục</th></tr></thead><tbody>';
        for (const f of a.findings.sort((x, y) => ({ critical: 0, high: 1, medium: 2, low: 3 }[x.severity] - { critical: 0, high: 1, medium: 2, low: 3 }[y.severity]))) {
          body += `<tr class="sev-${esc(f.severity)}"><td>${esc(sevLabel[f.severity] || f.severity)}</td><td>${esc(f.title)}</td><td>${esc(f.detail)}</td><td>${esc(f.remediation)}${f.fix ? ` <em>(có thể tự khắc phục)</em>` : ''}</td></tr>`;
        }
        body += '</tbody></table>';
      }
      body += '</section>';
    }
    const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Báo cáo an toàn — ${esc(org?.name)}</title>
      <style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1a1a1a}
      h1{font-size:22px}h2{font-size:17px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}
      .plat{font-size:11px;background:#eef;padding:2px 6px;border-radius:4px;color:#335}
      .meta{color:#666;font-size:13px}.muted{color:#888}
      .score{font-weight:700}.score-bad{color:#c0262c}.score-warn{color:#b8860b}.score-ok{color:#1a7f37}
      table{border-collapse:collapse;width:100%;font-size:13px;margin-top:8px}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
      th{background:#f6f6f6}tr.sev-critical td:first-child{color:#c0262c;font-weight:700}tr.sev-high td:first-child{color:#d65a00;font-weight:600}
      </style></head><body>${body}
      <footer class="meta" style="margin-top:32px;border-top:1px solid #ddd;padding-top:8px">Tạo tự động bởi nền tảng quản lý hạ tầng.</footer></body></html>`;
    return { html, generated_at: now2, filename: `bao-cao-an-toan-${(org?.name || 'infra').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}-${now2.slice(0, 10)}.html` };
  });

  // ------------------------------------------------------------------ secrets vault
  r.get('/api/secrets', requireUser('operator'), async (req, ctx) => ({
    secrets: await all('SELECT id, name, description, created_by, created_at, updated_at FROM secrets WHERE org_id = ? ORDER BY name', ctx.orgId),
  }));
  r.post('/api/secrets', requireUser('admin'), async (req, ctx) => {
    const { name, value, description } = ctx.body;
    if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new HttpError(400, 'Tên secret chỉ gồm chữ, số, . _ -');
    if (typeof value !== 'string' || !value) throw new HttpError(400, 'Thiếu giá trị');
    const enc = sec.encrypt(value);
    const existing = await one('SELECT id FROM secrets WHERE name = ? AND org_id = ?', name, ctx.orgId);
    if (existing) {
      await run('UPDATE secrets SET ciphertext = ?, iv = ?, tag = ?, description = COALESCE(?, description), updated_at = ? WHERE id = ?',
        enc.ciphertext, enc.iv, enc.tag, description ?? null, now(), existing.id);
      await audit(ctx, 'secret.rotated', name);
    } else {
      await run('INSERT INTO secrets (id, org_id, name, description, ciphertext, iv, tag, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        sec.newId('sec'), ctx.orgId, name, description ?? null, enc.ciphertext, enc.iv, enc.tag, ctx.user.email, now(), now());
      await audit(ctx, 'secret.created', name);
    }
    return { ok: true };
  });
  r.delete('/api/secrets/:name', requireUser('admin'), async (req, ctx) => {
    await run('DELETE FROM secrets WHERE name = ? AND org_id = ?', ctx.params.name, ctx.orgId);
    await audit(ctx, 'secret.deleted', ctx.params.name);
    return { ok: true };
  });

  // ------------------------------------------------------------------ alerts & audit
  r.get('/api/alerts', requireUser(), async (req, ctx) => {
    const status = ctx.query.get('status');
    const rows = status
      ? await all('SELECT a.*, s.name AS server_name FROM alerts a LEFT JOIN servers s ON s.id = a.server_id WHERE a.org_id = ? AND a.status = ? ORDER BY a.updated_at DESC LIMIT 200', ctx.orgId, status)
      : await all("SELECT a.*, s.name AS server_name FROM alerts a LEFT JOIN servers s ON s.id = a.server_id WHERE a.org_id = ? AND a.status != 'resolved' ORDER BY a.updated_at DESC LIMIT 200", ctx.orgId);
    return { alerts: rows };
  });
  for (const [verb, status] of [['ack', 'acknowledged'], ['resolve', 'resolved']]) {
    r.post(`/api/alerts/:id/${verb}`, requireUser('operator'), async (req, ctx) => {
      const res = await run('UPDATE alerts SET status = ?, updated_at = ?, acknowledged_by = ? WHERE id = ? AND org_id = ?', status, now(), ctx.user.email, ctx.params.id, ctx.orgId);
      if (!res.changes) throw new HttpError(404, 'Alert not found');
      await audit(ctx, `alert.${verb}`, ctx.params.id);
      return { ok: true };
    });
  }
  r.get('/api/audit', requireUser('admin'), async (req, ctx) => {
    const limit = Math.min(Number(ctx.query.get('limit')) || 200, 1000);
    return { entries: (await all('SELECT * FROM audit_log WHERE org_id = ? ORDER BY id DESC LIMIT ?', ctx.orgId, limit)).map((e) => ({ ...e, details: parseJson(e.details) })) };
  });

  // ------------------------------------------------------------------ agent protocol
  async function applyAgentReport(server, body) {
    const facts = body.facts && typeof body.facts === 'object' ? body.facts : null;
    const m = body.metrics && typeof body.metrics === 'object' ? body.metrics : null;
    const wasOffline = server.status !== 'online';
    await run(`UPDATE servers SET status = 'online', last_seen_at = ?, metrics = COALESCE(?, metrics), facts = COALESCE(?, facts),
         hostname = COALESCE(?, hostname), os = COALESCE(?, os), ip = COALESCE(?, ip), platform = COALESCE(?, platform), agent_version = COALESCE(?, agent_version),
         agent_capabilities = COALESCE(?, agent_capabilities) WHERE id = ?`,
      now(), m ? JSON.stringify(m) : null, facts ? JSON.stringify(facts) : null,
      facts?.hostname ?? null, facts?.os ?? null, facts?.primary_ip ?? null, (body.platform === 'windows' || body.platform === 'linux') ? body.platform : null, body.version ?? null,
      Array.isArray(body.capabilities) ? JSON.stringify(body.capabilities) : null, server.id);
    if (m) {
      await run('INSERT INTO metrics_history (server_id, ts, cpu, mem, disk, load1) VALUES (?,?,?,?,?,?)',
        server.id, now(), m.cpu_percent ?? null, m.mem_percent ?? null, m.disk_percent ?? null, m.load1 ?? null);
      await evaluateMetrics(server, m);
    }
    if (wasOffline) await resolveAlert(`${server.id}:offline`);
  }

  // Ingest a net.scan result: upsert discovered devices and subnets for the scanner's org,
  // linking devices to already-managed servers by IP match.
  async function ingestScan(server, result) {
    if (!result || typeof result !== 'object') return;
    const orgId = server.org_id;
    const managed = await all('SELECT id, ip FROM servers WHERE org_id = ?', orgId);
    const byIp = Object.fromEntries(managed.filter((s) => s.ip).map((s) => [s.ip, s.id]));
    const devices = Array.isArray(result.devices) ? result.devices : [];
    for (const d of devices) {
      if (!d || typeof d !== 'object' || (!d.ip && !d.mac)) continue;
      const dkey = (typeof d.mac === 'string' && d.mac) ? d.mac.toLowerCase() : `${d.subnet || ''}|${d.ip || ''}`;
      const linkedServer = d.ip && byIp[d.ip] ? byIp[d.ip] : null;
      const status = linkedServer ? 'managed' : 'discovered';
      const ports = Array.isArray(d.open_ports) ? JSON.stringify(d.open_ports.slice(0, 64)) : '[]';
      const snmp = d.snmp && typeof d.snmp === 'object' ? JSON.stringify(d.snmp) : null;
      await run(
        `INSERT INTO scanned_devices (id, org_id, dkey, scanner_server_id, ip, mac, vendor, hostname, device_type, subnet, vlan, open_ports, snmp, is_gateway, managed_server_id, status, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (org_id, dkey) DO UPDATE SET
           scanner_server_id = excluded.scanner_server_id, ip = excluded.ip, mac = COALESCE(excluded.mac, scanned_devices.mac),
           vendor = COALESCE(excluded.vendor, scanned_devices.vendor), hostname = COALESCE(excluded.hostname, scanned_devices.hostname),
           device_type = excluded.device_type, subnet = excluded.subnet, vlan = COALESCE(excluded.vlan, scanned_devices.vlan),
           open_ports = excluded.open_ports, snmp = COALESCE(excluded.snmp, scanned_devices.snmp), is_gateway = excluded.is_gateway,
           managed_server_id = COALESCE(excluded.managed_server_id, scanned_devices.managed_server_id),
           status = CASE WHEN excluded.managed_server_id IS NOT NULL THEN 'managed'
                         WHEN scanned_devices.status = 'connecting' THEN 'connecting' ELSE excluded.status END,
           last_seen = excluded.last_seen`,
        sec.newId('dev'), orgId, dkey, server.id, d.ip ?? null, d.mac ?? null, d.vendor ?? null, d.hostname ?? null,
        d.device_type ?? null, d.subnet ?? null, d.vlan ?? null, ports, snmp, d.is_gateway ? 1 : 0, linkedServer, status, now(), now());
    }
    const subnets = Array.isArray(result.subnets) ? result.subnets : [];
    for (const sn of subnets) {
      if (!sn || !sn.cidr) continue;
      const count = devices.filter((d) => d.subnet === sn.cidr).length;
      await run(
        `INSERT INTO network_subnets (id, org_id, cidr, vlan, gateway_ip, scanner_server_id, device_count, last_scan)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (org_id, cidr) DO UPDATE SET vlan = COALESCE(excluded.vlan, network_subnets.vlan),
           gateway_ip = COALESCE(excluded.gateway_ip, network_subnets.gateway_ip),
           scanner_server_id = excluded.scanner_server_id, device_count = excluded.device_count, last_scan = excluded.last_scan`,
        sec.newId('net'), orgId, sn.cidr, sn.vlan ?? null, sn.gateway_ip ?? null, server.id, count, now());
    }
    await audit({ orgId, server }, 'net.scan_ingested', server.id, { devices: devices.length, subnets: subnets.length });
  }

  r.post('/api/agent/enroll', async (req, ctx) => {
    const { token } = ctx.body;
    const t = token && await one('SELECT * FROM enrollment_tokens WHERE token_hash = ?', sec.sha256(token));
    if (!t || t.used_at || t.expires_at < now()) {
      await audit(ctx, 'agent.enroll_rejected', null);
      throw new HttpError(401, 'Enrollment token không hợp lệ, đã dùng hoặc đã hết hạn');
    }
    const agentToken = sec.randomToken('agt');
    const id = sec.newId('srv');
    const claimed = await run('UPDATE enrollment_tokens SET used_at = ?, server_id = ? WHERE id = ? AND used_at IS NULL', now(), id, t.id);
    if (!claimed.changes) throw new HttpError(401, 'Enrollment token đã được sử dụng');
    const platform = (ctx.body.platform === 'windows') ? 'windows' : 'linux';
    await run('INSERT INTO servers (id, org_id, name, platform, tags, agent_token_hash, status, created_at, enrolled_by) VALUES (?,?,?,?,?,?,?,?,?)',
      id, t.org_id, t.name, platform, t.tags, sec.sha256(agentToken), 'pending', now(), t.created_by);
    const server = await one('SELECT * FROM servers WHERE id = ?', id);
    await applyAgentReport(server, ctx.body);
    ctx.server = server; ctx.orgId = t.org_id;
    await audit(ctx, 'agent.enrolled', id, { hostname: ctx.body.facts?.hostname, platform });
    return { server_id: id, agent_token: agentToken, poll_interval: POLL_INTERVAL };
  });

  r.post('/api/agent/heartbeat', requireAgent, async (req, ctx) => {
    await applyAgentReport(ctx.server, ctx.body);
    const queued = await all("SELECT * FROM tasks WHERE server_id = ? AND status = 'queued' ORDER BY created_at LIMIT 5", ctx.server.id);
    const tasks = [];
    for (const t of queued) {
      try {
        const [params] = await resolveSecrets(parseJson(t.params, {}), ctx.server.org_id);
        const claimed = await run("UPDATE tasks SET status = 'dispatched', dispatched_at = ? WHERE id = ? AND status = 'queued'", now(), t.id);
        if (!claimed.changes) continue;
        tasks.push({ id: t.id, action: t.action, params });
      } catch (e) {
        await run("UPDATE tasks SET status = 'failed', finished_at = ?, output = ? WHERE id = ?", now(), String(e.message), t.id);
      }
    }
    return { poll_interval: tasks.length ? 2 : POLL_INTERVAL, tasks };
  });

  r.post('/api/agent/tasks/:id/result', requireAgent, async (req, ctx) => {
    const t = await one('SELECT * FROM tasks WHERE id = ? AND server_id = ?', ctx.params.id, ctx.server.id);
    if (!t) throw new HttpError(404, 'Task not found');
    if (t.status !== 'dispatched') throw new HttpError(409, `Task is ${t.status}`);
    const { status, exit_code, output, result } = ctx.body;
    if (!['succeeded', 'failed', 'rejected'].includes(status)) throw new HttpError(400, 'Invalid status');
    let secretValues = [];
    try { [, secretValues] = await resolveSecrets(parseJson(t.params, {}), ctx.server.org_id); } catch { /* secret deleted meanwhile */ }
    const out = redact(String(output ?? '').slice(-MAX_OUTPUT), secretValues);
    const res = result === undefined ? null : redact(JSON.stringify(result), secretValues).slice(0, MAX_OUTPUT);
    await run('UPDATE tasks SET status = ?, exit_code = ?, output = ?, result = ?, finished_at = ? WHERE id = ?',
      status, Number.isInteger(exit_code) ? exit_code : null, out, res, now(), t.id);
    await audit(ctx, 'task.finished', t.id, { action: t.action, status, exit_code });
    if (t.action === 'net.scan' && status === 'succeeded' && result) {
      try { await ingestScan(ctx.server, result); } catch (e) { console.error('ingestScan failed', e); }
    }
    if ((t.action === 'net.remote_install' || t.action === 'net.remote_uninstall')) {
      // delete any one-off credential secrets minted for this task
      for (const v of Object.values(parseJson(t.params, {}))) {
        if (v && typeof v === 'object' && typeof v.$secret === 'string' && v.$secret.startsWith('__conn_')) {
          await run('DELETE FROM secrets WHERE name = ? AND org_id = ?', v.$secret, ctx.server.org_id).catch(() => {});
        }
      }
      const host = result && result.host;
      if (host && t.action === 'net.remote_install' && result.installed) {
        await run("UPDATE scanned_devices SET status = 'managed' WHERE org_id = ? AND ip = ?", ctx.server.org_id, host);
      } else if (host && t.action === 'net.remote_uninstall' && result.uninstalled) {
        await run("UPDATE scanned_devices SET status = 'discovered', managed_server_id = NULL WHERE org_id = ? AND ip = ?", ctx.server.org_id, host);
      }
    }
    if (t.action === 'security.deep_audit' && status === 'succeeded' && result && Array.isArray(result.findings)) {
      await run('INSERT INTO assessments (id, org_id, server_id, score, counts, findings, inventory, created_at) VALUES (?,?,?,?,?,?,?,?)',
        sec.newId('asm'), ctx.server.org_id, ctx.server.id, Number.isInteger(result.score) ? result.score : null,
        JSON.stringify(result.counts || {}), JSON.stringify(result.findings).slice(0, 512 * 1024), result.inventory ? JSON.stringify(result.inventory) : null, now());
      const crit = (result.counts && result.counts.critical) || 0;
      const key = `${ctx.server.id}:risk`;
      if (crit > 0) await upsertAlert(ctx.server.org_id, ctx.server.id, key, 'critical', 'security', `${ctx.server.name}: ${crit} lỗ hổng nghiêm trọng (điểm an toàn ${result.score}/100)`);
      else if (typeof result.score === 'number' && result.score < 60) await upsertAlert(ctx.server.org_id, ctx.server.id, key, 'warning', 'security', `${ctx.server.name}: điểm an toàn thấp (${result.score}/100)`);
      else await resolveAlert(key);
    }
    if (t.action === 'security.audit' && result && Array.isArray(result.findings)) {
      const high = result.findings.filter((f) => f.severity === 'high');
      const key = `${ctx.server.id}:audit`;
      if (high.length) await upsertAlert(ctx.server.org_id, ctx.server.id, key, 'warning', 'security', `Kiểm tra bảo mật ${ctx.server.name}: ${high.length} vấn đề mức cao`);
      else await resolveAlert(key);
    }
    return { ok: true };
  });

  // ------------------------------------------------------------------ static: agent files & web UI
  const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.py': 'text/x-python; charset=utf-8', '.sh': 'text/x-shellscript; charset=utf-8', '.ps1': 'text/plain; charset=utf-8' };
  function serveFile(res, root, rel, extraHeaders = {}) {
    const file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS, ...extraHeaders });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  const AGENT_FILES = new Set(['install.sh', 'install.ps1', 'infra_agent.py', 'infra_agent.ps1']);

  // ------------------------------------------------------------------ request handler
  // Serverless has no background timer: run housekeeping opportunistically, at most every 30s per instance.
  let lastTick = 0;
  function maybeTick() {
    if (Date.now() - lastTick < 30000) return null;
    lastTick = Date.now();
    return tick().catch((e) => console.error('tick failed', e));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const ctx = { ip: clientIp(req), query: url.searchParams, params: {}, body: {} };
    try {
      if (url.pathname.startsWith('/api/')) {
        if (config.CORS_ORIGIN) {
          res.setHeader('Access-Control-Allow-Origin', config.CORS_ORIGIN);
          res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Org-Id');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        }
        if (req.method === 'OPTIONS') return send(res, 204, '');
        const m = r.match(req.method, url.pathname);
        if (!m) throw new HttpError(404, 'Not found');
        if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
        ctx.params = m.params;
        if (config.SERVERLESS) await maybeTick();
        if (['POST', 'PATCH', 'DELETE'].includes(req.method)) ctx.body = await readJson(req);
        if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new HttpError(400, 'Body must be a JSON object');
        let result;
        for (const h of m.route.handlers) result = await h(req, ctx);
        return send(res, 200, result ?? { ok: true });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (url.pathname.startsWith('/agent/')) {
        const base = path.basename(url.pathname);
        if (AGENT_FILES.has(base) && serveFile(res, AGENT_DIR, base)) return;
        throw new HttpError(404, 'Not found');
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname;
      if (serveFile(res, WEB_DIR, rel)) return;
      if (!path.extname(url.pathname) && serveFile(res, WEB_DIR, 'index.html')) return; // SPA fallback
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, details: err.details });
      console.error(err);
      return send(res, 500, { error: 'Internal server error' });
    }
  }

  return { handle, tick };
}

module.exports = { createApp };
