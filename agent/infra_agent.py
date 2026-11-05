#!/usr/bin/env python3
"""Infra agent: connects a Linux server to the control plane.

- Outbound only: the agent polls the control plane over HTTPS; no inbound port is opened.
- Runs only the allowlisted actions below, re-validating every parameter locally.
- Commands are executed without a shell (argument lists), except `shell.exec`, which is
  refused unless `allow_shell: true` is set in this server's LOCAL config file.

Usage:
  infra_agent.py enroll --server https://infra.example.com --token enr_xxx [--config PATH]
  infra_agent.py run    [--config PATH]      # long-running loop (systemd)
  infra_agent.py once   [--config PATH]      # one heartbeat + run received tasks (testing)
Standard library only, Python 3.6+.
"""
import argparse
import concurrent.futures
import datetime
import gzip
import json
import os
import platform
import re
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

VERSION = "0.1.0"
DEFAULT_CONFIG = "/etc/infra-agent/config.json"
MAX_OUTPUT = 200 * 1024
DEFAULT_TIMEOUT = 600

NAME = r"[A-Za-z0-9@._:-]{1,128}"
DBNAME = r"[A-Za-z0-9_.-]{1,64}"
IP = r"((\d{1,3}\.){3}\d{1,3}(/\d{1,2})?)|([0-9a-fA-F:]{2,39}(/\d{1,3})?)"

# Mirror of server/src/actions.js (params only). Anything not listed here is rejected.
ACTIONS = {
    "system.info": {},
    "system.disk_usage": {},
    "system.processes": {"limit": ("int", 1, 100, 15)},
    "system.users": {},
    "system.update_check": {},
    "system.update_apply": {"security_only": ("bool", True)},
    "system.reboot": {"delay_minutes": ("int", 0, 60, 1)},
    "service.list": {},
    "service.status": {"name": ("str", NAME, None)},
    "service.restart": {"name": ("str", NAME, None)},
    "service.start": {"name": ("str", NAME, None)},
    "service.stop": {"name": ("str", NAME, None)},
    "logs.tail": {"unit": ("str?", NAME, None), "lines": ("int", 1, 2000, 200)},
    "security.audit": {},
    "security.listening_ports": {},
    "security.failed_logins": {"lines": ("int", 1, 1000, 100)},
    "security.firewall_status": {},
    "security.firewall_allow": {"port": ("int", 1, 65535, None), "proto": ("enum", ("tcp", "udp"), "tcp")},
    "security.firewall_deny": {"port": ("int", 1, 65535, None), "proto": ("enum", ("tcp", "udp"), "tcp")},
    "security.block_ip": {"ip": ("str", IP, None)},
    "db.postgres.status": {},
    "db.postgres.backup": {"database": ("str", DBNAME, None)},
    "db.mysql.status": {"user": ("str", NAME, "root"), "password": ("secret",)},
    "db.mysql.backup": {"database": ("str", DBNAME, None), "user": ("str", NAME, "root"), "password": ("secret",)},
    "db.backups.list": {},
    # ---- network discovery & remote onboarding ----
    "net.scan": {
        "targets": ("str?", r"[0-9A-Fa-f:.,/ ]{0,512}", None),
        "ports": ("str?", r"[0-9, ]{0,256}", None),
        "deep": ("bool", False),
        "snmp_community": ("secret",),
    },
    "net.remote_install": {
        "host": ("str", IP, None),
        "os": ("enum", ("linux", "windows"), "linux"),
        "ssh_user": ("str", NAME, "root"),
        "ssh_port": ("int", 1, 65535, 22),
        "server_url": ("str", r"https?://[^\s]{3,256}", None),
        "enroll_token": ("str", r"[A-Za-z0-9_-]{8,160}", None),
        "ssh_password": ("secret",),
        "ssh_key": ("secret",),
    },
    "net.remote_uninstall": {
        "host": ("str", IP, None),
        "os": ("enum", ("linux", "windows"), "linux"),
        "ssh_user": ("str", NAME, "root"),
        "ssh_port": ("int", 1, 65535, 22),
        "server_url": ("str", r"https?://[^\s]{3,256}", None),
        "purge": ("bool", False),
        "ssh_password": ("secret",),
        "ssh_key": ("secret",),
    },
    "shell.exec": {"command": ("shell",)},
}


class Rejected(Exception):
    """The agent refuses to run this task (validation / policy)."""


def log(*a):
    print(datetime.datetime.now().isoformat(timespec="seconds"), *a, flush=True)


# ----------------------------------------------------------------------------- config & HTTP
def load_config(path):
    with open(path) as f:
        return json.load(f)


def save_config(path, cfg):
    os.makedirs(os.path.dirname(path) or ".", mode=0o700, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, path)


def http_json(cfg, method, path, body=None, token=None, timeout=30):
    url = cfg["server_url"].rstrip("/") + path
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "infra-agent/" + VERSION)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    ctx = None
    if url.startswith("https://"):
        ctx = ssl.create_default_context(cafile=cfg.get("ca_file") or None)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode()).get("error")
        except Exception:
            msg = str(e)
        raise RuntimeError("HTTP %s: %s" % (e.code, msg))


# ----------------------------------------------------------------------------- helpers
def which(cmd):
    return shutil.which(cmd, path=os.environ.get("PATH", "") + ":/usr/sbin:/sbin:/usr/local/sbin")


def sh(args, timeout=DEFAULT_TIMEOUT, env=None, input_text=None):
    """Run a command (argument list, no shell). Returns (exit_code, combined_output)."""
    if not which(args[0]):
        return 127, "command not found: %s" % args[0]
    try:
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout,
                           env=dict(os.environ, **(env or {})), input=input_text.encode() if input_text else None)
        return p.returncode, p.stdout.decode("utf-8", "replace")[-MAX_OUTPUT:]
    except subprocess.TimeoutExpired:
        return 124, "timed out after %ss" % timeout


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


def os_release():
    info = {}
    for line in read("/etc/os-release").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            info[k] = v.strip().strip('"')
    return info


def pkg_manager():
    for pm in ("apt-get", "dnf", "yum", "zypper", "apk"):
        if which(pm):
            return pm
    return None


def primary_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))  # no packet is sent for UDP connect
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def firewall_kind():
    if which("ufw"):
        return "ufw"
    if which("firewall-cmd"):
        return "firewalld"
    return None


