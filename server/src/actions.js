'use strict';
// Catalog of operations the platform may request from an agent.
// The agent keeps its own copy of this allowlist and re-validates every parameter,
// so a compromised control plane still cannot make an agent run arbitrary commands
// (shell.exec additionally requires allow_shell=true in the agent's LOCAL config).

const NAME = '^[A-Za-z0-9@._:-]{1,128}$';
const DBNAME = '^[A-Za-z0-9_.-]{1,64}$';
const IPV4_CIDR = '^(\\d{1,3}\\.){3}\\d{1,3}(/\\d{1,2})?$';
const IPV6_CIDR = '^[0-9a-fA-F:]{2,39}(/\\d{1,3})?$';

const ACTIONS = {
  // ---- system ----
  'system.info':          { category: 'system',   title: 'Thông tin hệ thống', minRole: 'viewer', params: {} },
  'system.disk_usage':    { category: 'system',   title: 'Dung lượng ổ đĩa', minRole: 'viewer', params: {} },
  'system.processes':     { category: 'system',   title: 'Top tiến trình (CPU/RAM)', minRole: 'viewer', params: { limit: { type: 'int', min: 1, max: 100, default: 15 } } },
  'system.users':         { category: 'system',   title: 'Tài khoản có shell đăng nhập', minRole: 'viewer', params: {} },
  'system.update_check':  { category: 'system',   title: 'Kiểm tra bản cập nhật', minRole: 'operator', params: {} },
  'system.update_apply':  { category: 'system',   title: 'Cài bản cập nhật hệ điều hành', minRole: 'admin', destructive: true, params: { security_only: { type: 'bool', default: true } } },
  'system.reboot':        { category: 'system',   title: 'Khởi động lại server', minRole: 'admin', destructive: true, params: { delay_minutes: { type: 'int', min: 0, max: 60, default: 1 } } },

  // ---- services ----
  'service.list':         { category: 'service',  title: 'Danh sách dịch vụ đang chạy', minRole: 'viewer', params: {} },
  'service.status':       { category: 'service',  title: 'Trạng thái dịch vụ', minRole: 'viewer', params: { name: { type: 'string', pattern: NAME, required: true } } },
  'service.restart':      { category: 'service',  title: 'Khởi động lại dịch vụ', minRole: 'operator', params: { name: { type: 'string', pattern: NAME, required: true } } },
  'service.start':        { category: 'service',  title: 'Bật dịch vụ', minRole: 'operator', params: { name: { type: 'string', pattern: NAME, required: true } } },
  'service.stop':         { category: 'service',  title: 'Dừng dịch vụ', minRole: 'admin', destructive: true, params: { name: { type: 'string', pattern: NAME, required: true } } },
  'logs.tail':            { category: 'service',  title: 'Xem log (journald)', minRole: 'operator', params: { unit: { type: 'string', pattern: NAME }, lines: { type: 'int', min: 1, max: 2000, default: 200 } } },

  // ---- security ----
  'security.audit':       { category: 'security', title: 'Kiểm tra bảo mật tổng quát', minRole: 'operator', params: {} },
  'security.listening_ports': { category: 'security', title: 'Cổng đang mở', minRole: 'viewer', params: {} },
  'security.failed_logins':   { category: 'security', title: 'Đăng nhập SSH thất bại', minRole: 'operator', params: { lines: { type: 'int', min: 1, max: 1000, default: 100 } } },
  'security.firewall_status': { category: 'security', title: 'Trạng thái firewall', minRole: 'viewer', params: {} },
  'security.firewall_allow':  { category: 'security', title: 'Mở cổng firewall', minRole: 'admin', destructive: true, params: { port: { type: 'int', min: 1, max: 65535, required: true }, proto: { type: 'enum', values: ['tcp', 'udp'], default: 'tcp' } } },
  'security.firewall_deny':   { category: 'security', title: 'Đóng cổng firewall', minRole: 'admin', destructive: true, params: { port: { type: 'int', min: 1, max: 65535, required: true }, proto: { type: 'enum', values: ['tcp', 'udp'], default: 'tcp' } } },
  'security.block_ip':        { category: 'security', title: 'Chặn địa chỉ IP', minRole: 'admin', destructive: true, params: { ip: { type: 'string', pattern: `(${IPV4_CIDR})|(${IPV6_CIDR})`, required: true } } },
  'security.deep_audit':      { category: 'security', title: 'Đánh giá bảo mật chuyên sâu', minRole: 'operator', params: {} },
  // ---- remediation (auto-fix) ----
  'security.harden_sysctl':   { category: 'security', title: 'Tăng cường tham số nhân (sysctl)', minRole: 'admin', destructive: true, platforms: ['linux'], params: {} },
  'security.disable_service': { category: 'security', title: 'Tắt & chặn một dịch vụ rủi ro', minRole: 'admin', destructive: true, platforms: ['linux'], params: { name: { type: 'string', pattern: NAME, required: true } } },
  'security.ssh_harden':      { category: 'security', title: 'Tăng cường cấu hình SSH', minRole: 'admin', destructive: true, platforms: ['linux'], params: { permit_root: { type: 'enum', values: ['no', 'prohibit-password'], default: 'prohibit-password' }, password_auth: { type: 'enum', values: ['no', 'yes'], default: 'no' } } },
  'security.disable_smb1':    { category: 'security', title: 'Tắt SMBv1 (Windows)', minRole: 'admin', destructive: true, platforms: ['windows'], params: {} },
  'security.disable_guest':   { category: 'security', title: 'Tắt tài khoản Guest (Windows)', minRole: 'admin', destructive: true, platforms: ['windows'], params: {} },

  // ---- databases ----
  'db.postgres.status':   { category: 'database', title: 'PostgreSQL: trạng thái & danh sách DB', minRole: 'viewer', params: {} },
  'db.postgres.backup':   { category: 'database', title: 'PostgreSQL: backup (pg_dump)', minRole: 'operator', params: { database: { type: 'string', pattern: DBNAME, required: true } } },
  'db.mysql.status':      { category: 'database', title: 'MySQL/MariaDB: trạng thái & danh sách DB', minRole: 'viewer', params: { user: { type: 'string', pattern: NAME, default: 'root' }, password: { type: 'secret' } } },
  'db.mysql.backup':      { category: 'database', title: 'MySQL/MariaDB: backup (mysqldump)', minRole: 'operator', params: { database: { type: 'string', pattern: DBNAME, required: true }, user: { type: 'string', pattern: NAME, default: 'root' }, password: { type: 'secret' } } },
  'db.backups.list':      { category: 'database', title: 'Danh sách file backup trên server', minRole: 'viewer', params: {} },

  // ---- network discovery & remote onboarding (agent must run on Linux) ----
  'net.scan':             { category: 'network',  title: 'Quét hạ tầng mạng', minRole: 'operator', platforms: ['linux', 'windows'], params: {
    targets: { type: 'string', pattern: '[0-9A-Fa-f:.,/ ]{0,512}' },
    ports: { type: 'string', pattern: '[0-9, ]{0,256}' },
    deep: { type: 'bool', default: false },
    snmp_community: { type: 'secret' },
  } },
  'net.remote_install':   { category: 'network',  title: 'Cài agent từ xa tới thiết bị', minRole: 'admin', destructive: true, platforms: ['linux', 'windows'], internal: true, params: {
    host: { type: 'string', pattern: `(${IPV4_CIDR})|(${IPV6_CIDR})`, required: true },
    os: { type: 'enum', values: ['linux', 'windows'], default: 'linux' },
    ssh_user: { type: 'string', pattern: NAME, default: 'root' },
    ssh_port: { type: 'int', min: 1, max: 65535, default: 22 },
    server_url: { type: 'string', pattern: 'https?://[^\\s]{3,256}', required: true },
    enroll_token: { type: 'string', pattern: '[A-Za-z0-9_-]{8,160}', required: true },
    ssh_password: { type: 'secret' },
    ssh_key: { type: 'secret' },
  } },
  'net.remote_uninstall': { category: 'network',  title: 'Gỡ agent từ xa khỏi thiết bị', minRole: 'admin', destructive: true, platforms: ['linux', 'windows'], internal: true, params: {
    host: { type: 'string', pattern: `(${IPV4_CIDR})|(${IPV6_CIDR})`, required: true },
    os: { type: 'enum', values: ['linux', 'windows'], default: 'linux' },
    ssh_user: { type: 'string', pattern: NAME, default: 'root' },
    ssh_port: { type: 'int', min: 1, max: 65535, default: 22 },
    server_url: { type: 'string', pattern: 'https?://[^\\s]{3,256}', required: true },
    purge: { type: 'bool', default: false },
    ssh_password: { type: 'secret' },
    ssh_key: { type: 'secret' },
  } },

  // ---- break-glass ----
  'shell.exec':           { category: 'shell',    title: 'Chạy lệnh shell (break-glass)', minRole: 'admin', destructive: true, requiresShell: true, params: { command: { type: 'string', required: true, maxLength: 4000 } } },
};

