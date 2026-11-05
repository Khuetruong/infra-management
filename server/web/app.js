'use strict';
// Infra Control web UI: vanilla JS, no build step. All DOM is built with h(); no innerHTML.

// ------------------------------------------------------------------ utilities
const $app = document.getElementById('app');
const state = { token: null, user: null, actions: null, timers: [] };
try { state.token = localStorage.getItem('token'); } catch { /* storage unavailable */ }

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const svgNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      // platform admins can act within a selected organization
      ...(state.orgId && state.user?.platform_admin && state.orgId !== state.user.org_id ? { 'X-Org-Id': state.orgId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user) { logout(); throw new Error('Phiên đăng nhập đã hết hạn'); }
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

const ROLE_RANK = { viewer: 0, operator: 1, admin: 2, owner: 3 };
const can = (role) => state.user && ROLE_RANK[state.user.role] >= ROLE_RANK[role];
const ROLE_LABEL = { viewer: 'Chỉ xem', operator: 'Vận hành', admin: 'Quản trị', owner: 'Chủ sở hữu' };
const STATUS_LABEL = {
  online: 'Online', offline: 'Mất kết nối', pending: 'Chờ agent', queued: 'Đang chờ', dispatched: 'Đang chạy', succeeded: 'Thành công',
  failed: 'Thất bại', rejected: 'Agent từ chối', timeout: 'Quá thời gian', cancelled: 'Đã huỷ', open: 'Mới', acknowledged: 'Đã nhận', resolved: 'Đã xử lý',
  critical: 'Nghiêm trọng', warning: 'Cảnh báo', info: 'Thông tin', high: 'Cao', medium: 'Trung bình', low: 'Thấp',
};
const CATEGORY_LABEL = { system: 'Hệ thống', service: 'Dịch vụ & log', security: 'Bảo mật', database: 'Cơ sở dữ liệu', network: 'Mạng & hạ tầng', shell: 'Shell (break-glass)' };
const DEVICE_STATUS_LABEL = { discovered: 'Mới phát hiện', connecting: 'Đang kết nối', managed: 'Đã quản lý' };
const badge = (status) => h('span', { class: `badge b-${status}` }, STATUS_LABEL[status] || status);

function ago(iso) {
  if (!iso) return '—';
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${Math.max(sec, 0)} giây trước`;
  if (sec < 3600) return `${Math.round(sec / 60)} phút trước`;
  if (sec < 86400) return `${Math.round(sec / 3600)} giờ trước`;
  return new Date(iso).toLocaleString('vi-VN');
}
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN') : '—');
function bytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function uptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} ngày ${hr} giờ` : `${hr} giờ ${m} phút`;
}
function meter(v, warn = 80, crit = 92) {
  if (v == null) return h('span', { class: 'muted' }, '—');
  const cls = v >= crit ? 'crit' : v >= warn ? 'warn' : '';
  const fill = h('div', { class: `fill ${cls}` });
  fill.style.width = `${Math.min(100, v)}%`;
  return h('div', { class: 'meter' }, h('div', { class: 'bar' }, fill), h('span', { class: 'v' }, `${Math.round(v)}%`));
}

function modal(title, body, { wide = false } = {}) {
  const close = () => back.remove();
  const back = h('div', { class: 'backdrop', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'small', onclick: close, 'aria-label': 'Đóng' }, '✕')),
      body));
  document.body.append(back);
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  back.querySelector('input, select, textarea, button.primary')?.focus();
  return close;
}

function confirmDialog(title, message, { confirmText = 'Xác nhận', typeToConfirm } = {}) {
  return new Promise((resolve) => {
    let input;
    const ok = h('button', { class: 'primary danger', type: 'submit', disabled: !!typeToConfirm }, confirmText);
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); close(); resolve(true); } },
      h('p', {}, message),
      typeToConfirm && [h('label', {}, `Gõ "${typeToConfirm}" để xác nhận`), input = h('input', { oninput: () => { ok.disabled = input.value !== typeToConfirm; } })],
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => { close(); resolve(false); } }, 'Huỷ'), ok));
    const close = modal(title, form);
  });
}

function copyBox(text) {
  return h('div', { class: 'copybox' }, h('pre', {}, text),
    h('button', { onclick: guard(async () => { await navigator.clipboard.writeText(text); toast('Đã sao chép'); }) }, 'Sao chép'));
}

// replaceChildren() would render false/null as text; drop them first
function fill(el, ...children) { el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)); }

function every(ms, fn) { state.timers.push(setInterval(fn, ms)); }
function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }

// ------------------------------------------------------------------ auth screens
function logout() {
  state.token = null; state.user = null;
  try { localStorage.removeItem('token'); } catch { /* ignore */ }
  clearTimers();
  location.hash = '#/';
  boot();
}
function setSession(token, user) {
  state.token = token; state.user = user;
  try { localStorage.setItem('token', token); } catch { /* ignore */ }
}

function authScreen({ setup, setupTokenRequired }) {
  const err = h('div', { class: 'err', role: 'alert' });
  const fields = {
    org_name: h('input', {}),
    name: h('input', { autocomplete: 'name' }),
    email: h('input', { type: 'email', required: true, autocomplete: 'username' }),
    password: h('input', { type: 'password', required: true, minlength: setup ? 10 : null, autocomplete: setup ? 'new-password' : 'current-password' }),
    setup_token: h('input', { type: 'password', required: true }),
  };
  const submit = h('button', { class: 'primary', type: 'submit' }, setup ? 'Tạo tài khoản chủ sở hữu' : 'Đăng nhập');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        const body = { email: fields.email.value, password: fields.password.value,
          ...(setup ? { name: fields.name.value, org_name: fields.org_name.value } : {}),
          ...(setup && setupTokenRequired ? { setup_token: fields.setup_token.value } : {}) };
        const res = await api('POST', setup ? '/api/setup' : '/api/auth/login', body);
        setSession(res.token, res.user);
        boot();
      } catch (ex) { err.textContent = ex.message; } finally { submit.disabled = false; }
    },
  },
  setup && [h('p', { class: 'muted' }, 'Lần đầu khởi chạy: tạo công ty và tài khoản chủ sở hữu (owner) đầu tiên.'), h('label', {}, 'Tên công ty của bạn'), fields.org_name, h('label', {}, 'Họ tên'), fields.name],
  h('label', {}, 'Email'), fields.email,
  h('label', {}, 'Mật khẩu'), fields.password,
  setup && h('div', { class: 'muted' }, 'Tối thiểu 10 ký tự.'),
  setup && setupTokenRequired && [h('label', {}, 'Mã khởi tạo (SETUP_TOKEN)'), fields.setup_token, h('div', { class: 'muted' }, 'Lấy từ biến môi trường SETUP_TOKEN đã đặt khi triển khai.')],
  h('div', { class: 'actions' }, submit), err);

  fill($app, h('div', { class: 'center' },
    h('div', { class: 'panel login' },
      h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Infra Control'),
      form)));
  fields[setup ? 'name' : 'email'].focus();
}

// ------------------------------------------------------------------ app shell & router
const NAV = [
  { path: '/', label: 'Tổng quan' },
  { path: '/servers', label: 'Server' },
  { path: '/network', label: 'Hạ tầng mạng' },
  { path: '/alerts', label: 'Cảnh báo', badge: true },
  { path: '/tasks', label: 'Lịch sử lệnh' },
  { path: '/secrets', label: 'Kho bí mật', role: 'operator' },
  { path: '/users', label: 'Người dùng', role: 'admin' },
  { path: '/orgs', label: 'Công ty', platformAdmin: true },
  { path: '/audit', label: 'Nhật ký audit', role: 'admin' },
  { path: '/account', label: 'Tài khoản' },
];