def run_as_postgres(args, **kw):
    if which("runuser"):
        return sh(["runuser", "-u", "postgres", "--"] + args, **kw)
    return sh(["sudo", "-n", "-u", "postgres"] + args, **kw)


# ----------------------------------------------------------------------------- facts & metrics
_cpu_prev = None
_sec_updates_cache = {"ts": 0, "value": None}


def cpu_percent():
    global _cpu_prev
    parts = read("/proc/stat").splitlines()[0].split()[1:] if read("/proc/stat") else []
    if not parts:
        return None
    vals = [int(x) for x in parts]
    idle, total = vals[3] + (vals[4] if len(vals) > 4 else 0), sum(vals)
    prev, _cpu_prev = _cpu_prev, (idle, total)
    if not prev:
        time.sleep(0.5)
        return cpu_percent()
    d_total, d_idle = total - prev[1], idle - prev[0]
    return round(100.0 * (d_total - d_idle) / d_total, 1) if d_total > 0 else 0.0


def meminfo():
    m = {}
    for line in read("/proc/meminfo").splitlines():
        k, _, v = line.partition(":")
        m[k] = int(v.split()[0]) * 1024 if v.strip() else 0
    return m


def count_security_updates():
    """Cached (6h): number of pending security updates, or None if unknown."""
    if time.time() - _sec_updates_cache["ts"] < 6 * 3600:
        return _sec_updates_cache["value"]
    value = None
    pm = pkg_manager()
    if pm == "apt-get":
        code, out = sh(["apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade"], timeout=120)
        if code == 0:
            value = len([l for l in out.splitlines() if l.startswith("Inst ") and "security" in l.lower()])
    elif pm in ("dnf", "yum"):
        code, out = sh([pm, "-q", "updateinfo", "list", "security"], timeout=180)
        if code == 0:
            value = len([l for l in out.splitlines() if l.strip()])
    _sec_updates_cache.update(ts=time.time(), value=value)
    return value


def collect_facts():
    osr = os_release()
    mem = meminfo()
    return {
        "hostname": socket.gethostname(),
        "os": osr.get("PRETTY_NAME") or platform.platform(),
        "os_id": osr.get("ID"),
        "kernel": platform.release(),
        "arch": platform.machine(),
        "cpu_count": os.cpu_count(),
        "mem_total": mem.get("MemTotal"),
        "primary_ip": primary_ip(),
        "package_manager": pkg_manager(),
        "init": "systemd" if os.path.isdir("/run/systemd/system") else "other",
        "firewall": firewall_kind(),
        "python": platform.python_version(),
    }


def collect_metrics():
    mem = meminfo()
    total, avail = mem.get("MemTotal", 0), mem.get("MemAvailable", 0)
    st = os.statvfs("/")
    disk_total = st.f_blocks * st.f_frsize
    disk_used = (st.f_blocks - st.f_bfree) * st.f_frsize
    load = os.getloadavg()
    uptime = float((read("/proc/uptime") or "0").split()[0])
    return {
        "cpu_percent": cpu_percent(),
        "mem_percent": round(100.0 * (total - avail) / total, 1) if total else None,
        "mem_used": total - avail,
        "disk_percent": round(100.0 * disk_used / disk_total, 1) if disk_total else None,
        "disk_used": disk_used,
        "disk_total": disk_total,
        "load1": load[0], "load5": load[1], "load15": load[2],
        "uptime_seconds": int(uptime),
        "security_updates": count_security_updates(),
        "reboot_required": os.path.exists("/var/run/reboot-required"),
    }


# ----------------------------------------------------------------------------- validation
def validate(action, params, cfg):
    if action not in ACTIONS:
        raise Rejected("action not allowed by agent: %s" % action)
    spec = ACTIONS[action]
    params = params or {}
    for k in params:
        if k not in spec:
            raise Rejected("unknown parameter: %s" % k)
    out = {}
    for k, s in spec.items():
        v = params.get(k)
        kind = s[0]
        if kind == "int":
            v = s[3] if v is None else v
            if v is None or isinstance(v, bool) or not isinstance(v, int) or not (s[1] <= v <= s[2]):
                raise Rejected("invalid %s" % k)
        elif kind == "bool":
            v = s[1] if v is None else v
            if not isinstance(v, bool):
                raise Rejected("invalid %s" % k)
        elif kind == "enum":
            v = s[2] if v is None else v
            if v not in s[1]:
                raise Rejected("invalid %s" % k)
        elif kind in ("str", "str?"):
            v = s[2] if v in (None, "") else v
            if v is None and kind == "str?":
                pass
            elif not isinstance(v, str) or not re.fullmatch("(?:%s)" % s[1], v):
                raise Rejected("invalid %s" % k)
        elif kind == "secret":
            if v is not None and not isinstance(v, str):
                raise Rejected("invalid %s" % k)
        elif kind == "shell":
            if not cfg.get("allow_shell"):
                raise Rejected("shell.exec is disabled in this agent's local config (allow_shell=false)")
            if not isinstance(v, str) or not v.strip() or len(v) > 4000:
                raise Rejected("invalid %s" % k)
        out[k] = v
    return out


# ----------------------------------------------------------------------------- actions
def svc(verb, name):
    if not which("systemctl"):
        return 127, "systemctl not available", None
    code, out = sh(["systemctl", verb, "--no-pager", name] if verb == "status" else ["systemctl", verb, name], timeout=120)
    if verb != "status":
        _, state = sh(["systemctl", "is-active", name], timeout=20)
        out = (out + "\nactive state: " + state.strip()).strip()
        return code, out, {"active": state.strip()}
    return (0 if code in (0, 3) else code), out, None


