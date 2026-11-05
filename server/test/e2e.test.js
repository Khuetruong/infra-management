'use strict';
// End-to-end: control plane in-process + the real Python agent as a subprocess.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileP = promisify(execFile);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-test-'));
process.env.DATA_DIR = tmp;
const { open } = require('../src/db');
const { createApp } = require('../src/app');

const AGENT = path.join(__dirname, '..', '..', 'agent', 'infra_agent.py');
const AGENT_CFG = path.join(tmp, 'agent.json');

let server, base, db, app;
async function api(method, url, body, token, orgId) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(orgId ? { 'X-Org-Id': orgId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
// async: the control plane runs in this same process, so the event loop must stay free
const agent = async (...args) => (await execFileP('python3', ['-I', AGENT, '--config', AGENT_CFG, ...args], { encoding: 'utf8', timeout: 120000 })).stdout;

test.before(async () => {
  db = open(process.env.TEST_DATABASE_URL || path.join(tmp, 'test.db'));
  app = createApp(db);
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('full flow: setup, RBAC, enroll agent, run tasks, secrets redaction, alerts, audit', async () => {
  // first-run setup creates the owner, and only once
  assert.equal((await api('GET', '/api/setup/status')).body.needs_setup, true);
  const setup = await api('POST', '/api/setup', { email: 'owner@example.com', name: 'Owner', password: 'correct horse battery' });
  assert.equal(setup.status, 200);
  const owner = setup.body.token;
  assert.equal((await api('POST', '/api/setup', { email: 'x@example.com', password: 'another long pw' })).status, 409);

  // auth
  assert.equal((await api('POST', '/api/auth/login', { email: 'owner@example.com', password: 'wrong password' })).status, 401);
  assert.equal((await api('GET', '/api/servers')).status, 401);
  assert.equal((await api('GET', '/api/servers', null, 'forged.token.value')).status, 401);

  // a viewer
  assert.equal((await api('POST', '/api/users', { email: 'v@example.com', password: 'viewer password 1', role: 'viewer' }, owner)).status, 200);
  const viewer = (await api('POST', '/api/auth/login', { email: 'v@example.com', password: 'viewer password 1' })).body.token;
  assert.equal((await api('POST', '/api/enrollment-tokens', { name: 'web-1' }, viewer)).status, 403);

  // enrollment
  const enr = await api('POST', '/api/enrollment-tokens', { name: 'web-1', tags: ['prod'] }, owner);
  assert.equal(enr.status, 200);
  assert.match(enr.body.install_command, /install\.sh \| sudo bash -s -- --server .* --token enr_/);
  await assert.rejects(agent('enroll', '--server', base, '--token', enr.body.token), /plain HTTP/);
  await agent('enroll', '--server', base, '--token', enr.body.token, '--insecure-http');
  const cfg = JSON.parse(fs.readFileSync(AGENT_CFG, 'utf8'));
  assert.match(cfg.agent_token, /^agt_/);
  assert.equal(cfg.allow_shell, false);
  assert.equal((fs.statSync(AGENT_CFG).mode & 0o777), 0o600);
  // token is single-use
  assert.equal((await api('POST', '/api/agent/enroll', { token: enr.body.token })).status, 401);

  const servers = (await api('GET', '/api/servers', null, viewer)).body.servers;
  assert.equal(servers.length, 1);
  const srv = servers[0];
  assert.equal(srv.status, 'online');
  assert.equal(srv.name, 'web-1');
  assert.ok(srv.metrics.mem_percent > 0);
  assert.ok(srv.facts.hostname);

  // RBAC + validation on tasks
  assert.equal((await api('POST', `/api/servers/${srv.id}/tasks`, { action: 'service.restart', params: { name: 'nginx' } }, viewer)).status, 403);
  assert.equal((await api('POST', `/api/servers/${srv.id}/tasks`, { action: 'service.restart', params: { name: 'nginx; rm -rf /' } }, owner)).status, 400);
  assert.equal((await api('POST', `/api/servers/${srv.id}/tasks`, { action: 'system.reboot' }, owner)).status, 400, 'destructive needs confirm');
  assert.equal((await api('POST', `/api/servers/${srv.id}/tasks`, { action: 'shell.exec', params: { command: 'id' }, confirm: true }, owner)).status, 403, 'shell off by default');
  assert.equal((await api('POST', `/api/servers/${srv.id}/tasks`, { action: 'not.real' }, owner)).status, 400);

  // queue real tasks, then let the agent pick them up
  const t1 = (await api('POST', `/api/servers/${srv.id}/tasks`, { action: 'system.info' }, viewer)).body.task;
  const t2 = (await api('POST', `/api/servers/${srv.id}/tasks`, { action: 'security.audit' }, owner)).body.task;
  const t3 = (await api('POST', `/api/servers/${srv.id}/tasks`, { action: 'db.backups.list' }, owner)).body.task;
  assert.equal(t1.status, 'queued');

  // server-side flag enabled, but the agent's LOCAL config still refuses shell.exec
  assert.equal((await api('PATCH', `/api/servers/${srv.id}`, { allow_shell: true }, owner)).status, 200);
  const t4 = (await api('POST', `/api/servers/${srv.id}/tasks`, { action: 'shell.exec', params: { command: 'id' }, confirm: true }, owner)).body.task;

  // secrets: value never returned by the API and redacted from output
  assert.equal((await api('POST', '/api/secrets', { name: 'mysql-root', value: 'S3cr3t-Value!' }, owner)).status, 200);
  const list = (await api('GET', '/api/secrets', null, owner)).body.secrets;
  assert.equal(list.length, 1);
  assert.equal(JSON.stringify(list).includes('S3cr3t'), false);
  const t5 = (await api('POST', `/api/servers/${srv.id}/tasks`, { action: 'db.mysql.status', params: { password: { $secret: 'mysql-root' } } }, owner)).body.task;

  // backups dir inside tmp
  cfg.backup_dir = path.join(tmp, 'backups');
  fs.writeFileSync(AGENT_CFG, JSON.stringify(cfg));
  await agent('once');

  const get = async (id) => (await api('GET', `/api/tasks/${id}`, null, owner)).body.task;
  const r1 = await get(t1.id);
  assert.equal(r1.status, 'succeeded', r1.output);
  assert.ok(r1.result.hostname);
  const r2 = await get(t2.id);
  assert.equal(r2.status, 'succeeded', r2.output);
  assert.equal(typeof r2.result.score, 'number');
  assert.ok(Array.isArray(r2.result.findings));
  assert.equal((await get(t3.id)).status, 'succeeded');
  const r4 = await get(t4.id);
  assert.equal(r4.status, 'rejected');
  assert.match(r4.output, /allow_shell=false/);
  const r5 = await get(t5.id);
  assert.ok(['succeeded', 'failed'].includes(r5.status));
  assert.equal(JSON.stringify(r5).includes('S3cr3t-Value!'), false);
  // stored params keep only the reference
  assert.deepEqual(r5.params.password, { $secret: 'mysql-root' });

  // agent auth
  assert.equal((await api('POST', '/api/agent/heartbeat', {}, 'agt_wrong')).status, 401);

  // offline detection raises an alert, heartbeat resolves it
  await db.run("UPDATE servers SET last_seen_at = '2000-01-01T00:00:00.000Z'");
  await app.tick();
  let alerts = (await api('GET', '/api/alerts', null, owner)).body.alerts;
  assert.ok(alerts.some((a) => a.type === 'offline' && a.status === 'open'));
  await agent('once');
  alerts = (await api('GET', '/api/alerts', null, owner)).body.alerts;
  assert.equal(alerts.some((a) => a.type === 'offline'), false);

  // audit log is admin-only and records actions
  assert.equal((await api('GET', '/api/audit', null, viewer)).status, 403);
  const audit = (await api('GET', '/api/audit', null, owner)).body.entries.map((e) => e.action);
  for (const a of ['setup.owner_created', 'auth.login_failed', 'agent.enrolled', 'task.created', 'task.finished', 'secret.created', 'server.offline']) {
    assert.ok(audit.includes(a), `missing audit ${a}`);
  }

  // removing the server revokes its agent
  assert.equal((await api('DELETE', `/api/servers/${srv.id}`, null, owner)).status, 200);
  await assert.rejects(agent('once'));
});

test('multi-tenant: organizations are isolated', async () => {
  // owner from the first test is a platform admin
  const owner = (await api('POST', '/api/auth/login', { email: 'owner@example.com', password: 'correct horse battery' })).body.token;
  const me = (await api('GET', '/api/auth/me', null, owner)).body;
  assert.equal(me.user.platform_admin, true);
  assert.ok(me.org && me.org.id);
  const orgA = me.user.org_id;

  // create a second company with its own owner
  const create = await api('POST', '/api/orgs', { name: 'Công ty B', admin_email: 'b-owner@example.com', admin_password: 'company b password' }, owner);
  assert.equal(create.status, 200);
  const orgB = create.body.organization.id;
  assert.notEqual(orgA, orgB);

  // a non-platform-admin cannot list orgs or cross into another org
  assert.equal((await api('GET', '/api/orgs', null, owner)).body.organizations.length >= 2, true);
  const bOwner = (await api('POST', '/api/auth/login', { email: 'b-owner@example.com', password: 'company b password' })).body.token;
  assert.equal((await api('GET', '/api/orgs', null, bOwner)).status, 403);
  assert.equal((await api('GET', '/api/servers', null, bOwner, orgA)).status, 403, 'non-admin cannot select another org');

  // enroll a server into org B (platform admin selects org B via header)
  const enrB = await api('POST', '/api/enrollment-tokens', { name: 'b-server' }, owner, orgB);
  assert.equal(enrB.status, 200);
  await api('POST', '/api/agent/enroll', { token: enrB.body.token, facts: { hostname: 'bhost' } });

  // org B owner sees exactly their 1 server; org A owner (default org) does NOT see it
  const bServers = (await api('GET', '/api/servers', null, bOwner)).body.servers;
  assert.equal(bServers.length, 1);
  assert.equal(bServers[0].name, 'b-server');
  const aServers = (await api('GET', '/api/servers', null, owner)).body.servers;
  assert.equal(aServers.some((s) => s.name === 'b-server'), false);

  // org B owner cannot open org A's server by id
  const anAServer = aServers[0];
  if (anAServer) assert.equal((await api('GET', `/api/servers/${anAServer.id}`, null, bOwner)).status, 404);

  // secrets are per-org: same name in both orgs is independent
  assert.equal((await api('POST', '/api/secrets', { name: 'shared-name', value: 'A-value' }, owner)).status, 200);
  assert.equal((await api('POST', '/api/secrets', { name: 'shared-name', value: 'B-value' }, bOwner)).status, 200);
  assert.equal((await api('GET', '/api/secrets', null, bOwner)).body.secrets.length, 1);

  // platform admin viewing org B sees org B's users only
  const bUsers = (await api('GET', '/api/users', null, owner, orgB)).body.users;
  assert.equal(bUsers.length, 1);
  assert.equal(bUsers[0].email, 'b-owner@example.com');
});

test('static: web UI and agent files are served, traversal blocked', async () => {
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(base + '/agent/install.sh')).status, 200);
  assert.equal((await fetch(base + '/agent/infra_agent.py')).status, 200);
  assert.equal((await fetch(base + '/agent/../server/data/master.key')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/src/config.js')).status, 404);
});