function orgSwitcher() {
  if (!state.user.platform_admin || !state.orgs || state.orgs.length < 2) {
    return h('div', { class: 'org-name' }, state.orgs ? '' : '', (state.orgs || []).find((o) => o.id === state.orgId)?.name || state.org?.name || '');
  }
  const sel = h('select', { 'aria-label': 'Chọn công ty', onchange: () => {
    state.orgId = sel.value;
    try { localStorage.setItem('orgId', sel.value); } catch { /* ignore */ }
    route();
  } }, state.orgs.map((o) => h('option', { value: o.id, selected: o.id === state.orgId }, o.name + (o.disabled ? ' (tắt)' : ''))));
  return h('div', { class: 'org-switch' }, h('label', {}, 'Công ty'), sel);
}

function shell(content) {
  const path = location.hash.slice(1) || '/';
  const alertCount = h('span', { class: 'badge b-critical', hidden: true });
  api('GET', '/api/alerts').then((r) => {
    const n = r.alerts.filter((a) => a.status === 'open').length;
    if (n) { alertCount.textContent = n; alertCount.hidden = false; }
  }).catch(() => {});
  const nav = h('nav', { class: 'nav' }, NAV.filter((n) => (!n.role || can(n.role)) && (!n.platformAdmin || state.user.platform_admin)).map((n) => {
    const active = n.path === '/' ? path === '/' : path.startsWith(n.path);
    return h('a', { href: `#${n.path}`, class: active ? 'active' : null }, n.label, n.badge && alertCount);
  }));
  fill($app, h('div', { class: 'shell' },
    h('aside', { class: 'side' },
      h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Infra Control'),
      orgSwitcher(),
      nav,
      h('div', { class: 'who' }, h('div', {}, state.user.name), h('div', {}, state.user.email), h('div', {}, ROLE_LABEL[state.user.role], state.user.platform_admin ? ' · Quản trị nền tảng' : ''))),
    h('main', { class: 'main' }, content)));
}

const ROUTES = [
  [/^\/$/, viewOverview],
  [/^\/servers$/, viewServers],
  [/^\/servers\/([^/]+)$/, viewServer],
  [/^\/network$/, viewNetwork],
  [/^\/alerts$/, viewAlerts],
  [/^\/tasks$/, viewTasks],
  [/^\/secrets$/, viewSecrets],
  [/^\/users$/, viewUsers],
  [/^\/orgs$/, viewOrgs],
  [/^\/audit$/, viewAudit],
  [/^\/account$/, viewAccount],
];

async function route() {
  clearTimers();
  const path = location.hash.slice(1) || '/';
  const match = ROUTES.map(([re, fn]) => [re.exec(path), fn]).find(([m]) => m);
  const container = h('div', {}, h('div', { class: 'empty' }, 'Đang tải…'));
  shell(container);
  if (!match) { fill(container, h('div', { class: 'empty' }, 'Không tìm thấy trang')); return; }
  try {
    await match[1](container, ...match[0].slice(1));
  } catch (e) {
    fill(container, h('div', { class: 'panel err' }, e.message));
  }
}

async function boot() {
  if (!state.token) {
    const st = await api('GET', '/api/setup/status');
    authScreen({ setup: st.needs_setup, setupTokenRequired: st.setup_token_required });
    return;
  }
  try {
    const me = await api('GET', '/api/auth/me');
    state.user = me.user;
    state.org = me.org;
    state.orgs = me.organizations || null;
    // restore a previously selected org (platform admin), else default to own org
    let saved = null;
    try { saved = localStorage.getItem('orgId'); } catch { /* ignore */ }
    state.orgId = (me.user.platform_admin && saved && (me.organizations || []).some((o) => o.id === saved)) ? saved : me.user.org_id;
  } catch {
    state.token = null;
    return boot();
  }
  if (!state.actions) state.actions = (await api('GET', '/api/actions')).actions;
  route();
}
window.addEventListener('hashchange', () => { if (state.user) route(); });

// ------------------------------------------------------------------ views
function pageHead(title, ...right) { return h('div', { class: 'page-head' }, h('h1', {}, title), h('div', { class: 'row' }, right)); }

function taskTable(tasks, { showServer = false, servers = {} } = {}) {
  if (!tasks.length) return h('div', { class: 'empty' }, 'Chưa có lệnh nào');
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Thao tác'), showServer && h('th', {}, 'Server'), h('th', {}, 'Trạng thái'), h('th', {}, 'Người tạo'), h('th', {}, 'Thời gian'))),
    h('tbody', {}, tasks.map((t) => h('tr', { class: 'click', onclick: () => showTask(t.id) },
      h('td', {}, t.title || t.action, h('div', { class: 'muted mono' }, t.action)),
      showServer && h('td', {}, servers[t.server_id]?.name || t.server_id),
      h('td', {}, badge(t.status)),
      h('td', {}, t.created_by),
      h('td', {}, ago(t.created_at)))))));
}

async function showTask(id) {
  const body = h('div', {}, 'Đang tải…');
  const close = modal('Kết quả lệnh', body, { wide: true });
  const render = async () => {
    const { task } = await api('GET', `/api/tasks/${id}`);
    const findings = task.result?.findings;
    fill(body, 
      h('dl', { class: 'facts' },
        h('dt', {}, 'Thao tác'), h('dd', {}, `${task.title || ''} `, h('code', {}, task.action)),
        h('dt', {}, 'Trạng thái'), h('dd', {}, badge(task.status), task.exit_code != null ? ` exit ${task.exit_code}` : ''),
        h('dt', {}, 'Tham số'), h('dd', {}, h('code', {}, JSON.stringify(task.params))),
        h('dt', {}, 'Tạo bởi'), h('dd', {}, `${task.created_by}, ${fmtTime(task.created_at)}`),
        h('dt', {}, 'Hoàn tất'), h('dd', {}, fmtTime(task.finished_at))),
      task.status === 'queued' && can('operator') && h('p', {}, h('button', { onclick: guard(async () => { await api('POST', `/api/tasks/${id}/cancel`); toast('Đã huỷ lệnh'); close(); }) }, 'Huỷ lệnh')),
      typeof task.result?.score === 'number' && h('h2', {}, `Điểm bảo mật: ${task.result.score}/100`),
      findings && (findings.length
        ? h('ul', { class: 'findings' }, findings.map((f) => h('li', {}, badge(f.severity), ' ', h('strong', {}, f.title), f.detail ? h('div', { class: 'muted' }, f.detail) : null)))
        : h('p', {}, 'Không phát hiện vấn đề.')),
      h('h3', {}, 'Output'),
      h('pre', {}, task.output || (['queued', 'dispatched'].includes(task.status) ? 'Đang chờ agent…' : '(trống)')));
    return task;
  };
  const task = await render().catch((e) => { fill(body, h('div', { class: 'err' }, e.message)); });
  if (task && ['queued', 'dispatched'].includes(task.status)) {
    const t = setInterval(async () => {
      if (!document.body.contains(body)) return clearInterval(t);
      const cur = await render().catch(() => null);
      if (cur && !['queued', 'dispatched'].includes(cur.status)) clearInterval(t);
    }, 2000);
  }
}