def a_security_audit(p, cfg):
    findings = []

    def add(sev, fid, title, detail=""):
        findings.append({"id": fid, "severity": sev, "title": title, "detail": detail})

    # SSH configuration
    ssh = {}
    code, out = sh(["sshd", "-T"], timeout=20)
    if code == 0:
        for line in out.splitlines():
            k, _, v = line.partition(" ")
            ssh[k.lower()] = v.strip().lower()
    else:
        for line in read("/etc/ssh/sshd_config").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                k, _, v = line.partition(" ")
                ssh.setdefault(k.lower(), v.strip().lower())
    if ssh:
        if ssh.get("permitrootlogin") == "yes":
            add("high", "ssh_root_login", "SSH cho phép root đăng nhập bằng mật khẩu", "Đặt PermitRootLogin no hoặc prohibit-password")
        if ssh.get("passwordauthentication", "yes") == "yes":
            add("medium", "ssh_password_auth", "SSH cho phép đăng nhập bằng mật khẩu", "Nên dùng SSH key và đặt PasswordAuthentication no")
        if ssh.get("permitemptypasswords") == "yes":
            add("high", "ssh_empty_pw", "SSH cho phép mật khẩu rỗng")
    # Accounts
    uid0 = [l.split(":")[0] for l in read("/etc/passwd").splitlines() if l.count(":") >= 6 and l.split(":")[2] == "0" and l.split(":")[0] != "root"]
    if uid0:
        add("high", "uid0", "Có tài khoản khác root mang UID 0", ", ".join(uid0))
    try:
        if os.stat("/etc/shadow").st_mode & 0o004:
            add("high", "shadow_perms", "/etc/shadow có thể đọc bởi mọi người dùng")
    except OSError:
        pass
    # Firewall
    fw = firewall_kind()
    active = False
    if fw == "ufw":
        _, out = sh(["ufw", "status"], timeout=20)
        active = "Status: active" in out
    elif fw == "firewalld":
        code, _ = sh(["firewall-cmd", "--state"], timeout=20)
        active = code == 0
    elif which("nft"):
        _, out = sh(["nft", "list", "ruleset"], timeout=20)
        active = "chain" in out
    if not active:
        add("medium", "firewall_off", "Firewall chưa được bật", "Bật ufw/firewalld và chỉ mở các cổng cần thiết")
    # Exposed database ports
    risky = {"3306": "MySQL", "5432": "PostgreSQL", "6379": "Redis", "27017": "MongoDB", "9200": "Elasticsearch", "11211": "Memcached"}
    for port in listening_ports():
        addr = port["local"]
        host, _, pnum = addr.rpartition(":")
        if pnum in risky and host in ("0.0.0.0", "*", "[::]", "::"):
            add("high", "exposed_" + pnum, "%s đang lắng nghe trên mọi địa chỉ (cổng %s)" % (risky[pnum], pnum), "Chỉ bind vào 127.0.0.1 hoặc giới hạn bằng firewall")
    # Updates & hardening tools
    n = count_security_updates()
    if n:
        add("medium", "security_updates", "%d bản vá bảo mật chưa cài" % n)
    if os.path.exists("/var/run/reboot-required"):
        add("low", "reboot_required", "Cần khởi động lại để áp dụng cập nhật kernel/thư viện")
    if not which("fail2ban-client"):
        add("low", "no_fail2ban", "Chưa cài fail2ban để chặn dò mật khẩu")
    if pkg_manager() == "apt-get" and not os.path.exists("/etc/apt/apt.conf.d/20auto-upgrades"):
        add("low", "no_auto_updates", "Chưa bật unattended-upgrades (tự cài bản vá bảo mật)")

    weights = {"high": 25, "medium": 10, "low": 3}
    score = max(0, 100 - sum(weights[f["severity"]] for f in findings))
    lines = ["Điểm bảo mật: %d/100" % score] + ["[%s] %s %s" % (f["severity"].upper(), f["title"], ("- " + f["detail"]) if f["detail"] else "") for f in findings]
    return 0, "\n".join(lines), {"score": score, "findings": findings}


def listening_ports():
    code, out = sh(["ss", "-tulpnH"], timeout=20)
    ports = []
    if code != 0:
        return ports
    for line in out.splitlines():
        cols = line.split()
        if len(cols) >= 5:
            proc = re.search(r'users:\(\("([^"]+)"', line)
            ports.append({"proto": cols[0], "state": cols[1], "local": cols[4], "process": proc.group(1) if proc else None})
    return ports


def a_failed_logins(p, cfg):
    pat = re.compile(r"Failed password|Invalid user|authentication failure")
    lines = []
    if which("journalctl"):
        _, out = sh(["journalctl", "--no-pager", "-q", "-n", "20000", "_COMM=sshd"], timeout=60)
        lines = [l for l in out.splitlines() if pat.search(l)]
    for f in ("/var/log/auth.log", "/var/log/secure"):
        if not lines and os.path.exists(f):
            lines = [l for l in read(f).splitlines() if pat.search(l)]
    lines = lines[-p["lines"]:]
    counts = {}
    for l in lines:
        m = re.search(r"from (\S+)", l)
        if m:
            counts[m.group(1)] = counts.get(m.group(1), 0) + 1
    top = sorted(counts.items(), key=lambda x: -x[1])[:20]
    header = "Top IP: " + ", ".join("%s (%d)" % t for t in top) if top else "Không có đăng nhập thất bại"
    return 0, header + "\n\n" + "\n".join(lines), {"top_sources": [{"ip": i, "count": c} for i, c in top]}


def a_firewall(p, cfg, verb):
    fw = firewall_kind()
    spec = "%d/%s" % (p["port"], p["proto"])
    if fw == "ufw":
        code, out = sh(["ufw", verb, spec])
        return code, out, None
    if fw == "firewalld":
        flag = "--add-port=" if verb == "allow" else "--remove-port="
        code, out = sh(["firewall-cmd", "--permanent", flag + spec])
        if code == 0:
            code, out2 = sh(["firewall-cmd", "--reload"])
            out += out2
        return code, out, None
    return 1, "Không tìm thấy ufw hoặc firewalld", None


def a_block_ip(p, cfg):
    fw = firewall_kind()
    ip = p["ip"]
    if fw == "ufw":
        code, out = sh(["ufw", "insert", "1", "deny", "from", ip])
        return code, out, None
    if fw == "firewalld":
        family = "ipv6" if ":" in ip else "ipv4"
        rule = 'rule family="%s" source address="%s" drop' % (family, ip)
        code, out = sh(["firewall-cmd", "--permanent", "--add-rich-rule=" + rule])
        if code == 0:
            code, out2 = sh(["firewall-cmd", "--reload"])
            out += out2
        return code, out, None
    return 1, "Không tìm thấy ufw hoặc firewalld", None


