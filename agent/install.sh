#!/usr/bin/env bash
# Installs the infra agent as a systemd service and enrolls it with the control plane.
#   curl -fsSL https://infra.example.com/agent/install.sh | sudo bash -s -- --server https://infra.example.com --token enr_xxx
# Options: --ca-file PATH (custom CA for a self-signed control plane), --insecure-http (lab only).
set -euo pipefail

SERVER=""; TOKEN=""; EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --ca-file) EXTRA+=(--ca-file "$2"); shift 2 ;;
    --insecure-http) EXTRA+=(--insecure-http); shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[ -n "$SERVER" ] && [ -n "$TOKEN" ] || { echo "Usage: install.sh --server URL --token TOKEN" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required." >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required." >&2; exit 1; }

INSTALL_DIR=/opt/infra-agent
CONFIG=/etc/infra-agent/config.json
install -d -m 0755 "$INSTALL_DIR"
install -d -m 0700 /etc/infra-agent /var/backups/infra-agent

CURL_OPTS=(-fsSL)
for ((i=0; i<${#EXTRA[@]}; i++)); do
  if [ "${EXTRA[$i]}" = "--ca-file" ]; then CURL_OPTS+=(--cacert "${EXTRA[$((i+1))]}"); fi
done
curl "${CURL_OPTS[@]}" "${SERVER%/}/agent/infra_agent.py" -o "$INSTALL_DIR/infra_agent.py.new"
python3 -m py_compile "$INSTALL_DIR/infra_agent.py.new"
mv "$INSTALL_DIR/infra_agent.py.new" "$INSTALL_DIR/infra_agent.py"
chmod 0755 "$INSTALL_DIR/infra_agent.py"

if [ -f "$CONFIG" ]; then
  echo "Existing config found at $CONFIG; keeping it (delete it to re-enroll)."
else
  python3 "$INSTALL_DIR/infra_agent.py" --config "$CONFIG" enroll --server "$SERVER" --token "$TOKEN" ${EXTRA[@]+"${EXTRA[@]}"}
fi

cat > /etc/systemd/system/infra-agent.service <<UNIT
[Unit]
Description=Infra management agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env python3 $INSTALL_DIR/infra_agent.py --config $CONFIG run
Restart=always
RestartSec=10
User=root
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now infra-agent
echo "infra-agent installed and running. Logs: journalctl -u infra-agent -f"
echo "Free-form shell is DISABLED. To allow it, set \"allow_shell\": true in $CONFIG and restart the service."