async function viewOverview(el) {
  const draw = async () => {
    const [ov, { servers }, { alerts }] = await Promise.all([api('GET', '/api/overview'), api('GET', '/api/servers'), api('GET', '/api/alerts')]);
    const byId = Object.fromEntries(servers.map((x) => [x.id, x]));
    const total = servers.length;
    const stat = (num, lbl, cls) => h('div', { class: 'panel stat' }, h('div', { class: `num ${cls || ''}` }, num), h('div', { class: 'lbl' }, lbl));
    fill(el, 
      pageHead('Tổng quan', h('span', { class: 'muted' }, `Gói: ${ov.plan}${ov.server_limit ? ` (tối đa ${ov.server_limit} server)` : ''}`)),
      h('div', { class: 'grid cards' },
        stat(total, 'Server'),
        stat(ov.servers.online || 0, 'Đang online'),
        stat(ov.servers.offline || 0, 'Mất kết nối'),
        stat(ov.alerts.critical || 0, 'Cảnh báo nghiêm trọng'),
        stat(ov.alerts.warning || 0, 'Cảnh báo'),
        stat(Object.values(ov.tasks_24h).reduce((a, b) => a + b, 0), 'Lệnh trong 24 giờ')),
      h('div', { class: 'grid two', style: null },
        h('div', { class: 'panel' }, h('h2', {}, 'Cảnh báo đang mở'),
          alerts.length ? h('table', {}, h('tbody', {}, alerts.slice(0, 8).map((a) => h('tr', {}, h('td', {}, badge(a.severity)), h('td', {}, a.message), h('td', { class: 'muted' }, ago(a.updated_at))))))
            : h('div', { class: 'empty' }, 'Không có cảnh báo')),
        h('div', { class: 'panel' }, h('h2', {}, 'Lệnh gần đây'), taskTable(ov.recent_tasks, { showServer: true, servers: byId }))),
      !total && h('div', { class: 'panel', style: null }, h('h2', {}, 'Bắt đầu'),
        h('p', {}, 'Chưa có server nào. Vào mục ', h('a', { href: '#/servers' }, 'Server'), ' và bấm "Thêm server" để lấy lệnh cài agent.')));
    el.querySelectorAll('.grid.two').forEach((g) => { g.style.marginTop = '16px'; });
  };
  await draw();
  every(15000, guard(draw));
}

function addServerDialog(onDone) {
  const name = h('input', { required: true, placeholder: 'vd: web-prod-01' });
  const tags = h('input', { placeholder: 'vd: prod, web (cách nhau bằng dấu phẩy)' });
  const body = h('div', {});
  const form = h('form', {
    onsubmit: guard(async (e) => {
      e.preventDefault();
      const res = await api('POST', '/api/enrollment-tokens', { name: name.value.trim(), tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean) });
      const insecure = res.install_command.includes('--server http://');
      fill(body,
        h('p', {}, 'Token chỉ dùng được một lần, hết hạn lúc ', h('strong', {}, fmtTime(res.expires_at)), '. Chọn hệ điều hành của server:'),
        h('h3', { style: null }, 'Linux (cần root, systemd, python3)'),
        copyBox(res.install_command + (insecure ? ' --insecure-http' : '')),
        h('h3', { style: null }, 'Windows (PowerShell quyền Administrator)'),
        copyBox(res.install_command_windows || ''),
        insecure && h('p', { class: 'err' }, 'Nền tảng đang chạy bằng HTTP. Chỉ dùng cho môi trường thử nghiệm; khi chạy thật hãy đặt HTTPS (TLS_CERT/TLS_KEY hoặc reverse proxy) và PUBLIC_URL.'),
        h('p', { class: 'muted' }, 'Agent chỉ kết nối ra ngoài tới nền tảng, không mở cổng nào trên máy. Cài như một dịch vụ có tên rõ ràng (systemd / Windows Service). Shell tự do bị tắt mặc định.'),
        h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => { close(); onDone(); } }, 'Xong')));
    }),
  }, h('label', {}, 'Tên server'), name, h('label', {}, 'Nhãn'), tags,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Tạo lệnh cài đặt')));
  body.append(form);
  const close = modal('Thêm server', body);
}

async function viewServers(el) {
  const list = h('div', {});
  const draw = async () => {
    const { servers } = await api('GET', '/api/servers');
    fill(list, servers.length ? h('div', { class: 'panel table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Server', 'Trạng thái', 'Hệ điều hành', 'CPU', 'RAM', 'Ổ đĩa', 'Kết nối lần cuối'].map((x) => h('th', {}, x)))),
      h('tbody', {}, servers.map((x) => h('tr', { class: 'click', onclick: () => { location.hash = `#/servers/${x.id}`; } },
        h('td', {}, h('span', { class: `dot ${x.status}` }), h('strong', {}, x.name), h('div', { class: 'muted' }, [x.hostname, x.ip].filter(Boolean).join(' · '), x.tags.length ? ` · ${x.tags.join(', ')}` : '')),
        h('td', {}, badge(x.status)),
        h('td', {}, x.os || '—'),
        h('td', {}, meter(x.metrics?.cpu_percent, 90, 97)),
        h('td', {}, meter(x.metrics?.mem_percent, 90, 97)),
        h('td', {}, meter(x.metrics?.disk_percent)),
        h('td', {}, ago(x.last_seen_at)))))))
      : h('div', { class: 'panel empty' }, 'Chưa có server nào. Bấm "Thêm server" để bắt đầu.'));
  };
  fill(el, pageHead('Server', can('admin') && h('button', { class: 'primary', onclick: () => addServerDialog(guard(draw)) }, '+ Thêm server')), list);
  await draw();
  every(10000, guard(draw));
}