def backup_dir(cfg):
    d = cfg.get("backup_dir", "/var/backups/infra-agent")
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def stream_to_file(args, path, env=None, compress=False, timeout=6 * 3600):
    if not which(args[0]):
        return 127, "command not found: %s" % args[0]
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as raw:
        sink = gzip.GzipFile(fileobj=raw, mode="wb") if compress else raw
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(os.environ, **(env or {})))
        err_chunks = []
        t = threading.Thread(target=lambda: err_chunks.append(p.stderr.read()))
        t.start()
        shutil.copyfileobj(p.stdout, sink, 1024 * 1024)
        try:
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
        t.join()
        if compress:
            sink.close()
    err = b"".join(err_chunks).decode("utf-8", "replace")
    if p.returncode != 0:
        try:
            os.remove(path)
        except OSError:
            pass
    return p.returncode, err


def stamp():
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def a_pg_status(p, cfg):
    code, ver = run_as_postgres(["psql", "-XAtc", "select version()"], timeout=30)
    if code != 0:
        return code, ver, None
    q = "select datname, pg_database_size(datname) from pg_database where not datistemplate order by 1"
    code, out = run_as_postgres(["psql", "-XAt", "-F", "\t", "-c", q], timeout=60)
    dbs = [{"name": l.split("\t")[0], "size": int(l.split("\t")[1])} for l in out.splitlines() if "\t" in l]
    _, conns = run_as_postgres(["psql", "-XAtc", "select count(*) from pg_stat_activity"], timeout=30)
    text = ver.strip() + "\nKết nối: " + conns.strip() + "\n" + "\n".join("%s\t%.1f MB" % (d["name"], d["size"] / 1048576.0) for d in dbs)
    return code, text, {"version": ver.strip(), "connections": conns.strip(), "databases": dbs}


def a_pg_backup(p, cfg):
    path = os.path.join(backup_dir(cfg), "pg_%s_%s.dump" % (p["database"], stamp()))
    args = (["runuser", "-u", "postgres", "--"] if which("runuser") else ["sudo", "-n", "-u", "postgres"]) + ["pg_dump", "-Fc", p["database"]]
    code, err = stream_to_file(args, path)
    if code != 0:
        return code, err, None
    size = os.path.getsize(path)
    return 0, "Đã backup %s -> %s (%.1f MB)" % (p["database"], path, size / 1048576.0), {"path": path, "size": size}


def mysql_env(p):
    return {"MYSQL_PWD": p["password"]} if p.get("password") else {}


def a_mysql_status(p, cfg):
    client = "mysql" if which("mysql") else "mariadb"
    code, out = sh([client, "-u", p["user"], "-N", "-B", "-e",
                    "SELECT VERSION(); SHOW STATUS LIKE 'Threads_connected'; SELECT table_schema, SUM(data_length+index_length) FROM information_schema.tables GROUP BY table_schema;"],
                   env=mysql_env(p), timeout=60)
    return code, out, None


def a_mysql_backup(p, cfg):
    dump = "mysqldump" if which("mysqldump") else "mariadb-dump"
    path = os.path.join(backup_dir(cfg), "mysql_%s_%s.sql.gz" % (p["database"], stamp()))
    code, err = stream_to_file([dump, "-u", p["user"], "--single-transaction", "--routines", "--triggers", p["database"]], path, env=mysql_env(p), compress=True)
    if code != 0:
        return code, err, None
    size = os.path.getsize(path)
    return 0, "Đã backup %s -> %s (%.1f MB)" % (p["database"], path, size / 1048576.0), {"path": path, "size": size}


