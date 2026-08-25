#!/usr/bin/env bash
set -euo pipefail

SERVICE="product-report-proxy-staging-v101"
RUN_USER="product-report-proxy"
APP_DIR="/opt/product-operation-report-staging-v101"
CONF_DIR="/etc/product-operation-report-staging-v101"
PROD_CONF="/etc/product-operation-report"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ "$(id -u)" != "0" ]]; then
  echo "ERROR: root is required" >&2
  exit 1
fi
for file in product_report_proxy.py provider_keyring.py rotate_provider_key.py; do
  [[ -f "$file" ]] || { echo "ERROR: missing $file" >&2; exit 1; }
done
[[ -f "$PROD_CONF/proxy.env" ]] || { echo "ERROR: production proxy.env not found" >&2; exit 1; }
[[ -f "$PROD_CONF/provider-keys.json" ]] || { echo "ERROR: production provider keyring not found" >&2; exit 1; }

echo "PRODUCTION_BEFORE=$(curl -fsS http://127.0.0.1:8794/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"ok":d.get("ok"),"models":d.get("models")},ensure_ascii=True))')"

if ss -ltn '( sport = :8796 )' | grep -q ':8796'; then
  if ! systemctl is-active --quiet "$SERVICE.service"; then
    echo "ERROR: port 8796 is occupied by another service" >&2
    exit 1
  fi
fi

systemctl stop "$SERVICE.service" 2>/dev/null || true
install -d -m 0700 "$APP_DIR" "$CONF_DIR"
if [[ -f "$APP_DIR/product_report_proxy.py" ]]; then
  install -d -m 0700 "$APP_DIR/backups/$STAMP"
  cp -a "$APP_DIR/product_report_proxy.py" "$APP_DIR/provider_keyring.py" "$APP_DIR/rotate_provider_key.py" "$APP_DIR/backups/$STAMP/" 2>/dev/null || true
  cp -a "$APP_DIR/points.sqlite3" "$APP_DIR/backups/$STAMP/" 2>/dev/null || true
  cp -a "$CONF_DIR/proxy.env" "$CONF_DIR/provider-keys.json" "$APP_DIR/backups/$STAMP/" 2>/dev/null || true
fi

install -m 0755 product_report_proxy.py "$APP_DIR/product_report_proxy.py"
install -m 0644 provider_keyring.py "$APP_DIR/provider_keyring.py"
install -m 0750 rotate_provider_key.py "$APP_DIR/rotate_provider_key.py"
install -m 0600 "$PROD_CONF/provider-keys.json" "$CONF_DIR/provider-keys.json"

python3 - "$CONF_DIR/provider-keys.json" "$STAMP" <<'PY'
import json, os, sys
path, stamp = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)
if data.get("version") != 1 or not isinstance(data.get("models"), dict):
    raise SystemExit("ERROR: invalid provider keyring")
profile = data["models"].get("gpt-5.5")
if not isinstance(profile, str) or not profile:
    raise SystemExit("ERROR: gpt-5.5 provider profile is missing")
data["models"]["gpt-5.6-sol"] = profile
data["generation"] = f"{data.get('generation', '1')}-staging-v101-{stamp}"
temporary = path + ".tmp"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.replace(temporary, path)
PY

cat > "$CONF_DIR/proxy.env" <<'EOF'
POR_PROXY_HOST=127.0.0.1
POR_PROXY_PORT=8796
POR_POINTS_DB=/opt/product-operation-report-staging-v101/points.sqlite3
POR_PROVIDER_KEYS_FILE=/etc/product-operation-report-staging-v101/provider-keys.json
POR_WEB_SEARCH_REPORT_LIMIT=14
EOF

cat > "/etc/systemd/system/$SERVICE.service" <<'EOF'
[Unit]
Description=ProductOperationReport isolated v1.0.1 proxy
After=network-online.target license.service
Wants=network-online.target

[Service]
Type=simple
User=product-report-proxy
Group=product-report-proxy
EnvironmentFile=/etc/product-operation-report/proxy.env
EnvironmentFile=/etc/product-operation-report-staging-v101/proxy.env
ExecStart=/usr/bin/python3 /opt/product-operation-report-staging-v101/product_report_proxy.py
Restart=on-failure
RestartSec=3
TasksMax=128
MemoryHigh=768M
MemoryMax=1G
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/product-operation-report-staging-v101
ReadOnlyPaths=/etc/product-operation-report /etc/product-operation-report-staging-v101
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
MemoryDenyWriteExecute=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

chown -R "$RUN_USER:$RUN_USER" "$APP_DIR" "$CONF_DIR"
chmod 0700 "$APP_DIR" "$CONF_DIR"
chmod 0600 "$CONF_DIR/proxy.env" "$CONF_DIR/provider-keys.json"
systemctl daemon-reload
systemctl start "$SERVICE.service"

for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8796/health >/tmp/por-staging-v101-health.json; then
    break
  fi
  sleep 1
done
if ! systemctl is-active --quiet "$SERVICE.service"; then
  journalctl -u "$SERVICE.service" -n 60 --no-pager >&2
  exit 1
fi

echo "STAGING_HEALTH=$(python3 -c 'import json; d=json.load(open("/tmp/por-staging-v101-health.json")); print(json.dumps({"ok":d.get("ok"),"models":d.get("models"),"provider_keyring":d.get("provider_keyring")},ensure_ascii=True))')"
echo "PRODUCTION_AFTER=$(curl -fsS http://127.0.0.1:8794/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"ok":d.get("ok"),"models":d.get("models")},ensure_ascii=True))')"
echo "STAGING_DEPLOY_COMPLETE=true"