function sparkline(history) {
  const W = 600, H = 70;
  const svg = s('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Biểu đồ CPU, RAM, ổ đĩa 6 giờ qua' });
  if (history.length < 2) return h('div', { class: 'muted' }, 'Chưa đủ dữ liệu để vẽ biểu đồ.');
  for (const key of ['disk', 'mem', 'cpu']) {
    const pts = history.map((p, i) => `${(i / (history.length - 1)) * W},${H - ((p[key] ?? 0) / 100) * (H - 4) - 2}`);
    svg.append(s('path', { d: `M${pts.join('L')}`, class: key, fill: 'none', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
  }
  const legend = h('div', { class: 'legend' }, [['cpu', 'CPU', '--accent'], ['mem', 'RAM', '--warn'], ['disk', 'Ổ đĩa', '--ok']].map(([, l, c]) => {
    const i = h('i'); i.style.background = `var(${c})`; return h('span', {}, i, l);
  }));
  return h('div', {}, svg, legend);
}

function actionForm(server, name, spec, secrets, onQueued) {
  const inputs = {};
  const fields = Object.entries(spec.params).map(([key, p]) => {
    let input;
    if (p.type === 'bool') input = h('input', { type: 'checkbox', checked: p.default === true });
    else if (p.type === 'enum') input = h('select', {}, p.values.map((v) => h('option', { value: v, selected: v === p.default }, v)));
    else if (p.type === 'secret') input = h('select', {}, h('option', { value: '' }, '(không dùng)'), secrets.map((x) => h('option', { value: x.name }, x.name)));
    else if (p.type === 'int') input = h('input', { type: 'number', min: p.min, max: p.max, value: p.default ?? '', required: !!p.required });
    else if (key === 'command') input = h('textarea', { rows: 4, required: true, class: 'mono' });
    else input = h('input', { value: p.default ?? '', required: !!p.required, pattern: p.pattern ? p.pattern.replace(/^\^|\$$/g, '') : null });
    inputs[key] = [input, p];
    return p.type === 'bool'
      ? h('label', { class: 'check' }, input, key)
      : [h('label', {}, key, p.type === 'secret' ? ' (lấy từ kho bí mật)' : '', p.required ? ' *' : ''), input];
  });
  const form = h('form', {
    onsubmit: guard(async (e) => {
      e.preventDefault();
      const params = {};
      for (const [key, [input, p]] of Object.entries(inputs)) {
        if (p.type === 'bool') params[key] = input.checked;
        else if (p.type === 'int') { if (input.value !== '') params[key] = Number(input.value); }
        else if (p.type === 'secret') { if (input.value) params[key] = { $secret: input.value }; }
        else if (input.value !== '') params[key] = input.value;
      }
      let confirm = false;
      if (spec.destructive) {
        confirm = await confirmDialog('Xác nhận thao tác nguy hiểm',
          `"${spec.title}" trên ${server.name} có thể ảnh hưởng tới dịch vụ đang chạy. Thao tác sẽ được ghi vào nhật ký audit.`,
          { confirmText: 'Thực hiện', typeToConfirm: server.name });
        if (!confirm) return;
      }
      const { task } = await api('POST', `/api/servers/${server.id}/tasks`, { action: name, params, confirm });
      close();
      toast('Đã gửi lệnh tới agent');
      onQueued();
      showTask(task.id);
    }),
  }, fields.length ? fields : h('p', { class: 'muted' }, 'Thao tác này không cần tham số.'),
  h('p', { class: 'muted' }, 'Vai trò tối thiểu: ', ROLE_LABEL[spec.minRole], spec.destructive ? ' · thao tác nguy hiểm, cần xác nhận' : ''),
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Chạy')));
  const close = modal(spec.title, form);
}

async function viewServer(el, id) {
  const [{ server, history }, secretsRes] = await Promise.all([
    api('GET', `/api/servers/${id}`),
    can('operator') ? api('GET', '/api/secrets') : Promise.resolve({ secrets: [] }),
  ]);
  const tasksBox = h('div', {});
  const loadTasks = async () => { fill(tasksBox, taskTable((await api('GET', `/api/servers/${id}/tasks`)).tasks)); };
  const m = server.metrics || {};
  const f = server.facts || {};

  const byCat = {};
  const caps = server.agent_capabilities || [];
  for (const [name, spec] of Object.entries(state.actions)) {
    if (spec.internal) continue; // remote install/uninstall: only via the network page
    if (spec.platforms && !spec.platforms.includes(server.platform || 'linux')) continue;
    if (caps.length && !caps.includes(name)) continue; // only what this agent reported it can do
    (byCat[spec.category] ||= []).push([name, spec]);
  }
  const actionsPanel = h('div', { class: 'panel' }, h('h2', {}, 'Thao tác quản trị'),
    server.status === 'pending' ? h('p', { class: 'muted' }, 'Agent chưa kết nối.')
      : Object.entries(byCat).map(([cat, items]) => h('div', { class: 'cat' }, h('h3', {}, CATEGORY_LABEL[cat] || cat),
        h('div', { class: 'action-list' }, items.map(([name, spec]) => {
          const allowed = can(spec.minRole) && (!spec.requiresShell || server.allow_shell);
          const reason = !can(spec.minRole) ? `Cần vai trò ${ROLE_LABEL[spec.minRole]}` : (!allowed ? 'Server chưa bật quyền shell' : spec.title);
          return h('button', { class: `small${spec.destructive ? ' destructive' : ''}`, disabled: !allowed, title: reason,
            onclick: () => actionForm(server, name, spec, secretsRes.secrets, guard(loadTasks)) }, spec.title);
        })))));

  const settings = can('operator') && h('div', { class: 'panel' }, h('h2', {}, 'Cài đặt'),
    h('div', { class: 'row' },
      h('button', { onclick: guard(async () => {
        const name = prompt('Tên mới', server.name);
        if (!name) return;
        await api('PATCH', `/api/servers/${id}`, { name });
        route();
      }) }, 'Đổi tên'),
      h('button', { onclick: guard(async () => {
        const tags = prompt('Nhãn (cách nhau bằng dấu phẩy)', server.tags.join(', '));
        if (tags === null) return;
        await api('PATCH', `/api/servers/${id}`, { tags: tags.split(',').map((t) => t.trim()).filter(Boolean) });
        route();
      }) }, 'Sửa nhãn'),
      can('admin') && h('button', { onclick: guard(async () => {
        const enable = !server.allow_shell;
        if (enable && !(await confirmDialog('Bật shell break-glass', 'Cho phép quản trị viên chạy lệnh shell tự do trên server này. Agent cũng phải bật allow_shell trong file cấu hình cục bộ thì lệnh mới chạy được.', { confirmText: 'Bật' }))) return;
        await api('PATCH', `/api/servers/${id}`, { allow_shell: enable });
        route();
      }) }, server.allow_shell ? 'Tắt shell break-glass' : 'Bật shell break-glass'),
      can('admin') && h('button', { class: 'danger', onclick: guard(async () => {
        if (!(await confirmDialog('Gỡ server', `Gỡ ${server.name} khỏi nền tảng và thu hồi token của agent. Agent trên máy sẽ không kết nối được nữa (gỡ hẳn bằng: systemctl disable --now infra-agent).`, { confirmText: 'Gỡ server', typeToConfirm: server.name }))) return;
        await api('DELETE', `/api/servers/${id}`);
        toast('Đã gỡ server');
        location.hash = '#/servers';
      }) }, 'Gỡ server')),
    h('p', { class: 'muted' }, 'Shell break-glass: ', server.allow_shell ? 'đang bật' : 'đang tắt'));

  fill(el, 
    pageHead(server.name, badge(server.status), h('span', { class: 'muted' }, `Kết nối lần cuối: ${ago(server.last_seen_at)}`)),
    h('div', { class: 'grid two' },
      h('div', { class: 'panel' }, h('h2', {}, 'Tài nguyên'),
        h('dl', { class: 'facts' },
          h('dt', {}, 'CPU'), h('dd', {}, meter(m.cpu_percent, 90, 97)),
          h('dt', {}, 'RAM'), h('dd', {}, meter(m.mem_percent, 90, 97), h('span', { class: 'muted' }, `${bytes(m.mem_used)} / ${bytes(f.mem_total)}`)),
          h('dt', {}, 'Ổ đĩa /'), h('dd', {}, meter(m.disk_percent), h('span', { class: 'muted' }, `${bytes(m.disk_used)} / ${bytes(m.disk_total)}`)),
          h('dt', {}, 'Load'), h('dd', {}, m.load1 != null ? `${m.load1.toFixed(2)} / ${m.load5.toFixed(2)} / ${m.load15.toFixed(2)}` : '—'),
          h('dt', {}, 'Uptime'), h('dd', {}, uptime(m.uptime_seconds)),
          h('dt', {}, 'Bản vá bảo mật'), h('dd', {}, m.security_updates == null ? 'không rõ' : String(m.security_updates)),
          h('dt', {}, 'Cần reboot'), h('dd', {}, m.reboot_required ? 'Có' : 'Không')),
        h('h3', { style: null }, '6 giờ qua'), sparkline(history)),
      h('div', { class: 'panel' }, h('h2', {}, 'Thông tin máy'),
        h('dl', { class: 'facts' },
          h('dt', {}, 'Hostname'), h('dd', {}, f.hostname || '—'),
          h('dt', {}, 'IP'), h('dd', {}, f.primary_ip || '—'),
          h('dt', {}, 'Hệ điều hành'), h('dd', {}, f.os || '—'),
          h('dt', {}, 'Kernel'), h('dd', {}, f.kernel ? `${f.kernel} (${f.arch})` : '—'),
          h('dt', {}, 'CPU'), h('dd', {}, f.cpu_count ? `${f.cpu_count} lõi` : '—'),
          h('dt', {}, 'Trình quản lý gói'), h('dd', {}, f.package_manager || '—'),
          h('dt', {}, 'Firewall'), h('dd', {}, f.firewall || 'không phát hiện'),
          h('dt', {}, 'Agent'), h('dd', {}, server.agent_version || '—'),
          h('dt', {}, 'Nhãn'), h('dd', {}, server.tags.join(', ') || '—'),
          h('dt', {}, 'Thêm lúc'), h('dd', {}, fmtTime(server.created_at))))),
    h('div', { class: 'grid', style: null }, actionsPanel, settings,
      h('div', { class: 'panel' }, h('div', { class: 'row' }, h('h2', {}, 'Lịch sử lệnh')), tasksBox)));
  el.querySelectorAll('.grid').forEach((g, i) => { if (i) g.style.marginTop = '16px'; });
  await loadTasks();
  every(5000, guard(loadTasks));
}

// ------------------------------------------------------------------ network scan & topology
const portsLabel = (ports) => (ports || []).map((p) => (p.service ? `${p.port}/${p.service}` : String(p.port))).join(', ');

function deviceTypeIcon(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('gateway') || t.includes('router')) return '🌐';
  if (t.includes('network')) return '🔀';
  if (t.includes('printer')) return '🖨️';
  if (t.includes('windows')) return '🪟';
  if (t.includes('linux') || t.includes('unix')) return '🐧';
  if (t.includes('virtual')) return '📦';
  if (t.includes('raspberry')) return '🍓';
  if (t.includes('apple') || t.includes('ios')) return '';
  if (t.includes('web') || t.includes('appliance')) return '📟';
  return '❔';
}

// Compact SVG diagram: gateway on the left, discovered devices fanned out and linked to it.
function subnetDiagram(node) {
  const devs = node.devices || [];
  const shown = devs.slice(0, 40);
  const cols = Math.max(1, Math.ceil(Math.sqrt(shown.length)));
  const rows = Math.max(1, Math.ceil(shown.length / cols));
  const W = 560, gx = 70, gy = 24 + (rows * 46) / 2, cellW = (W - 150) / cols, cellH = 46;
  const H = Math.max(96, rows * cellH + 24);
  const svg = s('svg', { class: 'topo', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': `Sơ đồ ${node.cidr}` });
  shown.forEach((d, i) => {
    const c = i % cols, rw = Math.floor(i / cols);
    const x = 150 + c * cellW + cellW / 2, y = 24 + rw * cellH + cellH / 2;
    svg.append(s('line', { x1: gx + 26, y1: gy, x2: x, y2: y, class: 'topo-link' }));
  });
  // gateway node
  svg.append(s('rect', { x: gx - 26, y: gy - 16, width: 52, height: 32, rx: 6, class: 'topo-gw' }));
  const gwt = s('text', { x: gx, y: gy + 5, 'text-anchor': 'middle', class: 'topo-gwt' });
  gwt.append(document.createTextNode('GW'));
  svg.append(gwt);
  shown.forEach((d, i) => {
    const c = i % cols, rw = Math.floor(i / cols);
    const x = 150 + c * cellW + cellW / 2, y = 24 + rw * cellH + cellH / 2;
    const g = s('g', { class: `topo-node s-${d.status}` });
    g.append(s('circle', { cx: x, cy: y - 6, r: 9, class: d.is_gateway ? 'topo-dot gw' : 'topo-dot' }));
    const label = s('text', { x, y: y + 12, 'text-anchor': 'middle', class: 'topo-label' });
    label.append(document.createTextNode((d.ip || '').split('.').slice(-1)[0] || '?'));
    const title = s('title', {});
    title.append(document.createTextNode(`${d.ip || ''} ${d.hostname || d.vendor || ''} — ${d.device_type || ''}`));
    g.append(title); g.append(label);
    svg.append(g);
  });
  const more = devs.length - shown.length;
  return h('div', {}, svg, more > 0 && h('div', { class: 'muted' }, `… và ${more} thiết bị khác`));
}

async function viewNetwork(el) {
  const [{ servers }, secretsRes] = await Promise.all([
    api('GET', '/api/servers'),
    can('operator') ? api('GET', '/api/secrets') : Promise.resolve({ secrets: [] }),
  ]);
  const scanners = servers.filter((s2) => (s2.platform || 'linux') === 'linux' && s2.status !== 'pending');
  const serverById = Object.fromEntries(servers.map((x) => [x.id, x]));
  const box = h('div', {});

  const deviceRow = (d) => h('tr', {},
    h('td', {}, h('span', { class: `dot ${d.status === 'managed' ? 'online' : d.status === 'connecting' ? 'pending' : 'offline'}` }), h('strong', { class: 'mono' }, d.ip || '—')),
    h('td', { class: 'mono' }, d.mac || '—'),
    h('td', {}, d.vendor || (d.snmp?.sysName ? '' : '—')),
    h('td', {}, d.hostname || d.snmp?.sysName || '—'),
    h('td', {}, `${deviceTypeIcon(d.device_type)} ${d.device_type || '—'}`),
    h('td', { class: 'mono small' }, portsLabel(d.open_ports) || '—'),
    h('td', {}, h('span', { class: `badge b-${d.status === 'managed' ? 'online' : d.status === 'connecting' ? 'pending' : 'open'}` }, DEVICE_STATUS_LABEL[d.status] || d.status),
      d.managed_server_id ? h('div', {}, h('a', { href: `#/servers/${d.managed_server_id}` }, 'mở server')) : null),
    h('td', {}, h('div', { class: 'row' },
      can('admin') && d.status !== 'managed' && h('button', { class: 'small primary', onclick: () => manageAgentDialog(d, scanners, secretsRes.secrets, guard(draw), 'install') }, 'Kết nối'),
      can('admin') && d.status === 'managed' && h('button', { class: 'small', onclick: () => manageAgentDialog(d, scanners, secretsRes.secrets, guard(draw), 'uninstall') }, 'Gỡ agent'),
      can('operator') && h('button', { class: 'small danger', onclick: guard(async () => { await api('DELETE', `/api/devices/${d.id}`); draw(); }) }, 'Xoá'))));

  async function draw() {
    const { subnets } = await api('GET', '/api/topology');
    if (!subnets.length) {
      fill(box, h('div', { class: 'panel empty' },
        'Chưa có dữ liệu quét. Bấm "Quét mạng" và chọn một agent Linux đang online để quét toàn bộ thiết bị trong hạ tầng (IP, MAC, hãng, cổng mở, loại thiết bị). Nếu có nhiều VLAN, mỗi dải mạng sẽ được quét và vẽ sơ đồ riêng.'));
      return;
    }
    // group subnets by VLAN
    const groups = {};
    for (const sn of subnets) (groups[sn.vlan || '—'] = groups[sn.vlan || '—'] || []).push(sn);
    fill(box, Object.entries(groups).map(([vlan, nodes]) => h('div', { class: 'vlan-group' },
      h('h2', {}, vlan === '—' ? 'Không gán VLAN' : `VLAN ${vlan}`),
      nodes.map((node) => h('div', { class: 'panel subnet' },
        h('div', { class: 'subnet-head' },
          h('div', {}, h('strong', { class: 'mono' }, node.cidr),
            h('span', { class: 'muted' }, ` · ${node.device_count} thiết bị`,
              node.gateway_ip ? ` · gateway ${node.gateway_ip}` : '',
              node.scanner_server_id ? ` · quét bởi ${serverById[node.scanner_server_id]?.name || 'agent'}` : '',
              ` · ${ago(node.last_scan)}`))),
        subnetDiagram(node),
        node.devices.length ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['IP', 'MAC', 'Hãng', 'Hostname', 'Loại', 'Cổng mở', 'Trạng thái', ''].map((x) => h('th', {}, x)))),
          h('tbody', {}, node.devices.map(deviceRow))))
          : h('div', { class: 'empty' }, 'Không có thiết bị trong dải này'))))));
  }

  fill(el,
    pageHead('Hạ tầng mạng',
      can('operator') && h('button', { class: 'primary', onclick: () => scanDialog(scanners, secretsRes.secrets, guard(draw)) }, '🔍 Quét mạng')),
    h('p', { class: 'muted' }, 'Từ một agent đã cài, nền tảng quét các dải mạng mà máy đó nhìn thấy, liệt kê mọi thiết bị kèm thông tin (IP, MAC/hãng, hostname, cổng & dịch vụ, loại thiết bị, SNMP nếu có), và dựng sơ đồ theo từng VLAN. Bấm "Kết nối" ở mỗi thiết bị để cài agent từ xa và đưa vào quản lý.'),
    box);
  await draw();
  every(10000, guard(draw));
}

