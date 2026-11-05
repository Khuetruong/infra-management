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

  // ------------------------------------------------------------------ helpers
  const { one, all, run } = db;

  async function audit(ctx, action, target, details) {
    const actor = ctx.user ? { type: 'user', id: ctx.user.id, label: ctx.user.email }
      : ctx.server ? { type: 'agent', id: ctx.server.id, label: ctx.server.name }
      : { type: 'system', id: null, label: 'system' };
    await run('INSERT INTO audit_log (ts, actor_type, actor_id, actor_label, action, target, details, ip) VALUES (?,?,?,?,?,?,?,?)',
      now(), actor.type, actor.id, actor.label, action, target ?? null, details ? JSON.stringify(details) : null, ctx.ip ?? null);
  }

  const publicUser = (u) => u && ({ id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, created_at: u.created_at, last_login_at: u.last_login_at });
  const publicServer = (s) => s && ({
    id: s.id, name: s.name, hostname: s.hostname, ip: s.ip, os: s.os, tags: parseJson(s.tags, []),
    agent_version: s.agent_version, agent_capabilities: parseJson(s.agent_capabilities, []),
    allow_shell: !!s.allow_shell, status: s.status, last_seen_at: s.last_seen_at,
    metrics: parseJson(s.metrics), facts: parseJson(s.facts), created_at: s.created_at,
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

  async function upsertAlert(serverId, key, severity, type, message) {
    const existing = await one("SELECT * FROM alerts WHERE dedupe_key = ? AND status != 'resolved'", key);
    if (existing) {
      if (existing.severity !== severity || existing.message !== message) {
        await run('UPDATE alerts SET severity = ?, message = ?, updated_at = ? WHERE id = ?', severity, message, now(), existing.id);
      }
      return;
    }
    await run('INSERT INTO alerts (id, server_id, dedupe_key, severity, type, message, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      sec.newId('alr'), serverId, key, severity, type, message, 'open', now(), now());
  }
  async function resolveAlert(key) {
    await run("UPDATE alerts SET status = 'resolved', updated_at = ? WHERE dedupe_key = ? AND status != 'resolved'", now(), key);
  }

  async function evaluateMetrics(server, m) {
    const checks = [
      ['cpu', m.cpu_percent, 90, 97, 'CPU'],
      ['mem', m.mem_percent, 90, 97, 'RAM'],
      ['disk', m.disk_percent, 80, 92, 'Ổ đĩa'],
    ];
    for (const [k, value, warn, crit, label] of checks) {
      const key = `${server.id}:${k}`;
      if (typeof value !== 'number') continue;
      if (value >= crit) await upsertAlert(server.id, key, 'critical', k, `${label} ${value.toFixed(0)}% trên ${server.name}`);
      else if (value >= warn) await upsertAlert(server.id, key, 'warning', k, `${label} ${value.toFixed(0)}% trên ${server.name}`);
      else await resolveAlert(key);
    }
    const sk = `${server.id}:security_updates`;
    if (typeof m.security_updates === 'number' && m.security_updates > 0) {
      await upsertAlert(server.id, sk, 'warning', 'security', `${m.security_updates} bản vá bảo mật chưa cài trên ${server.name}`);
    } else if (m.security_updates === 0) await resolveAlert(sk);
    const rk = `${server.id}:reboot_required`;
    if (m.reboot_required) await upsertAlert(server.id, rk, 'info', 'reboot', `${server.name} cần khởi động lại để áp dụng cập nhật`);
    else await resolveAlert(rk);
  }

  // Periodic housekeeping: mark silent agents offline, time out stuck tasks, trim history.
  async function tick() {
    const cutoff = new Date(Date.now() - config.AGENT_OFFLINE_AFTER_SECONDS * 1000).toISOString();
    for (const s of await all("SELECT * FROM servers WHERE status = 'online' AND last_seen_at < ?", cutoff)) {
      await run("UPDATE servers SET status = 'offline' WHERE id = ?", s.id);
      await upsertAlert(s.id, `${s.id}:offline`, 'critical', 'offline', `Mất kết nối với agent trên ${s.name}`);
      await audit({}, 'server.offline', s.id);
    }
    const taskCutoff = new Date(Date.now() - config.TASK_TIMEOUT_SECONDS * 1000).toISOString();
    await run("UPDATE tasks SET status = 'timeout', finished_at = ? WHERE status = 'dispatched' AND dispatched_at < ?", now(), taskCutoff);
    await run("DELETE FROM metrics_history WHERE ts < ?", new Date(Date.now() - 7 * 86400 * 1000).toISOString());
  }

  // Replace {"$secret": name} with decrypted values. Returns [params, secretValues].
  async function resolveSecrets(params) {
    const values = [];
    const out = {};
    for (const [k, v] of Object.entries(params)) {
      if (v && typeof v === 'object' && v.$secret) {
        const row = await one('SELECT * FROM secrets WHERE name = ?', v.$secret);
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
    };
  }
  async function requireAgent(req, ctx) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const server = m && await one('SELECT * FROM servers WHERE agent_token_hash = ?', sec.sha256(m[1]));
    if (!server) throw new HttpError(401, 'Invalid agent token');
    ctx.server = server;
  }
  const issueToken = (user) => sec.signJwt({ sub: user.id, role: user.role, pwv: user.password_hash.slice(-12) });

  function checkPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Mật khẩu phải có ít nhất 10 ký tự');
  }

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
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'Email không hợp lệ');
    checkPassword(password);
    const user = { id: sec.newId('usr'), email, name: name || email, password_hash: sec.hashPassword(password), role: 'owner', created_at: now() };
    await run('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)', user.id, user.email, user.name, user.password_hash, user.role, user.created_at);
    ctx.user = user;
    await audit(ctx, 'setup.owner_created', user.id);
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
    const ok = user && !user.disabled && sec.verifyPassword(password || '', user.password_hash);
    if (!ok) {
      if (recent) await run('UPDATE login_attempts SET count = count + 1 WHERE key = ?', key);
      else if (rec) await run('UPDATE login_attempts SET count = 1, first_at = ? WHERE key = ?', now(), key);
      else await run('INSERT INTO login_attempts (key, count, first_at) VALUES (?, 1, ?)', key, now());
      await audit(ctx, 'auth.login_failed', null, { email });
      throw new HttpError(401, 'Sai email hoặc mật khẩu');
    }
    if (rec) await run('DELETE FROM login_attempts WHERE key = ?', key);
    await run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), user.id);
    ctx.user = user;
    await audit(ctx, 'auth.login', user.id);
    return { token: issueToken(user), user: publicUser(user) };
  });

  r.get('/api/auth/me', requireUser(), async (req, ctx) => ({ user: publicUser(ctx.user), plan: config.PLAN }));
  r.post('/api/auth/change-password', requireUser(), async (req, ctx) => {
    const { current_password, new_password } = ctx.body;
    if (!sec.verifyPassword(current_password || '', ctx.user.password_hash)) throw new HttpError(400, 'Mật khẩu hiện tại không đúng');
    checkPassword(new_password);
    await run('UPDATE users SET password_hash = ? WHERE id = ?', sec.hashPassword(new_password), ctx.user.id);
    await audit(ctx, 'auth.password_changed', ctx.user.id);
    const user = await one('SELECT * FROM users WHERE id = ?', ctx.user.id);
    return { token: issueToken(user) };
  });

  // ------------------------------------------------------------------ users
  r.get('/api/users', requireUser('admin'), async () => ({ users: (await all('SELECT * FROM users ORDER BY created_at')).map(publicUser) }));
  r.post('/api/users', requireUser('admin'), async (req, ctx) => {
    const { name, password, role = 'viewer' } = ctx.body;
    const email = String(ctx.body.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'Email không hợp lệ');
    if (!sec.ROLES.includes(role)) throw new HttpError(400, 'Vai trò không hợp lệ');
    if (sec.roleRank(role) > sec.roleRank(ctx.user.role)) throw new HttpError(403, 'Không thể cấp vai trò cao hơn vai trò của bạn');
    checkPassword(password);
    if (await one('SELECT id FROM users WHERE email = ?', email)) throw new HttpError(409, 'Email đã tồn tại');
    const id = sec.newId('usr');
    await run('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)', id, email, name || email, sec.hashPassword(password), role, now());
    await audit(ctx, 'user.created', id, { email, role });
    return { user: publicUser(await one('SELECT * FROM users WHERE id = ?', id)) };
  });
  r.patch('/api/users/:id', requireUser('admin'), async (req, ctx) => {
    const target = await one('SELECT * FROM users WHERE id = ?', ctx.params.id);
    if (!target) throw new HttpError(404, 'User not found');
    if (sec.roleRank(target.role) > sec.roleRank(ctx.user.role)) throw new HttpError(403, 'Không thể sửa người có vai trò cao hơn');
    const { name, role, disabled, password } = ctx.body;
    if (role !== undefined) {
      if (!sec.ROLES.includes(role)) throw new HttpError(400, 'Vai trò không hợp lệ');
      if (sec.roleRank(role) > sec.roleRank(ctx.user.role)) throw new HttpError(403, 'Không thể cấp vai trò cao hơn vai trò của bạn');
    }
    const demotingOwner = target.role === 'owner' && ((role && role !== 'owner') || disabled);
    if (demotingOwner && (await one("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0")).n <= 1) {
      throw new HttpError(400, 'Phải còn ít nhất một owner');
    }
    if (password !== undefined) checkPassword(password);
    await run('UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), disabled = COALESCE(?, disabled), password_hash = COALESCE(?, password_hash) WHERE id = ?',
      name ?? null, role ?? null, disabled === undefined ? null : (disabled ? 1 : 0), password ? sec.hashPassword(password) : null, target.id);
    await audit(ctx, 'user.updated', target.id, { name, role, disabled, password_reset: !!password });
    return { user: publicUser(await one('SELECT * FROM users WHERE id = ?', target.id)) };
  });

  // ------------------------------------------------------------------ overview
  r.get('/api/overview', requireUser(), async () => {
    const servers = await all('SELECT status, COUNT(*) AS n FROM servers GROUP BY status');
    const alerts = await all("SELECT severity, COUNT(*) AS n FROM alerts WHERE status != 'resolved' GROUP BY severity");
    const tasks = await all("SELECT status, COUNT(*) AS n FROM tasks WHERE created_at > ? GROUP BY status", new Date(Date.now() - 86400000).toISOString());
    const toMap = (rows, k) => Object.fromEntries(rows.map((x) => [x[k], x.n]));
    return {
      plan: config.PLAN, server_limit: Number.isFinite(PLAN_LIMITS[config.PLAN]) ? PLAN_LIMITS[config.PLAN] : null,
      servers: toMap(servers, 'status'), alerts: toMap(alerts, 'severity'), tasks_24h: toMap(tasks, 'status'),
      recent_tasks: (await all('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 10')).map((t) => publicTask(t)),
    };
  });

  // ------------------------------------------------------------------ servers
  r.get('/api/servers', requireUser(), async () => ({ servers: (await all('SELECT * FROM servers ORDER BY name')).map(publicServer) }));
  r.get('/api/servers/:id', requireUser(), async (req, ctx) => {
    const s = await one('SELECT * FROM servers WHERE id = ?', ctx.params.id);
    if (!s) throw new HttpError(404, 'Server not found');
    const history = await all('SELECT ts, cpu, mem, disk, load1 FROM metrics_history WHERE server_id = ? AND ts > ? ORDER BY ts',
      s.id, new Date(Date.now() - 6 * 3600 * 1000).toISOString());
    return { server: publicServer(s), history };
  });
  r.patch('/api/servers/:id', requireUser('operator'), async (req, ctx) => {
    const s = await one('SELECT * FROM servers WHERE id = ?', ctx.params.id);
    if (!s) throw new HttpError(404, 'Server not found');
    const { name, tags, allow_shell } = ctx.body;
    if (allow_shell !== undefined && !sec.hasRole(ctx.user, 'admin')) throw new HttpError(403, 'Requires role admin');
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string'))) throw new HttpError(400, 'tags must be a string array');
    await run('UPDATE servers SET name = COALESCE(?, name), tags = COALESCE(?, tags), allow_shell = COALESCE(?, allow_shell) WHERE id = ?',
      name ?? null, tags ? JSON.stringify(tags) : null, allow_shell === undefined ? null : (allow_shell ? 1 : 0), s.id);
    await audit(ctx, 'server.updated', s.id, { name, tags, allow_shell });
    return { server: publicServer(await one('SELECT * FROM servers WHERE id = ?', s.id)) };
  });
  r.delete('/api/servers/:id', requireUser('admin'), async (req, ctx) => {
    const s = await one('SELECT * FROM servers WHERE id = ?', ctx.params.id);
    if (!s) throw new HttpError(404, 'Server not found');
    await run('DELETE FROM servers WHERE id = ?', s.id); // revokes the agent token
    await audit(ctx, 'server.removed', s.id, { name: s.name });
    return { ok: true };
  });

  // ------------------------------------------------------------------ enrollment
  r.get('/api/enrollment-tokens', requireUser('admin'), async () => ({
    tokens: (await all('SELECT id, name, tags, created_by, created_at, expires_at, used_at, server_id FROM enrollment_tokens ORDER BY created_at DESC LIMIT 100'))
      .map((t) => ({ ...t, tags: parseJson(t.tags, []) })),
  }));
  r.post('/api/enrollment-tokens', requireUser('admin'), async (req, ctx) => {
    const { name, tags = [] } = ctx.body;
    if (!name || typeof name !== 'string') throw new HttpError(400, 'Cần đặt tên cho server');
    const limit = PLAN_LIMITS[config.PLAN] ?? Infinity;
    if ((await one('SELECT COUNT(*) AS n FROM servers')).n >= limit) throw new HttpError(402, `Gói ${config.PLAN} chỉ cho phép tối đa ${limit} server`);
    const token = sec.randomToken('enr');
    const id = sec.newId('enr');
    const expires = new Date(Date.now() + config.ENROLL_TOKEN_TTL_SECONDS * 1000).toISOString();
    await run('INSERT INTO enrollment_tokens (id, token_hash, name, tags, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
      id, sec.sha256(token), name, JSON.stringify(tags), ctx.user.id, now(), expires);
    await audit(ctx, 'enrollment.token_created', id, { name });
    const base = baseUrl(req);
    return {
      id, token, expires_at: expires,
      install_command: `curl -fsSL ${base}/agent/install.sh | sudo bash -s -- --server ${base} --token ${token}`,
    };
  });
  r.delete('/api/enrollment-tokens/:id', requireUser('admin'), async (req, ctx) => {
    await run('DELETE FROM enrollment_tokens WHERE id = ? AND used_at IS NULL', ctx.params.id);
    await audit(ctx, 'enrollment.token_revoked', ctx.params.id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ actions & tasks
  r.get('/api/actions', requireUser(), async () => ({ actions: ACTIONS }));

  r.post('/api/servers/:id/tasks', requireUser(), async (req, ctx) => {
    const s = await one('SELECT * FROM servers WHERE id = ?', ctx.params.id);
    if (!s) throw new HttpError(404, 'Server not found');
    const { action, params = {}, confirm = false } = ctx.body;
    const spec = ACTIONS[action];
    if (!spec) throw new HttpError(400, `Unknown action: ${action}`);
    if (!sec.hasRole(ctx.user, spec.minRole)) throw new HttpError(403, `Thao tác này cần vai trò ${spec.minRole}`);
    if (spec.destructive && confirm !== true) throw new HttpError(400, 'Thao tác nguy hiểm: cần xác nhận (confirm: true)');
    if (spec.requiresShell && !s.allow_shell) throw new HttpError(403, 'Server này chưa bật quyền chạy shell');
    let clean;
    try { clean = validateParams(action, params); } catch (e) { if (e instanceof ValidationError) throw new HttpError(400, e.message); throw e; }
    for (const v of Object.values(clean)) {
      if (v && v.$secret && !await one('SELECT id FROM secrets WHERE name = ?', v.$secret)) throw new HttpError(400, `Không tìm thấy secret: ${v.$secret}`);
    }
    if (s.status === 'pending') throw new HttpError(409, 'Agent chưa kết nối');
    const id = sec.newId('tsk');
    await run('INSERT INTO tasks (id, server_id, action, params, status, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
      id, s.id, action, JSON.stringify(clean), 'queued', ctx.user.email, now());
    await audit(ctx, 'task.created', id, { server: s.name, action, params: clean });
    return { task: publicTask(await one('SELECT * FROM tasks WHERE id = ?', id)) };
  });
  r.get('/api/servers/:id/tasks', requireUser(), async (req, ctx) => ({
    tasks: (await all('SELECT * FROM tasks WHERE server_id = ? ORDER BY created_at DESC LIMIT 50', ctx.params.id)).map((t) => publicTask(t)),
  }));
  r.get('/api/tasks', requireUser(), async () => ({ tasks: (await all('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100')).map((t) => publicTask(t)) }));
  r.get('/api/tasks/:id', requireUser(), async (req, ctx) => {
    const t = await one('SELECT * FROM tasks WHERE id = ?', ctx.params.id);
    if (!t) throw new HttpError(404, 'Task not found');
    return { task: publicTask(t, { full: true }) };
  });
  r.post('/api/tasks/:id/cancel', requireUser('operator'), async (req, ctx) => {
    const res = await run("UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'", now(), ctx.params.id);
    if (!res.changes) throw new HttpError(409, 'Chỉ huỷ được lệnh đang chờ');
    await audit(ctx, 'task.cancelled', ctx.params.id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ secrets vault
  r.get('/api/secrets', requireUser('operator'), async () => ({
    secrets: await all('SELECT id, name, description, created_by, created_at, updated_at FROM secrets ORDER BY name'),
  }));
  r.post('/api/secrets', requireUser('admin'), async (req, ctx) => {
    const { name, value, description } = ctx.body;
    if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new HttpError(400, 'Tên secret chỉ gồm chữ, số, . _ -');
    if (typeof value !== 'string' || !value) throw new HttpError(400, 'Thiếu giá trị');
    const enc = sec.encrypt(value);
    const existing = await one('SELECT id FROM secrets WHERE name = ?', name);
    if (existing) {
      await run('UPDATE secrets SET ciphertext = ?, iv = ?, tag = ?, description = COALESCE(?, description), updated_at = ? WHERE id = ?',
        enc.ciphertext, enc.iv, enc.tag, description ?? null, now(), existing.id);
      await audit(ctx, 'secret.rotated', name);
    } else {
      await run('INSERT INTO secrets (id, name, description, ciphertext, iv, tag, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        sec.newId('sec'), name, description ?? null, enc.ciphertext, enc.iv, enc.tag, ctx.user.email, now(), now());
      await audit(ctx, 'secret.created', name);
    }
    return { ok: true };
  });
  r.delete('/api/secrets/:name', requireUser('admin'), async (req, ctx) => {
    await run('DELETE FROM secrets WHERE name = ?', ctx.params.name);
    await audit(ctx, 'secret.deleted', ctx.params.name);
    return { ok: true };
  });

  // ------------------------------------------------------------------ alerts & audit
  r.get('/api/alerts', requireUser(), async (req, ctx) => {
    const status = ctx.query.get('status');
    const rows = status
      ? await all('SELECT a.*, s.name AS server_name FROM alerts a LEFT JOIN servers s ON s.id = a.server_id WHERE a.status = ? ORDER BY a.updated_at DESC LIMIT 200', status)
      : await all("SELECT a.*, s.name AS server_name FROM alerts a LEFT JOIN servers s ON s.id = a.server_id WHERE a.status != 'resolved' ORDER BY a.updated_at DESC LIMIT 200");
    return { alerts: rows };
  });
  for (const [verb, status] of [['ack', 'acknowledged'], ['resolve', 'resolved']]) {
    r.post(`/api/alerts/:id/${verb}`, requireUser('operator'), async (req, ctx) => {
      const res = await run('UPDATE alerts SET status = ?, updated_at = ?, acknowledged_by = ? WHERE id = ?', status, now(), ctx.user.email, ctx.params.id);
      if (!res.changes) throw new HttpError(404, 'Alert not found');
      await audit(ctx, `alert.${verb}`, ctx.params.id);
      return { ok: true };
    });
  }
  r.get('/api/audit', requireUser('admin'), async (req, ctx) => {
    const limit = Math.min(Number(ctx.query.get('limit')) || 200, 1000);
    return { entries: (await all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit)).map((e) => ({ ...e, details: parseJson(e.details) })) };
  });

  // ------------------------------------------------------------------ agent protocol
  async function applyAgentReport(server, body) {
    const facts = body.facts && typeof body.facts === 'object' ? body.facts : null;
    const m = body.metrics && typeof body.metrics === 'object' ? body.metrics : null;
    const wasOffline = server.status !== 'online';
    await run(`UPDATE servers SET status = 'online', last_seen_at = ?, metrics = COALESCE(?, metrics), facts = COALESCE(?, facts),
         hostname = COALESCE(?, hostname), os = COALESCE(?, os), ip = COALESCE(?, ip), agent_version = COALESCE(?, agent_version),
         agent_capabilities = COALESCE(?, agent_capabilities) WHERE id = ?`,
      now(), m ? JSON.stringify(m) : null, facts ? JSON.stringify(facts) : null,
      facts?.hostname ?? null, facts?.os ?? null, facts?.primary_ip ?? null, body.version ?? null,
      Array.isArray(body.capabilities) ? JSON.stringify(body.capabilities) : null, server.id);
    if (m) {
      await run('INSERT INTO metrics_history (server_id, ts, cpu, mem, disk, load1) VALUES (?,?,?,?,?,?)',
        server.id, now(), m.cpu_percent ?? null, m.mem_percent ?? null, m.disk_percent ?? null, m.load1 ?? null);
      await evaluateMetrics(server, m);
    }
    if (wasOffline) await resolveAlert(`${server.id}:offline`);
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
    // claim the token atomically so two concurrent enrollments cannot both use it
    const claimed = await run('UPDATE enrollment_tokens SET used_at = ?, server_id = ? WHERE id = ? AND used_at IS NULL', now(), id, t.id);
    if (!claimed.changes) throw new HttpError(401, 'Enrollment token đã được sử dụng');
    await run('INSERT INTO servers (id, name, tags, agent_token_hash, status, created_at, enrolled_by) VALUES (?,?,?,?,?,?,?)',
      id, t.name, t.tags, sec.sha256(agentToken), 'pending', now(), t.created_by);
    const server = await one('SELECT * FROM servers WHERE id = ?', id);
    await applyAgentReport(server, ctx.body);
    ctx.server = server;
    await audit(ctx, 'agent.enrolled', id, { hostname: ctx.body.facts?.hostname });
    return { server_id: id, agent_token: agentToken, poll_interval: POLL_INTERVAL };
  });

  r.post('/api/agent/heartbeat', requireAgent, async (req, ctx) => {
    await applyAgentReport(ctx.server, ctx.body);
    const queued = await all("SELECT * FROM tasks WHERE server_id = ? AND status = 'queued' ORDER BY created_at LIMIT 5", ctx.server.id);
    const tasks = [];
    for (const t of queued) {
      try {
        const [params] = await resolveSecrets(parseJson(t.params, {}));
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
    try { [, secretValues] = await resolveSecrets(parseJson(t.params, {})); } catch { /* secret deleted meanwhile */ }
    const out = redact(String(output ?? '').slice(-MAX_OUTPUT), secretValues);
    const res = result === undefined ? null : redact(JSON.stringify(result), secretValues).slice(0, MAX_OUTPUT);
    await run('UPDATE tasks SET status = ?, exit_code = ?, output = ?, result = ?, finished_at = ? WHERE id = ?',
      status, Number.isInteger(exit_code) ? exit_code : null, out, res, now(), t.id);
    await audit(ctx, 'task.finished', t.id, { action: t.action, status, exit_code });
    if (t.action === 'security.audit' && result && Array.isArray(result.findings)) {
      const high = result.findings.filter((f) => f.severity === 'high');
      const key = `${ctx.server.id}:audit`;
      if (high.length) await upsertAlert(ctx.server.id, key, 'warning', 'security', `Kiểm tra bảo mật ${ctx.server.name}: ${high.length} vấn đề mức cao`);
      else await resolveAlert(key);
    }
    return { ok: true };
  });

  // ------------------------------------------------------------------ static: agent files & web UI
  const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.py': 'text/x-python; charset=utf-8', '.sh': 'text/x-shellscript; charset=utf-8' };
  function serveFile(res, root, rel, extraHeaders = {}) {
    const file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS, ...extraHeaders });
    fs.createReadStream(file).pipe(res);
    return true;
  }

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
          res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
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
      if (url.pathname === '/agent/install.sh' || url.pathname === '/agent/infra_agent.py') {
        if (serveFile(res, AGENT_DIR, path.basename(url.pathname))) return;
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