def a_backups_list(p, cfg):
    d = backup_dir(cfg)
    files = []
    for name in sorted(os.listdir(d)):
        st = os.stat(os.path.join(d, name))
        files.append({"name": name, "size": st.st_size, "mtime": datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")})
    text = "\n".join("%s\t%.1f MB\t%s" % (f["name"], f["size"] / 1048576.0, f["mtime"]) for f in files) or "(trống)"
    return 0, d + "\n" + text, {"dir": d, "files": files}


def a_update_check(p, cfg):
    pm = pkg_manager()
    if pm == "apt-get":
        sh(["apt-get", "update", "-q"], timeout=300)
        code, out = sh(["apt", "list", "--upgradable"], timeout=120)
        _sec_updates_cache["ts"] = 0
        return code, out, {"count": len([l for l in out.splitlines() if "upgradable" in l])}
    if pm in ("dnf", "yum"):
        code, out = sh([pm, "-q", "check-update"], timeout=300)
        return (0 if code in (0, 100) else code), out, None
    return 1, "Không hỗ trợ trình quản lý gói: %s" % pm, None


def a_update_apply(p, cfg):
    pm = pkg_manager()
    _sec_updates_cache["ts"] = 0
    if pm == "apt-get":
        env = {"DEBIAN_FRONTEND": "noninteractive"}
        if p["security_only"] and which("unattended-upgrade"):
            return sh(["unattended-upgrade", "-v"], timeout=3600, env=env) + (None,)
        sh(["apt-get", "update", "-q"], timeout=300, env=env)
        return sh(["apt-get", "-y", "-o", "Dpkg::Options::=--force-confold", "upgrade"], timeout=3600, env=env) + (None,)
    if pm in ("dnf", "yum"):
        return sh([pm, "-y", "upgrade"] + (["--security"] if p["security_only"] else []), timeout=3600) + (None,)
    return 1, "Không hỗ trợ trình quản lý gói: %s" % pm, None


def a_system_users(p, cfg):
    users = []
    for l in read("/etc/passwd").splitlines():
        f = l.split(":")
        if len(f) >= 7 and not f[6].endswith(("nologin", "false", "sync", "halt", "shutdown")):
            users.append({"name": f[0], "uid": int(f[2]), "home": f[5], "shell": f[6]})
    return 0, "\n".join("%s\tuid=%d\t%s" % (u["name"], u["uid"], u["shell"]) for u in users), {"users": users}


def a_processes(p, cfg):
    code, out = sh(["ps", "-eo", "pid,user,%cpu,%mem,rss,etime,comm", "--sort=-%cpu"], timeout=30)
    return code, "\n".join(out.splitlines()[: p["limit"] + 1]), None


def a_shell(p, cfg):
    return sh(["/bin/sh", "-c", p["command"]], timeout=int(cfg.get("shell_timeout", 300))) + (None,)


# ----------------------------------------------------------------------------- network scan
# Small built-in OUI (MAC vendor prefix) table — best-effort labelling only.
OUI = {
    "000C29": "VMware", "005056": "VMware", "000569": "VMware", "001C14": "VMware",
    "080027": "VirtualBox", "525400": "QEMU/KVM", "00163E": "Xen", "001A4A": "Qumranet/KVM",
    "B827EB": "Raspberry Pi", "DCA632": "Raspberry Pi", "E45F01": "Raspberry Pi", "28CDC1": "Raspberry Pi",
    "F0F61C": "Apple", "A4B197": "Apple", "001451": "Apple", "3C0754": "Apple", "ACBC32": "Apple",
    "001B63": "Apple", "D0817A": "Apple", "F80377": "Apple",
    "0050BA": "D-Link", "001E58": "D-Link", "001346": "D-Link",
    "0018E7": "Cameo/Netgear", "000FB5": "Netgear", "20E52A": "Netgear", "A040A0": "Netgear",
    "000C42": "Routerboard/MikroTik", "4C5E0C": "MikroTik", "6C3B6B": "MikroTik", "E48D8C": "MikroTik",
    "0015FF": "Cisco-Linksys", "00000C": "Cisco", "001A2F": "Cisco", "0023EB": "Cisco", "F8721C": "Cisco",
    "00D0F6": "Cisco", "7079B3": "Cisco", "008030": "Cisco",
    "FCECDA": "Ubiquiti", "24A43C": "Ubiquiti", "788A20": "Ubiquiti", "F09FC2": "Ubiquiti", "68D79A": "Ubiquiti",
    "000374": "Huawei", "48435A": "Huawei", "D4616D": "Huawei", "E0247F": "Huawei",
    "001D0F": "TP-Link", "50C7BF": "TP-Link", "C46E1F": "TP-Link", "A42BB0": "TP-Link",
    "001517": "Intel", "3C9709": "Intel", "A0A8CD": "Intel", "A4BF01": "Intel",
    "001A11": "Google", "F4F5E8": "Google", "D83134": "Roku", "B0A737": "Roku",
    "F4CE46": "HP", "3024A9": "HP", "001708": "HP", "009C02": "HP",
    "F8BC12": "Dell", "B083FE": "Dell", "001EC9": "Dell", "D067E5": "Dell",
    "002128": "Zebra/printer", "001BA9": "Brother", "3C2AF4": "Brother", "0080A3": "Lantronix",
    "001599": "Samsung", "5CF9DD": "Samsung", "E8508B": "Samsung",
}


def mac_vendor(mac):
    if not mac:
        return None
    key = mac.replace(":", "").replace("-", "").upper()[:6]
    return OUI.get(key)


PORT_SERVICE = {
    22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 80: "http", 110: "pop3", 111: "rpcbind",
    135: "msrpc", 139: "netbios", 143: "imap", 161: "snmp", 389: "ldap", 443: "https",
    445: "smb", 515: "printer", 548: "afp", 554: "rtsp", 631: "ipp", 1433: "mssql",
    1521: "oracle", 2049: "nfs", 3000: "http-alt", 3306: "mysql", 3389: "rdp", 5000: "upnp",
    5432: "postgres", 5900: "vnc", 6379: "redis", 8006: "proxmox", 8080: "http-alt",
    8443: "https-alt", 9100: "jetdirect", 9200: "elasticsearch", 27017: "mongodb", 62078: "apple-sync",
}
DEFAULT_PORTS = [22, 23, 53, 80, 135, 139, 443, 445, 161, 515, 631, 3306, 3389, 5432, 8080, 8443, 9100, 62078]
DEEP_PORTS = sorted(PORT_SERVICE)


def guess_device_type(ports, vendor, hostname, is_gateway):
    ps = set(ports)
    v = (vendor or "").lower()
    h = (hostname or "").lower()
    if is_gateway:
        return "gateway/router"
    if {9100, 515, 631} & ps or "printer" in v or "brother" in v or "zebra" in v:
        return "printer"
    if 62078 in ps or "iphone" in h or "ipad" in h:
        return "mobile/iOS"
    if any(k in v for k in ("cisco", "mikrotik", "ubiquiti", "tp-link", "netgear", "d-link", "huawei")) and (161 in ps or 23 in ps or 80 in ps):
        return "network device"
    if {3389, 135} & ps or (445 in ps and 139 in ps):
        return "Windows host"
    if "vmware" in v or "virtualbox" in v or "qemu" in v or "xen" in v or "kvm" in v:
        return "virtual machine"
    if "raspberry" in v:
        return "Raspberry Pi"
    if "apple" in v:
        return "Apple device"
    if 22 in ps:
        return "Linux/Unix host"
    if {80, 443} & ps:
        return "web/appliance"
    return "unknown"


def local_subnets():
    """Return [{cidr, vlan, iface}] for connected IPv4 networks, excluding loopback."""
    out = []
    code, text = sh(["ip", "-o", "-4", "addr", "show"], timeout=15)
    if code != 0:
        return out
    for line in text.splitlines():
        cols = line.split()
        # e.g. "2: eth0    inet 192.168.1.5/24 brd ... scope global eth0"
        if len(cols) < 4 or cols[2] != "inet":
            continue
        iface, cidr = cols[1], cols[3]
        if cidr.startswith("127.") or "/32" in cidr:
            continue
        net = cidr_network(cidr)
        if not net:
            continue
        vlan = None
        m = re.search(r"\.(\d{1,4})$", iface) or re.search(r"vlan(\d{1,4})", iface)
        if m:
            vlan = m.group(1)
        out.append({"cidr": net, "vlan": vlan, "iface": iface})
    return out


def default_gateways():
    gws = {}
    code, text = sh(["ip", "-o", "-4", "route", "show"], timeout=15)
    if code == 0:
        for line in text.splitlines():
            m = re.search(r"default via (\d+\.\d+\.\d+\.\d+) dev (\S+)", line)
            if m:
                gws[m.group(2)] = m.group(1)
    return gws


def neighbor_table():
    """ip -> mac from the ARP/neighbour cache."""
    macs = {}
    code, text = sh(["ip", "-4", "neigh", "show"], timeout=15)
    if code == 0:
        for line in text.splitlines():
            m = re.match(r"(\d+\.\d+\.\d+\.\d+).*lladdr ([0-9a-fA-F:]{17})", line)
            if m:
                macs[m.group(1)] = m.group(2).lower()
    for line in read("/proc/net/arp").splitlines()[1:]:
        f = line.split()
        if len(f) >= 4 and f[3] != "00:00:00:00:00:00":
            macs.setdefault(f[0], f[3].lower())
    return macs


def cidr_network(cidr):
    """Normalise 'ip/prefix' to the network address 'net/prefix' (IPv4 only)."""
    try:
        ip, _, pfx = cidr.partition("/")
        pfx = int(pfx)
        octets = [int(x) for x in ip.split(".")]
        if len(octets) != 4 or not (0 <= pfx <= 32):
            return None
        val = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]
        mask = (0xFFFFFFFF << (32 - pfx)) & 0xFFFFFFFF if pfx else 0
        net = val & mask
        return "%d.%d.%d.%d/%d" % ((net >> 24) & 255, (net >> 16) & 255, (net >> 8) & 255, net & 255, pfx)
    except (ValueError, IndexError):
        return None


def hosts_in(cidr, cap=1024):
    """Yield host IPs in a CIDR (IPv4), excluding network/broadcast. Capped for safety."""
    ip, _, pfx = cidr.partition("/")
    pfx = int(pfx)
    octets = [int(x) for x in ip.split(".")]
    base = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]
    size = 1 << (32 - pfx)
    if size > cap:
        return []
    out = []
    first, last = (base + 1, base + size - 1) if pfx < 31 else (base, base + size)
    for v in range(first, last):
        out.append("%d.%d.%d.%d" % ((v >> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255))
    return out


def tcp_open(ip, port, timeout=0.6):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        return s.connect_ex((ip, port)) == 0
    except OSError:
        return False
    finally:
        s.close()


def ping(ip, timeout=1):
    code, _ = sh(["ping", "-c", "1", "-W", str(timeout), "-n", ip], timeout=timeout + 2)
    return code == 0


def reverse_dns(ip):
    try:
        socket.setdefaulttimeout(1.0)
        return socket.gethostbyaddr(ip)[0]
    except (OSError, socket.herror):
        return None
    finally:
        socket.setdefaulttimeout(None)


# ---- minimal SNMPv2c GET (sysDescr, sysName, sysObjectID) ------------------------------------
def _ber_len(n):
    if n < 0x80:
        return bytes([n])
    b = []
    while n:
        b.insert(0, n & 0xFF)
        n >>= 8
    return bytes([0x80 | len(b)]) + bytes(b)


def _ber_tlv(tag, val):
    return bytes([tag]) + _ber_len(len(val)) + val


def _ber_int(n):
    if n == 0:
        return _ber_tlv(0x02, b"\x00")
    b = []
    v = n
    while v:
        b.insert(0, v & 0xFF)
        v >>= 8
    if b[0] & 0x80:
        b.insert(0, 0)
    return _ber_tlv(0x02, bytes(b))


def _ber_oid(oid):
    parts = [int(x) for x in oid.split(".")]
    body = [parts[0] * 40 + parts[1]]
    for p in parts[2:]:
        if p < 0x80:
            body.append(p)
        else:
            chunk = []
            while p:
                chunk.insert(0, p & 0x7F)
                p >>= 7
            for i in range(len(chunk) - 1):
                chunk[i] |= 0x80
            body.extend(chunk)
    return _ber_tlv(0x06, bytes(body))


def snmp_get(ip, community, oids, timeout=1.2):
    """Best-effort SNMPv2c GET. Returns {oid: value_str} for the ones that answer."""
    try:
        varbinds = b"".join(_ber_tlv(0x30, _ber_oid(o) + _ber_tlv(0x05, b"")) for o in oids)
        vbl = _ber_tlv(0x30, varbinds)
        pdu = _ber_tlv(0xA0, _ber_int(int(time.time()) & 0x7FFFFFFF) + _ber_int(0) + _ber_int(0) + vbl)
        msg = _ber_tlv(0x30, _ber_int(1) + _ber_tlv(0x04, community.encode()) + pdu)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(timeout)
        try:
            s.sendto(msg, (ip, 161))
            data, _ = s.recvfrom(4096)
        finally:
            s.close()
        # crude varbind extraction: collect all printable OCTET STRING values in order
        found = {}
        vals = []
        i = 0
        while i < len(data) - 2:
            if data[i] == 0x04:
                ln = data[i + 1]
                if ln < 0x80 and i + 2 + ln <= len(data):
                    chunk = data[i + 2:i + 2 + ln]
                    if all(32 <= c < 127 for c in chunk) and ln >= 1:
                        vals.append(chunk.decode("ascii", "ignore"))
                    i += 2 + ln
                    continue
            i += 1
        # first octet string is the community echo; the rest line up with the requested OIDs
        names = ["sysDescr", "sysName"]
        for idx, name in enumerate(names):
            if idx + 1 < len(vals):
                found[name] = vals[idx + 1]
        return found or None
    except (OSError, socket.timeout, Exception):  # noqa
        return None


def a_net_scan(p, cfg):
    # 1. subnets to scan
    if p.get("targets"):
        subnets = []
        for part in re.split(r"[,\s]+", p["targets"].strip()):
            if not part:
                continue
            net = cidr_network(part if "/" in part else part + "/24")
            if net:
                subnets.append({"cidr": net, "vlan": None, "iface": None})
    else:
        subnets = local_subnets()
    if not subnets:
        return 1, "Không phát hiện được subnet nào để quét", None
    gateways = default_gateways()
    gw_ips = set(gateways.values())
    neigh = neighbor_table()
    ports = DEEP_PORTS if p.get("deep") else DEFAULT_PORTS
    if p.get("ports"):
        try:
            ports = sorted({int(x) for x in re.split(r"[,\s]+", p["ports"].strip()) if x})
        except ValueError:
            pass
    community = p.get("snmp_community")

    subnet_report, devices = [], []
    scanner_ip = primary_ip()
    for sn in subnets:
        targets = hosts_in(sn["cidr"], cap=int(cfg.get("scan_host_cap", 1024)))
        if not targets:
            subnet_report.append({**sn, "hosts_scanned": 0, "note": "subnet quá lớn, bỏ qua (cần chỉ định targets)"})
            continue
        gw_ip = gateways.get(sn["iface"]) if sn["iface"] else None
        # liveness: ping + arp prime, then TCP connect to find alive hosts
        alive = {}

        def probe(ip):
            live = ip in neigh or ping(ip)
            open_ports = []
            for port in ports:
                if tcp_open(ip, port):
                    open_ports.append(port)
                    live = True
            return ip, (open_ports if live else None)

        with concurrent.futures.ThreadPoolExecutor(max_workers=int(cfg.get("scan_workers", 64))) as pool:
            for ip, res in pool.map(probe, targets):
                if res is not None:
                    alive[ip] = res
        # refresh neighbour cache after probing (ARP now populated)
        neigh2 = neighbor_table()
        for ip, open_ports in sorted(alive.items(), key=lambda kv: tuple(int(o) for o in kv[0].split("."))):
            mac = neigh2.get(ip) or neigh.get(ip)
            if ip == scanner_ip and not mac:
                mac = None
            vendor = mac_vendor(mac)
            hostname = reverse_dns(ip)
            is_gw = ip in gw_ips or ip == gw_ip
            snmp = None
            if community and 161 in open_ports:
                snmp = snmp_get(ip, community, ["1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.5.0"])
            devices.append({
                "ip": ip, "mac": mac, "vendor": vendor, "hostname": hostname,
                "subnet": sn["cidr"], "vlan": sn["vlan"],
                "open_ports": [{"port": po, "proto": "tcp", "service": PORT_SERVICE.get(po)} for po in open_ports],
                "device_type": guess_device_type(open_ports, vendor, hostname, is_gw),
                "is_gateway": is_gw, "snmp": snmp,
            })
        subnet_report.append({"cidr": sn["cidr"], "vlan": sn["vlan"], "iface": sn["iface"],
                              "gateway_ip": gw_ip, "hosts_scanned": len(targets), "devices_found": len(alive)})

    result = {"subnets": subnet_report, "devices": devices,
              "scanner": {"ip": scanner_ip, "hostname": socket.gethostname()}}
    lines = ["Quét %d subnet, tìm thấy %d thiết bị:" % (len(subnet_report), len(devices))]
    for sn in subnet_report:
        lines.append("  %s%s — %d thiết bị" % (sn["cidr"], (" (VLAN %s)" % sn["vlan"]) if sn.get("vlan") else "", sn.get("devices_found", 0)))
    for d in devices:
        lines.append("  %-15s %-17s %-14s %s" % (d["ip"], d["mac"] or "-", d["device_type"], d["hostname"] or (d["vendor"] or "")))
    return 0, "\n".join(lines), result


def ensure_sshpass():
    """Make sure sshpass is available on this (scanner) host, installing it if needed."""
    if which("sshpass"):
        return True
    pm = pkg_manager()
    cmds = {
        "apt-get": [["apt-get", "update", "-q"], ["apt-get", "install", "-y", "sshpass"]],
        "dnf": [["dnf", "install", "-y", "sshpass"]],
        "yum": [["yum", "install", "-y", "sshpass"]],
        "zypper": [["zypper", "--non-interactive", "install", "sshpass"]],
        "apk": [["apk", "add", "--no-cache", "sshpass"]],
    }.get(pm, [])
    for c in cmds:
        sh(c, timeout=300, env={"DEBIAN_FRONTEND": "noninteractive"})
    return which("sshpass") is not None


def _ssh_exec(p, cfg, remote_cmd):
    """Run a single command on a remote host over SSH, using a key or password from the vault.
    Returns (exit_code, output)."""
    host, user, port = p["host"], p.get("ssh_user", "root"), int(p.get("ssh_port", 22))
    key, password = p.get("ssh_key"), p.get("ssh_password")
    ssh_opts = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=12",
                "-o", "NumberOfPasswordPrompts=1", "-p", str(port)]
    keyfile = None
    try:
        if key:
            keyfile = os.path.join(cfg.get("tmp_dir", "/tmp"), "infra_rk_%s" % stamp())
            fdh = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fdh, "w") as f:
                f.write(key if key.endswith("\n") else key + "\n")
            args = ["ssh", "-i", keyfile, "-o", "BatchMode=yes"] + ssh_opts + ["%s@%s" % (user, host), remote_cmd]
        elif password:
            if not ensure_sshpass():
                return 1, "Không cài được 'sshpass' trên server quét để dùng mật khẩu SSH. Hãy dùng SSH key thay thế."
            args = ["sshpass", "-p", password, "ssh"] + ssh_opts + ["%s@%s" % (user, host), remote_cmd]
        else:
            args = ["ssh", "-o", "BatchMode=yes"] + ssh_opts + ["%s@%s" % (user, host), remote_cmd]
        return sh(args, timeout=int(cfg.get("remote_install_timeout", 300)))
    finally:
        if keyfile:
            try:
                os.remove(keyfile)
            except OSError:
                pass


