#!/usr/bin/env bash
# Installiert den Darts Turnierplaner auf Debian 12/13 (z. B. Proxmox-LXC).
#
#   Aufruf als root im geklonten Repository:
#     bash deploy/install.sh darts.example.de
#
# Danach läuft die App als eigener Benutzer hinter Caddy (HTTPS).
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/darts/app
DATA_DIR=/opt/darts/data
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Bitte als root ausführen." >&2
  exit 1
fi
if [[ -z "$DOMAIN" ]]; then
  echo "Aufruf: bash deploy/install.sh <domain>   (z. B. darts.example.de)" >&2
  exit 1
fi

echo "==> Pakete installieren"
apt-get update
apt-get install -y nodejs caddy unattended-upgrades rsync

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  echo "Node.js $NODE_MAJOR ist zu alt (mindestens 18 nötig)." >&2
  exit 1
fi

echo "==> Automatische Sicherheitsupdates aktivieren"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Benutzer und Verzeichnisse"
id darts &>/dev/null || useradd --system --home /opt/darts --shell /usr/sbin/nologin darts
mkdir -p "$APP_DIR" "$DATA_DIR"

if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  rsync -a --delete --exclude .git --exclude data "$SRC_DIR"/ "$APP_DIR"/
fi
# Code gehört root (Dienst kann ihn nicht verändern), Daten gehören dem Dienst
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"
chown -R darts:darts "$DATA_DIR"
chmod 700 "$DATA_DIR"

echo "==> systemd-Dienst"
install -m 644 "$APP_DIR/deploy/darts.service" /etc/systemd/system/darts.service
systemctl daemon-reload
systemctl enable --now darts

echo "==> Caddy (HTTPS) für $DOMAIN"
install -m 644 "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=DARTS_DOMAIN=%s\n' "$DOMAIN" > /etc/systemd/system/caddy.service.d/domain.conf
systemctl daemon-reload
systemctl enable caddy
systemctl restart caddy

sleep 2
echo
echo "Fertig! Die Seite ist gleich unter https://$DOMAIN erreichbar."
echo "Setup-Code für den ersten Admin-Account:"
journalctl -u darts --no-pager | grep -A1 "Setup-Code" | tail -1 || true