function scanDialog(scanners, secrets, onDone) {
  if (!scanners.length) return void toast('Cần ít nhất một agent Linux đang online để quét', true);
  const scanner = h('select', {}, scanners.map((x) => h('option', { value: x.id }, `${x.name} (${x.ip || x.hostname || x.id})`)));
  const targets = h('input', { placeholder: 'để trống = tự dò các dải mạng; vd: 192.168.1.0/24, 10.0.0.0/24' });
  const ports = h('input', { placeholder: 'để trống = bộ cổng phổ biến; vd: 22,80,443,3389' });
  const deep = h('input', { type: 'checkbox' });
  const snmp = h('select', {}, h('option', { value: '' }, '(không dùng SNMP)'), secrets.map((x) => h('option', { value: x.name }, x.name)));
  const form = h('form', {
    onsubmit: guard(async (e) => {
      e.preventDefault();
      const body = { targets: targets.value.trim(), ports: ports.value.trim(), deep: deep.checked };
      if (snmp.value) body.snmp_secret = snmp.value;
      const { task } = await api('POST', `/api/servers/${scanner.value}/scan`, body);
      close();
      toast('Đã gửi lệnh quét tới agent');
      onDone();
      showTask(task.id);
    }),
  },
  h('label', {}, 'Agent quét (Linux, đang online)'), scanner,
  h('label', {}, 'Dải mạng cần quét'), targets,
  h('label', {}, 'Cổng cần kiểm tra'), ports,
  h('label', { class: 'check' }, deep, 'Quét sâu (nhiều cổng hơn, chậm hơn)'),
  h('label', {}, 'SNMP community (để lấy model/serial của thiết bị mạng)'), snmp,
  h('p', { class: 'muted' }, 'Quét chạy công khai từ agent đã cài, ghi vào nhật ký audit. Dải mạng lớn hơn /22 cần chỉ định cụ thể trong ô "Dải mạng".'),
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Bắt đầu quét')));
  const close = modal('Quét hạ tầng mạng', form);
}

function manageAgentDialog(device, scanners, secrets, onDone, defaultOp = 'install') {
  if (!scanners.length) return void toast('Cần một agent Linux đang online để thực hiện từ xa', true);
  const op = h('select', {},
    h('option', { value: 'install', selected: defaultOp === 'install' }, 'Cài agent'),
    h('option', { value: 'uninstall', selected: defaultOp === 'uninstall' }, 'Gỡ agent'));
  const scanner = h('select', {}, scanners.map((x) => h('option', { value: x.id, selected: x.id === device.scanner_server_id }, `${x.name} (${x.ip || x.id})`)));
  const os = h('select', {}, h('option', { value: 'linux', selected: !/windows/i.test(device.device_type || '') }, 'Linux (SSH)'), h('option', { value: 'windows', selected: /windows/i.test(device.device_type || '') }, 'Windows (SSH/OpenSSH)'));
  const user = h('input', { value: 'root', placeholder: 'username', autocomplete: 'off' });
  const pass = h('input', { type: 'password', placeholder: 'mật khẩu SSH', autocomplete: 'new-password' });
  const port = h('input', { type: 'number', value: 22, min: 1, max: 65535 });
  const name = h('input', { value: device.hostname || device.ip });
  const purge = h('input', { type: 'checkbox' });
  const pwSecret = h('select', {}, h('option', { value: '' }, '(dùng mật khẩu nhập ở trên)'), secrets.map((x) => h('option', { value: x.name }, x.name)));
  const keySecret = h('select', {}, h('option', { value: '' }, '(không dùng SSH key)'), secrets.map((x) => h('option', { value: x.name }, x.name)));
  const installOnly = h('div', {}, h('label', {}, 'Tên server khi thêm vào'), name);
  const uninstallOnly = h('label', { class: 'check', hidden: true }, purge, 'Xoá luôn cấu hình trên máy (--purge)');
  const submitBtn = h('button', { class: 'primary', type: 'submit' }, 'Cài & đưa vào quản lý');
  const syncOp = () => {
    const uninstall = op.value === 'uninstall';
    installOnly.hidden = uninstall;
    uninstallOnly.hidden = !uninstall;
    submitBtn.textContent = uninstall ? 'Gỡ agent khỏi máy' : 'Cài & đưa vào quản lý';
  };
  op.addEventListener('change', syncOp);
  const form = h('form', {
    onsubmit: guard(async (e) => {
      e.preventDefault();
      const uninstall = op.value === 'uninstall';
      const body = { operation: op.value, scanner_server_id: scanner.value, os: os.value, ssh_user: user.value.trim() || 'root', ssh_port: Number(port.value) || 22, confirm: true };
      if (!uninstall) body.name = name.value.trim();
      if (uninstall) body.purge = purge.checked;
      if (pwSecret.value) body.ssh_password_secret = pwSecret.value;
      else if (pass.value) body.ssh_password = pass.value;      // typed inline → stored as a one-off secret, auto-deleted
      if (keySecret.value) body.ssh_key_secret = keySecret.value;
      const { task } = await api('POST', `/api/devices/${device.id}/connect`, body);
      close();
      toast(uninstall ? 'Đang gỡ agent từ xa…' : 'Đang cài agent từ xa…');
      onDone();
      showTask(task.id);
    }),
  },
  h('p', {}, 'Thiết bị ', h('strong', { class: 'mono' }, device.ip), device.hostname ? ` (${device.hostname})` : '', '. Thao tác chạy từ agent quét qua SSH và được ghi vào nhật ký audit.'),
  h('label', {}, 'Thao tác'), op,
  h('label', {}, 'Agent thực hiện (Linux, online)'), scanner,
  h('label', {}, 'Hệ điều hành thiết bị'), os,
  h('div', { class: 'grid two' },
    h('div', {}, h('label', {}, 'Tài khoản SSH (username)'), user),
    h('div', {}, h('label', {}, 'Cổng SSH'), port)),
  h('label', {}, 'Mật khẩu SSH'), pass,
  h('details', {}, h('summary', { class: 'muted' }, 'Hoặc dùng thông tin từ kho bí mật / SSH key'),
    h('label', {}, 'Mật khẩu từ kho bí mật'), pwSecret,
    h('label', {}, 'SSH private key từ kho bí mật'), keySecret),
  installOnly, uninstallOnly,
  h('p', { class: 'muted' }, 'Nhập username + mật khẩu rồi bấm nút bên dưới để tự động đẩy cài/gỡ. Mật khẩu nhập trực tiếp được mã hoá, dùng một lần rồi tự xoá. Dùng mật khẩu cần có "sshpass" trên máy quét (hoặc dùng SSH key).'),
  h('div', { class: 'actions' }, submitBtn));
  const close = modal('Quản lý agent trên thiết bị', form);
  syncOp();
}

async function viewAlerts(el) {
  let filter = '';
  const box = h('div', {});
  const draw = async () => {
    const { alerts } = await api('GET', `/api/alerts${filter ? `?status=${filter}` : ''}`);
    fill(box, alerts.length ? h('div', { class: 'panel table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Mức độ', 'Nội dung', 'Server', 'Trạng thái', 'Cập nhật', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, alerts.map((a) => h('tr', {},
        h('td', {}, badge(a.severity)), h('td', {}, a.message),
        h('td', {}, a.server_id ? h('a', { href: `#/servers/${a.server_id}` }, a.server_name || a.server_id) : '—'),
        h('td', {}, badge(a.status), a.acknowledged_by ? h('div', { class: 'muted' }, a.acknowledged_by) : null),
        h('td', {}, ago(a.updated_at)),
        h('td', {}, can('operator') && a.status !== 'resolved' && h('div', { class: 'row' },
          a.status === 'open' && h('button', { class: 'small', onclick: guard(async () => { await api('POST', `/api/alerts/${a.id}/ack`); draw(); }) }, 'Đã nhận'),
          h('button', { class: 'small', onclick: guard(async () => { await api('POST', `/api/alerts/${a.id}/resolve`); draw(); }) }, 'Đã xử lý'))))))))
      : h('div', { class: 'panel empty' }, 'Không có cảnh báo'));
  };
  const sel = h('select', { onchange: guard(async () => { filter = sel.value; await draw(); }) },
    h('option', { value: '' }, 'Chưa xử lý'), h('option', { value: 'open' }, 'Mới'), h('option', { value: 'acknowledged' }, 'Đã nhận'), h('option', { value: 'resolved' }, 'Đã xử lý'));
  sel.style.width = 'auto';
  fill(el, pageHead('Cảnh báo', sel), box);
  await draw();
  every(15000, guard(draw));
}