def a_net_remote_install(p, cfg):
    host, osname = p["host"], p.get("os", "linux")
    server_url, token = p["server_url"], p["enroll_token"]
    user = p.get("ssh_user", "root")
    if osname == "windows":
        remote = ("powershell -NoProfile -Command \"iwr %s/agent/install.ps1 -UseBasicParsing | iex; "
                  "Install-InfraAgent -Server '%s' -Token '%s'\"") % (server_url, server_url, token)
    else:
        sudo = "" if user == "root" else "sudo -n "
        remote = "curl -fsSL %s/agent/install.sh | %sbash -s -- --server %s --token %s" % (server_url, sudo, server_url, token)
    code, out = _ssh_exec(p, cfg, remote)
    return code, out, {"host": host, "os": osname, "installed": code == 0}


def a_net_remote_uninstall(p, cfg):
    host, osname = p["host"], p.get("os", "linux")
    server_url, user = p["server_url"], p.get("ssh_user", "root")
    if osname == "windows":
        remote = ("powershell -NoProfile -Command \"iwr %s/agent/install.ps1 -UseBasicParsing | iex; "
                  "Uninstall-InfraAgent%s\"") % (server_url, " -Purge" if p.get("purge") else "")
    else:
        sudo = "" if user == "root" else "sudo -n "
        flag = " --purge" if p.get("purge") else " --uninstall"
        remote = "curl -fsSL %s/agent/install.sh | %sbash -s --%s" % (server_url, sudo, flag)
    code, out = _ssh_exec(p, cfg, remote)
    return code, out, {"host": host, "os": osname, "uninstalled": code == 0}


