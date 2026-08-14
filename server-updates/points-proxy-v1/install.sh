#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

install -d -m 0700 /opt/product-operation-report
if ! id product-report-proxy >/dev/null 2>&1; then
  useradd --system --home /opt/product-operation-report --shell /usr/sbin/nologin product-report-proxy
fi
install -d -m 0750 -o root -g product-report-proxy /etc/product-operation-report
install -m 0755 product_report_proxy.py /opt/product-operation-report/product_report_proxy.py
install -m 0644 provider_keyring.py /opt/product-operation-report/provider_keyring.py
install -m 0750 rotate_provider_key.py /usr/local/sbin/product-report-rotate-key
install -m 0644 product-report-proxy.service /etc/systemd/system/product-report-proxy.service
install -d -m 0755 /etc/nginx/snippets /etc/nginx/conf.d
install -m 0644 nginx-proxy-common.conf /etc/nginx/snippets/product-operation-report-proxy.conf
install -m 0644 nginx-rate-limits.conf /etc/nginx/conf.d/product-operation-report-rate-limits.conf
if [[ ! -f /etc/product-operation-report/proxy.env ]]; then
  install -m 0600 proxy.env.example /etc/product-operation-report/proxy.env
  echo "Created /etc/product-operation-report/proxy.env." >&2
fi
if [[ ! -f /etc/product-operation-report/provider-keys.json ]]; then
  printf '%s\n' '{"version":1,"generation":0,"profiles":{},"models":{}}' \
    > /etc/product-operation-report/provider-keys.json
fi
chown product-report-proxy:product-report-proxy /etc/product-operation-report/provider-keys.json
chmod 0600 /etc/product-operation-report/provider-keys.json
chown -R product-report-proxy:product-report-proxy /opt/product-operation-report
systemctl daemon-reload
echo "Files installed but service was NOT started. Review proxy.env, configure the provider keyring, and review Nginx first."
