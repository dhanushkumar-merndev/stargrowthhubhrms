#!/usr/bin/env bash
# Disposable test database = the same Supabase Postgres 17 image as production
# (pg_cron, pg_net, vault, postgis preloaded). Data lives in tmpfs and is
# destroyed with the container. NEVER point this at a hosted database.
#
#   tools/db_test.sh            start fresh DB, apply migrations, run all SQL suites
#   tools/db_test.sh hrms/04*   only matching suites (relative to server/tests/sql)
#   tools/db_test.sh --migrate  start fresh DB + migrations, leave it running
#   tools/db_test.sh --empty    start fresh empty DB, leave it running (for cargo test --test api)
#   tools/db_test.sh --stop     remove the container
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${HRMS_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.11.0.018}"
NAME="web-hrms-testdb"
PORT="${HRMS_TEST_PG_PORT:-54330}"

if [[ "${1:-}" == "--stop" ]]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; exit 0; fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5432" \
  -e POSTGRES_PASSWORD=postgres --tmpfs /var/lib/postgresql/data:rw \
  -v "$ROOT/server:/work:ro" "$IMAGE" >/dev/null

PSQL=(docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$NAME" psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)
for _ in $(seq 1 90); do
  docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && \
    "${PSQL[@]}" -c "select 1" >/dev/null 2>&1 && break
  sleep 1
done
export PGPASSWORD=postgres
# --empty: no migrations (the Rust API tests run them through sqlx, like production).
[[ "${1:-}" == "--empty" ]] && { echo "test DB: postgres://postgres:postgres@127.0.0.1:$PORT/postgres"; exit 0; }

n=0
for f in "$ROOT"/server/migrations/*.sql; do
  b=$(basename "$f")
  if ! out=$("${PSQL[@]}" -1 -f "/work/migrations/$b" 2>&1); then
    echo "MIGRATION FAILED: $b"; echo "$out" | tail -25; exit 1
  fi
  n=$((n+1))
done
echo "migrations: applied $n files"
[[ "${1:-}" == "--migrate" ]] && { echo "test DB: postgres://postgres:postgres@127.0.0.1:$PORT/postgres"; exit 0; }

pattern="${1:-*/*.sql}"
pass=0; fail=0; total=0
for t in "$ROOT"/server/tests/sql/$pattern; do
  b=$(basename "$t"); dir=$(basename "$(dirname "$t")")
  [[ "$b" == _* ]] && continue
  # Each suite gets its own harness (rolled back with the suite where it uses begin/rollback).
  pre=""
  [[ -f "$ROOT/server/tests/sql/$dir/_harness.sql" ]] && pre="-f /work/tests/sql/$dir/_harness.sql"
  [[ -f "$ROOT/server/tests/sql/$dir/_prelude.sql" ]] && pre="-f /work/tests/sql/$dir/_prelude.sql"
  [[ "$dir" == web ]] && pre="-f /work/tests/sql/hrms/_harness.sql"   # web-hrms suites reuse the HRMS harness
  if out=$("${PSQL[@]}" -At $pre -f "/work/tests/sql/$dir/$b" 2>&1); then
    c=$(grep -cE '^ok |NOTICE:  ok - ' <<<"$out" || true)
    echo "PASS  $dir/$b  ($c assertions)"; pass=$((pass+1)); total=$((total+c))
  else
    echo "FAIL  $dir/$b"; echo "$out" | grep -vE '^ok |NOTICE:  ok - |^\s*$' | tail -15 | sed 's/^/      /'; fail=$((fail+1))
  fi
done
echo "suites: $pass passed, $fail failed, $total assertions"
docker rm -f "$NAME" >/dev/null
[[ $fail -eq 0 ]]