HANDLERS = {
    "system.info": lambda p, c: (lambda d: (0, json.dumps(d, indent=2), d))(dict(collect_facts(), **collect_metrics())),
    "system.disk_usage": lambda p, c: sh(["df", "-hT", "-x", "tmpfs", "-x", "devtmpfs", "-x", "overlay", "-x", "squashfs"]) + (None,),
    "system.processes": a_processes,
    "system.users": a_system_users,
    "system.update_check": a_update_check,
    "system.update_apply": a_update_apply,
    "system.reboot": lambda p, c: sh(["shutdown", "-r", "+%d" % p["delay_minutes"], "Reboot requested from control plane"]) + (None,),
    "service.list": lambda p, c: sh(["systemctl", "list-units", "--type=service", "--state=running", "--no-pager", "--plain", "--no-legend"]) + (None,),
    "service.status": lambda p, c: svc("status", p["name"]),
    "service.restart": lambda p, c: svc("restart", p["name"]),
    "service.start": lambda p, c: svc("start", p["name"]),
    "service.stop": lambda p, c: svc("stop", p["name"]),
    "logs.tail": lambda p, c: sh(["journalctl", "--no-pager", "-n", str(p["lines"])] + (["-u", p["unit"]] if p.get("unit") else [])) + (None,),
    "security.audit": a_security_audit,
    "security.listening_ports": lambda p, c: (lambda ports: (0, "\n".join("%-5s %-25s %s" % (x["proto"], x["local"], x["process"] or "") for x in ports), {"ports": ports}))(listening_ports()),
    "security.failed_logins": a_failed_logins,
    "security.firewall_status": lambda p, c: (sh(["ufw", "status", "verbose"]) if firewall_kind() == "ufw" else sh(["firewall-cmd", "--list-all"]) if firewall_kind() == "firewalld" else sh(["nft", "list", "ruleset"])) + (None,),
    "security.firewall_allow": lambda p, c: a_firewall(p, c, "allow"),
    "security.firewall_deny": lambda p, c: a_firewall(p, c, "deny"),
    "security.block_ip": a_block_ip,
    "db.postgres.status": a_pg_status,
    "db.postgres.backup": a_pg_backup,
    "db.mysql.status": a_mysql_status,
    "db.mysql.backup": a_mysql_backup,
    "db.backups.list": a_backups_list,
    "net.scan": a_net_scan,
    "net.remote_install": a_net_remote_install,
    "net.remote_uninstall": a_net_remote_uninstall,
    "shell.exec": a_shell,
}
assert set(HANDLERS) == set(ACTIONS)


