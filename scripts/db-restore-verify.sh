#!/usr/bin/env bash
# Restores a backup into a NEW, empty database and verifies it (12.2).
# Never overwrites: the target must not exist. Uses the libpq environment
# for credentials (see db-backup.sh). Optional SOURCE_DATABASE compares row
# counts of the critical tables with the database the backup came from.
# Usage: scripts/db-restore-verify.sh <file.dump> <new_database>
#        [SOURCE_DATABASE=skyrim] [DROP_AFTER=1]
set -euo pipefail
dump="${1:?usage: db-restore-verify.sh <file.dump> <new_database>}"
target="${2:?usage: db-restore-verify.sh <file.dump> <new_database>}"
: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
[[ "$target" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "Invalid target name"; exit 2; }
exists="$(psql -X -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$target'")"
[ -z "$exists" ] || { echo "Refusing: database $target already exists (never overwritten)"; exit 2; }
if [ -f "${dump%.dump}.meta.json" ]; then
  expected="$(sed -n 's/.*"sha256": "\(.*\)".*/\1/p' "${dump%.dump}.meta.json")"
  actual="$(sha256sum "$dump" | cut -d' ' -f1)"
  [ "$expected" = "$actual" ] || { echo "FAIL checksum mismatch"; exit 1; }
  echo "OK    checksum matches metadata"
fi
pg_restore --list "$dump" > /dev/null
echo "OK    archive readable ($(pg_restore --list "$dump" | grep -vc '^;') entries)"
createdb "$target"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$target" "$dump"
echo "OK    restored into $target"
q() { psql -X -At -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }
status=0
critical=(migrations staff_users staff_sessions roles permissions role_permissions
  audit_logs game_servers game_connections game_commands game_command_results
  game_agent_credentials server_control_operations players player_sessions
  player_characters economy_accounts economy_transactions economy_entries
  player_trades player_marketplace_listings player_marketplace_item_releases
  vip_offers player_vip_entitlements vip_reward_deliveries
  agent_domain_event_receipts)
for table in "${critical[@]}"; do
  if [ "$(q "$target" "SELECT to_regclass('public.$table') IS NOT NULL")" != t ]; then
    echo "FAIL  missing table $table"; status=1; continue
  fi
  restored="$(q "$target" "SELECT count(*) FROM public.$table")"
  if [ -n "${SOURCE_DATABASE:-}" ]; then
    source="$(q "$SOURCE_DATABASE" "SELECT count(*) FROM public.$table")"
    if [ "$source" = "$restored" ]; then echo "OK    $table rows=$restored"
    else echo "FAIL  $table rows=$restored source=$source"; status=1; fi
  else echo "OK    $table rows=$restored"; fi
done
for trigger in audit_logs_immutable economy_entries_immutable economy_entries_balanced economy_transactions_immutable; do
  [ "$(q "$target" "SELECT count(*) FROM pg_trigger WHERE tgname = '$trigger' AND tgrelid::regclass::text NOT LIKE '%.%'")" -ge 1 ] \
    && echo "OK    trigger $trigger" || { echo "FAIL  trigger $trigger missing"; status=1; }
done
[ "$(q "$target" "SELECT count(*) FROM pg_extension WHERE extname = 'uuid-ossp'")" = 1 ] \
  && echo "OK    extension uuid-ossp" || { echo "FAIL  extension uuid-ossp missing"; status=1; }
echo "INFO  migrations=$(q "$target" "SELECT count(*) FROM migrations") latest=$(q "$target" "SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1")"
echo "NEXT  run the preflight against $target: DB_DATABASE=$target npm run preflight -- --require-current"
if [ "${DROP_AFTER:-0}" = 1 ]; then dropdb "$target"; echo "INFO  dropped $target"; fi
exit $status