async function viewTasks(el) {
  const box = h('div', { class: 'panel' });
  const draw = async () => {
    const [{ tasks }, { servers }] = await Promise.all([api('GET', '/api/tasks'), api('GET', '/api/servers')]);
    fill(box, taskTable(tasks, { showServer: true, servers: Object.fromEntries(servers.map((x) => [x.id, x])) }));
  };
  fill(el, pageHead('Lịch sử lệnh'), box);
  await draw();
  every(10000, guard(draw));
}

async function viewSecrets(el) {
  const draw = async () => {
    const { secrets } = await api('GET', '/api/secrets');
    fill(el, 
      pageHead('Kho bí mật', can('admin') && h('button', { class: 'primary', onclick: () => secretDialog(null, draw) }, '+ Thêm bí mật')),
      h('div', { class: 'panel' },
        h('p', { class: 'muted' }, 'Mật khẩu database, API key… được mã hoá AES-256-GCM. Giá trị không bao giờ hiển thị lại; nó chỉ được giải mã khi gửi lệnh cho agent và bị che (***) trong output.'),
        secrets.length ? h('table', {},
          h('thead', {}, h('tr', {}, ['Tên', 'Mô tả', 'Tạo bởi', 'Cập nhật', ''].map((x) => h('th', {}, x)))),
          h('tbody', {}, secrets.map((x) => h('tr', {},
            h('td', { class: 'mono' }, x.name), h('td', {}, x.description || ''), h('td', {}, x.created_by), h('td', {}, ago(x.updated_at)),
            h('td', {}, can('admin') && h('div', { class: 'row' },
              h('button', { class: 'small', onclick: () => secretDialog(x, draw) }, 'Đổi giá trị'),
              h('button', { class: 'small danger', onclick: guard(async () => {
                if (!(await confirmDialog('Xoá bí mật', `Xoá "${x.name}"? Các lệnh tham chiếu tới nó sẽ thất bại.`, { confirmText: 'Xoá' }))) return;
                await api('DELETE', `/api/secrets/${encodeURIComponent(x.name)}`);
                draw();
              }) }, 'Xoá')))))))
          : h('div', { class: 'empty' }, 'Chưa có bí mật nào')));
  };
  await draw();
}

