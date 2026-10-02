#!/usr/bin/env bash
# Tägliches Backup der Daten, z. B. per Cronjob:
#   echo '15 3 * * * root /opt/darts/app/deploy/backup.sh' > /etc/cron.d/darts-backup
set -euo pipefail
SRC=/opt/darts/data/db.json
DEST=/opt/darts/backups
KEEP_DAYS=30

mkdir -p "$DEST"
chmod 700 "$DEST"
[[ -f "$SRC" ]] || exit 0
cp "$SRC" "$DEST/db-$(date +%F).json"
chmod 600 "$DEST"/db-*.json
find "$DEST" -name 'db-*.json' -mtime +"$KEEP_DAYS" -delete