class ValidationError extends Error {}

// Returns normalized params. Secret params must be {"$secret": "<vault name>"}; they stay as
// references in the DB and are only resolved when the task is handed to the agent.
function validateParams(actionName, input = {}) {
  const action = ACTIONS[actionName];
  if (!action) throw new ValidationError(`Unknown action: ${actionName}`);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('params must be an object');
  const out = {};
  for (const key of Object.keys(input)) {
    if (!action.params[key]) throw new ValidationError(`Unknown parameter: ${key}`);
  }
  for (const [key, spec] of Object.entries(action.params)) {
    let v = input[key];
    if (v === undefined || v === null || v === '') {
      if (spec.required) throw new ValidationError(`Missing parameter: ${key}`);
      if (spec.default !== undefined) out[key] = spec.default;
      continue;
    }
    switch (spec.type) {
      case 'int':
        v = Number(v);
        if (!Number.isInteger(v) || v < spec.min || v > spec.max) throw new ValidationError(`${key} must be an integer in [${spec.min}, ${spec.max}]`);
        break;
      case 'bool':
        if (typeof v === 'string') v = v === 'true';
        if (typeof v !== 'boolean') throw new ValidationError(`${key} must be boolean`);
        break;
      case 'enum':
        if (!spec.values.includes(v)) throw new ValidationError(`${key} must be one of ${spec.values.join(', ')}`);
        break;
      case 'string':
        v = String(v);
        if (spec.pattern && !new RegExp(`^(?:${spec.pattern.replace(/^\^|\$$/g, '')})$`).test(v)) throw new ValidationError(`${key} has an invalid format`);
        if (spec.maxLength && v.length > spec.maxLength) throw new ValidationError(`${key} is too long`);
        break;
      case 'secret':
        if (typeof v !== 'object' || typeof v.$secret !== 'string') throw new ValidationError(`${key} must reference a vault secret: {"$secret": "name"}`);
        v = { $secret: v.$secret };
        break;
      default:
        throw new ValidationError(`Unsupported parameter type for ${key}`);
    }
    out[key] = v;
  }
  return out;
}

module.exports = { ACTIONS, validateParams, ValidationError };