function secretDialog(existing, onDone) {
  const name = h('input', { required: true, value: existing?.name || '', readonly: !!existing, pattern: '[A-Za-z0-9_.\\-]{1,64}' });
  const value = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
  const desc = h('input', { value: existing?.description || '' });
  const form = h('form', {
    onsubmit: guard(async (e) => {
      e.preventDefault();
      await api('POST', '/api/secrets', { name: name.value, value: value.value, description: desc.value || undefined });
      close();
      toast('Đã lưu');
      onDone();
    }),
  }, h('label', {}, 'Tên'), name, h('label', {}, 'Giá trị'), value, h('label', {}, 'Mô tả'), desc,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Lưu')));
  const close = modal(existing ? `Đổi giá trị: ${existing.name}` : 'Thêm bí mật', form);
}

async function viewUsers(el) {
  const draw = async () => {
    const { users } = await api('GET', '/api/users');
    const roles = Object.keys(ROLE_RANK).filter((r) => ROLE_RANK[r] <= ROLE_RANK[state.user.role]);
    fill(el, 
      pageHead('Người dùng', h('button', { class: 'primary', onclick: () => userDialog(roles, draw) }, '+ Thêm người dùng')),
      h('div', { class: 'panel table-wrap' },
        h('p', { class: 'muted' }, 'Chỉ xem: xem trạng thái. Vận hành: restart dịch vụ, backup DB, kiểm tra bảo mật. Quản trị: cập nhật/reboot, firewall, thêm server, quản lý bí mật và người dùng. Chủ sở hữu: toàn quyền.'),
        h('table', {},
          h('thead', {}, h('tr', {}, ['Người dùng', 'Vai trò', 'Trạng thái', 'Đăng nhập lần cuối', ''].map((x) => h('th', {}, x)))),
          h('tbody', {}, users.map((u) => {
            const editable = ROLE_RANK[u.role] <= ROLE_RANK[state.user.role] && u.id !== state.user.id;
            const roleSel = h('select', { disabled: !editable, onchange: guard(async () => { await api('PATCH', `/api/users/${u.id}`, { role: roleSel.value }); toast('Đã đổi vai trò'); draw(); }) },
              Object.keys(ROLE_RANK).map((r) => h('option', { value: r, selected: r === u.role, disabled: !roles.includes(r) }, ROLE_LABEL[r])));
            roleSel.style.width = 'auto';
            return h('tr', {},
              h('td', {}, h('strong', {}, u.name), h('div', { class: 'muted' }, u.email)),
              h('td', {}, roleSel),
              h('td', {}, u.disabled ? badge('offline') : badge('online')),
              h('td', {}, ago(u.last_login_at)),
              h('td', {}, editable && h('div', { class: 'row' },
                h('button', { class: 'small', onclick: guard(async () => {
                  const pw = prompt(`Mật khẩu mới cho ${u.email} (tối thiểu 10 ký tự)`);
                  if (!pw) return;
                  await api('PATCH', `/api/users/${u.id}`, { password: pw });
                  toast('Đã đặt lại mật khẩu');
                }) }, 'Đặt lại mật khẩu'),
                h('button', { class: 'small', onclick: guard(async () => { await api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled }); draw(); }) }, u.disabled ? 'Mở khoá' : 'Khoá'))));
          })))));
    el.querySelectorAll('tbody td:nth-child(3) .badge').forEach((b) => { b.textContent = b.classList.contains('b-online') ? 'Hoạt động' : 'Đã khoá'; });
  };
  await draw();
}