def execute(task, cfg):
    try:
        params = validate(task["action"], task.get("params"), cfg)
        code, out, result = HANDLERS[task["action"]](params, cfg)
        status = "succeeded" if code == 0 else "failed"
    except Rejected as e:
        status, code, out, result = "rejected", None, "Agent từ chối: %s" % e, None
    except Exception as e:  # noqa
        status, code, out, result = "failed", None, "Lỗi agent: %r" % e, None
    body = {"status": status, "exit_code": code, "output": (out or "")[-MAX_OUTPUT:]}
    if result is not None:
        body["result"] = result
    return body


# ----------------------------------------------------------------------------- main loops
def cmd_enroll(args):
    cfg = {"server_url": args.server.rstrip("/")}
    if args.ca_file:
        cfg["ca_file"] = args.ca_file
    if not cfg["server_url"].startswith("https://") and not args.insecure_http:
        sys.exit("Refusing to enroll over plain HTTP. Use https:// or pass --insecure-http for lab setups.")
    resp = http_json(cfg, "POST", "/api/agent/enroll", {
        "token": args.token, "version": VERSION, "capabilities": sorted(ACTIONS), "facts": collect_facts(), "metrics": collect_metrics(),
    })
    cfg.update(server_id=resp["server_id"], agent_token=resp["agent_token"], allow_shell=False,
               backup_dir="/var/backups/infra-agent")
    save_config(args.config, cfg)
    log("Enrolled as %s; config written to %s" % (resp["server_id"], args.config))


def heartbeat(cfg, inflight, pool, lock):
    resp = http_json(cfg, "POST", "/api/agent/heartbeat", {
        "version": VERSION, "capabilities": sorted(ACTIONS), "facts": collect_facts(), "metrics": collect_metrics(),
    }, token=cfg["agent_token"])
    futures = []
    for task in resp.get("tasks", []):
        with lock:
            if task["id"] in inflight:
                continue
            inflight.add(task["id"])
        log("task %s: %s" % (task["id"], task["action"]))
        futures.append(pool.submit(run_task, cfg, task, inflight, lock))
    return resp.get("poll_interval", 10), futures


def run_task(cfg, task, inflight, lock):
    try:
        body = execute(task, cfg)
        for attempt in range(5):
            try:
                http_json(cfg, "POST", "/api/agent/tasks/%s/result" % task["id"], body, token=cfg["agent_token"])
                break
            except Exception as e:  # noqa
                log("result upload failed (%s), retrying" % e)
                time.sleep(2 ** attempt)
        log("task %s: %s" % (task["id"], body["status"]))
    finally:
        with lock:
            inflight.discard(task["id"])


def cmd_run(args, once=False):
    cfg = load_config(args.config)
    inflight, lock = set(), threading.Lock()
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=int(cfg.get("max_parallel_tasks", 2)))
    backoff = 5
    log("infra-agent %s -> %s (server %s, allow_shell=%s)" % (VERSION, cfg["server_url"], cfg.get("server_id"), bool(cfg.get("allow_shell"))))
    while True:
        try:
            interval, futures = heartbeat(cfg, inflight, pool, lock)
            backoff = 5
        except Exception as e:  # noqa
            log("heartbeat failed: %s" % e)
            if once:
                sys.exit(1)
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)
            continue
        if once:
            concurrent.futures.wait(futures)
            pool.shutdown()
            return
        time.sleep(max(1, min(int(interval), 60)))


def main():
    ap = argparse.ArgumentParser(description="Infra management agent")
    ap.add_argument("--config", default=os.environ.get("INFRA_AGENT_CONFIG", DEFAULT_CONFIG))
    sub = ap.add_subparsers(dest="cmd")
    e = sub.add_parser("enroll")
    e.add_argument("--server", required=True)
    e.add_argument("--token", required=True)
    e.add_argument("--ca-file")
    e.add_argument("--insecure-http", action="store_true", help="allow http:// (lab/testing only)")
    sub.add_parser("run")
    sub.add_parser("once")
    sub.add_parser("version")
    args = ap.parse_args()
    if args.cmd == "enroll":
        cmd_enroll(args)
    elif args.cmd == "run":
        cmd_run(args)
    elif args.cmd == "once":
        cmd_run(args, once=True)
    elif args.cmd == "version":
        print(VERSION)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
