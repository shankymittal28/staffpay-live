#!/usr/bin/env bash
# Disposable D3 test environment: a throw-away PostgreSQL database with the
# production-mirror schema (base_schema.sql) and, unless D3=0, the D3
# migration; plus PostgREST in front of it, signing tokens the way Supabase
# does (HS256, role + sub claims). Nothing here touches production.
#
#   PGPORT=54329 PGHOST=/tmp  (a running local PostgreSQL 16 cluster)
#   POSTGREST=/path/to/postgrest   (v12.2.3 static binary; default /var/tmp/postgrest)
#   test_d3/env.sh up [dbname]     -> creates db, starts PostgREST on :3010
#   test_d3/env.sh down
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
export PGHOST="${PGHOST:-/tmp}" PGPORT="${PGPORT:-54329}" PGUSER=postgres
DB="${2:-d3test}"; API_PORT="${API_PORT:-3010}"
SECRET="${JWT_SECRET:-d3-disposable-secret-d3-disposable-secret}"
RUN="${RUN_DIR:-/var/tmp/d3run}"; mkdir -p "$RUN"
case "${1:-up}" in
  up)
    psql -q -d postgres -c "drop database if exists $DB with (force)" >/dev/null
    psql -q -d postgres -c "create database $DB" >/dev/null
    psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/base_schema.sql" >/dev/null
    if [ "${D3:-1}" = "1" ]; then psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/sql/d3_weekly_hisab_v1.sql" >/dev/null; fi
    # tests pin "today" by redefining this one helper inside the disposable db
    if [ -n "${D3_TODAY:-}" ] && [ "${D3:-1}" = "1" ]; then
      psql -q -d "$DB" -c "create or replace function staffpay_d3.today() returns date language sql stable as \$\$ select '${D3_TODAY}'::date \$\$" >/dev/null
    fi
    pkill -f "$RUN/postgrest.conf" 2>/dev/null || true; sleep 0.5
    cat > "$RUN/postgrest.conf" <<EOF
db-uri = "postgres://authenticator:auth@localhost:$PGPORT/$DB?host=$PGHOST"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$SECRET"
server-port = $API_PORT
db-max-rows = 1000
EOF
    "${POSTGREST:-/var/tmp/postgrest}" "$RUN/postgrest.conf" > "$RUN/postgrest.log" 2>&1 &
    echo $! > "$RUN/postgrest.pid"
    for i in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$API_PORT/" && break; sleep 0.2; done
    kill -0 "$(cat "$RUN/postgrest.pid")" 2>/dev/null || { cat "$RUN/postgrest.log"; exit 1; }
    echo "up: db=$DB api=http://127.0.0.1:$API_PORT";;
  down)
    pkill -f "$RUN/postgrest.conf" 2>/dev/null || true
    psql -q -d postgres -c "drop database if exists $DB with (force)" >/dev/null; echo down;;
esac