function userDialog(roles, onDone) {
  const f = {
    name: h('input', {}),
    email: h('input', { type: 'email', required: true }),
    password: h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }),
    role: h('select', {}, roles.map((r) => h('option', { value: r }, ROLE_LABEL[r]))),
  };
  const form = h('form', {
    onsubmit: guard(async (e) => {
      e.preventDefault();
      await api('POST', '/api/users', { name: f.name.value, email: f.email.value, password: f.password.value, role: f.role.value });
      close();
      toast('Đã tạo người dùng');
      onDone();
    }),
  }, h('label', {}, 'Họ tên'), f.name, h('label', {}, 'Email'), f.email, h('label', {}, 'Mật khẩu tạm'), f.password, h('label', {}, 'Vai trò'), f.role,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Tạo')));
  const close = modal('Thêm người dùng', form);
}

// ------------------------------------------------------------------ organizations (platform admin)
async function viewOrgs(el) {
  const draw = async () => {
    const { organizations } = await api('GET', '/api/orgs');
    fill(el,
      pageHead('Công ty', h('button', { class: 'primary', onclick: () => orgDialog(draw) }, '+ Thêm công ty')),
      h('div', { class: 'panel' },
        h('p', { class: 'muted' }, 'Mỗi công ty là một hạ tầng riêng biệt: người dùng, server, bí mật và cảnh báo của công ty nào chỉ công ty đó thấy. Dùng ô chọn công ty ở góc trái để xem và quản lý từng công ty.'),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Công ty', 'Server', 'Người dùng', 'Trạng thái', 'Tạo lúc', ''].map((x) => h('th', {}, x))),
          ), h('tbody', {}, organizations.map((o) => h('tr', {},
            h('td', {}, h('strong', {}, o.name), o.id === state.user.org_id ? h('span', { class: 'muted' }, ' (công ty gốc)') : null),
            h('td', {}, String(o.servers)),
            h('td', {}, String(o.users)),
            h('td', {}, o.disabled ? badge('offline') : badge('online')),
            h('td', {}, fmtTime(o.created_at)),
            h('td', {}, h('div', { class: 'row' },
              h('button', { class: 'small', onclick: () => { state.orgId = o.id; try { localStorage.setItem('orgId', o.id); } catch { /* ignore */ } location.hash = '#/servers'; } }, 'Mở'),
              h('button', { class: 'small', onclick: guard(async () => {
                const name = prompt('Tên mới', o.name);
                if (!name) return;
                await api('PATCH', `/api/orgs/${o.id}`, { name });
                state.orgs = (await api('GET', '/api/auth/me')).organizations;
                draw();
              }) }, 'Đổi tên'),
              o.id !== state.user.org_id && h('button', { class: 'small', onclick: guard(async () => {
                await api('PATCH', `/api/orgs/${o.id}`, { disabled: !o.disabled });
                draw();
              }) }, o.disabled ? 'Bật' : 'Tắt'))))))))));
    el.querySelectorAll('tbody td:nth-child(4) .badge').forEach((b) => { b.textContent = b.classList.contains('b-online') ? 'Hoạt động' : 'Đã tắt'; });
  };
  await draw();
}

function orgDialog(onDone) {
  const f = {
    name: h('input', { required: true, placeholder: 'Tên công ty' }),
    admin_email: h('input', { type: 'email', placeholder: 'tùy chọn' }),
    admin_name: h('input', {}),
    admin_password: h('input', { type: 'password', minlength: 10, autocomplete: 'new-password' }),
  };
  const form = h('form', {
    onsubmit: guard(async (e) => {
      e.preventDefault();
      const body = { name: f.name.value.trim() };
      if (f.admin_email.value.trim()) {
        body.admin_email = f.admin_email.value.trim();
        body.admin_name = f.admin_name.value.trim();
        body.admin_password = f.admin_password.value;
      }
      const res = await api('POST', '/api/orgs', body);
      close();
      toast('Đã tạo công ty');
      state.orgs = (await api('GET', '/api/auth/me')).organizations;
      onDone();
      // jump straight into the new company
      state.orgId = res.organization.id;
      try { localStorage.setItem('orgId', res.organization.id); } catch { /* ignore */ }
    }),
  },
  h('label', {}, 'Tên công ty'), f.name,
  h('p', { class: 'muted' }, 'Tùy chọn: tạo luôn tài khoản chủ sở hữu (owner) cho công ty này. Để trống nếu bạn tự thêm người dùng sau.'),
  h('label', {}, 'Email owner'), f.admin_email,
  h('label', {}, 'Họ tên owner'), f.admin_name,
  h('label', {}, 'Mật khẩu owner (≥10 ký tự)'), f.admin_password,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Tạo công ty')));
  const close = modal('Thêm công ty', form);
}

async function viewAudit(el) {
  const { entries } = await api('GET', '/api/audit?limit=500');
  fill(el, pageHead('Nhật ký audit'),
    h('div', { class: 'panel table-wrap' }, entries.length ? h('table', {},
      h('thead', {}, h('tr', {}, ['Thời gian', 'Ai', 'Hành động', 'Đối tượng', 'Chi tiết', 'IP'].map((x) => h('th', {}, x)))),
      h('tbody', {}, entries.map((e) => h('tr', {},
        h('td', {}, fmtTime(e.ts)),
        h('td', {}, e.actor_label || e.actor_type, h('div', { class: 'muted' }, e.actor_type)),
        h('td', { class: 'mono' }, e.action),
        h('td', { class: 'mono' }, e.target || ''),
        h('td', { class: 'mono' }, e.details ? JSON.stringify(e.details) : ''),
        h('td', { class: 'mono' }, e.ip || '')))))
      : h('div', { class: 'empty' }, 'Trống')));
}

async function viewAccount(el) {
  const cur = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const next = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  fill(el, pageHead('Tài khoản', h('button', { onclick: logout }, 'Đăng xuất')),
    h('div', { class: 'grid two' },
      h('div', { class: 'panel' }, h('h2', {}, 'Thông tin'),
        h('dl', { class: 'facts' }, h('dt', {}, 'Họ tên'), h('dd', {}, state.user.name), h('dt', {}, 'Email'), h('dd', {}, state.user.email), h('dt', {}, 'Vai trò'), h('dd', {}, ROLE_LABEL[state.user.role]))),
      h('div', { class: 'panel' }, h('h2', {}, 'Đổi mật khẩu'),
        h('form', {
          onsubmit: guard(async (e) => {
            e.preventDefault();
            const { token } = await api('POST', '/api/auth/change-password', { current_password: cur.value, new_password: next.value });
            setSession(token, state.user);
            cur.value = ''; next.value = '';
            toast('Đã đổi mật khẩu. Các phiên đăng nhập khác đã bị đăng xuất.');
          }),
        }, h('label', {}, 'Mật khẩu hiện tại'), cur, h('label', {}, 'Mật khẩu mới'), next,
        h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Đổi mật khẩu'))))));
}

boot().catch((e) => { fill($app, h('div', { class: 'center' }, h('div', { class: 'panel err' }, `Không kết nối được tới máy chủ: ${e.message}`))); });
