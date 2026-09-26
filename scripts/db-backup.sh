#!/usr/bin/env bash
# PostgreSQL logical backup of the Skyrim Admin API database (12.2).
# Custom-format pg_dump (compressed, selective restore) plus a metadata file.
# Credentials come from the libpq environment (PGHOST, PGPORT, PGUSER,
# PGDATABASE, and PGPASSWORD or a ~/.pgpass / PGPASSFILE); nothing secret is
# passed on the command line or written to the metadata.
# Usage: BACKUP_DIR=/secure/backups scripts/db-backup.sh
set -euo pipefail
: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="$BACKUP_DIR/skyrim-${PGDATABASE}-${stamp}"
# Whole database: schema, data, the uuid-ossp extension and triggers.
pg_dump --format=custom --compress=6 --no-owner --no-privileges \
  --file="$base.dump.partial"
mv "$base.dump.partial" "$base.dump"
# The archive must be readable before it counts as a backup.
entries="$(pg_restore --list "$base.dump" | grep -vc '^;')"
q() { psql -X -At -v ON_ERROR_STOP=1 -c "$1"; }
server_version="$(q "SHOW server_version")"
migrations="$(q "SELECT count(*) FROM migrations")"
latest="$(q "SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1")"
size="$(stat -c %s "$base.dump")"
sha256="$(sha256sum "$base.dump" | cut -d' ' -f1)"
cat > "$base.meta.json" <<JSON
{
  "file": "$(basename "$base.dump")",
  "createdAt": "$stamp",
  "database": "$PGDATABASE",
  "serverVersion": "$server_version",
  "pgDumpVersion": "$(pg_dump --version | awk '{print $3}')",
  "format": "custom",
  "archiveEntries": $entries,
  "migrationsApplied": $migrations,
  "latestMigration": "$latest",
  "sizeBytes": $size,
  "sha256": "$sha256"
}
JSON
echo "Backup written: $base.dump ($size bytes, $entries entries, $migrations migrations, latest $latest)"
