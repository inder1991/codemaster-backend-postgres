#!/usr/bin/env bash
# Task 0.6 — prove the squashed baseline reproduces the migration end-state.
#
# Builds cm_base from 0001_baseline.sql + 0002_seed.sql, then catalog-diffs it against cm_ref (the
# 123-migration DB produced by generate_baseline.sh). Exits non-zero on any REAL difference.
# Constraints are normalized for the cosmetic pg_dump array-cast rendering (semantically equal).
#
# ⚠ DB-SAFETY: disposable Postgres only (default localhost:5434). Never the in-cluster DB.
set -euo pipefail
: "${DISPOSABLE_PG:=postgresql://postgres:postgres@localhost:5434}"
OUT="$(cd "$(dirname "$0")/../../migrations" && pwd)"
SCHEMAS="'core','audit','cache','telemetry'"
NS="'core'::regnamespace,'audit'::regnamespace,'cache'::regnamespace,'telemetry'::regnamespace"

psql "$DISPOSABLE_PG/postgres" -c "DROP DATABASE IF EXISTS cm_base"
psql "$DISPOSABLE_PG/postgres" -c "CREATE DATABASE cm_base"
psql "$DISPOSABLE_PG/cm_base" -v ON_ERROR_STOP=1 -q -f "$OUT/0001_baseline.sql"
psql "$DISPOSABLE_PG/cm_base" -v ON_ERROR_STOP=1 -q -f "$OUT/0002_seed.sql"

fail=0
diffcat () { # name  sql
  psql "$DISPOSABLE_PG/cm_ref"  -tAc "$2" | sort > /tmp/sq_r.txt
  psql "$DISPOSABLE_PG/cm_base" -tAc "$2" | sort > /tmp/sq_b.txt
  local n; n=$(diff /tmp/sq_r.txt /tmp/sq_b.txt | grep -c '^[<>]' || true)
  if [ "$n" = 0 ]; then echo "  OK   $1"; else echo "  FAIL $1 ($n diffs)"; diff /tmp/sq_r.txt /tmp/sq_b.txt | head -6; fail=1; fi
}
diffcat columns     "select table_schema||'.'||table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') from information_schema.columns where table_schema in ($SCHEMAS)"
# constraints: normalize casts/parens/ws (pg_dump renders IN-list array casts differently; semantically equal)
diffcat constraints "select conrelid::regclass::text||':'||conname||':'||regexp_replace(regexp_replace(pg_get_constraintdef(oid),'::[a-z_ \[\]]+','','g'),'[() ]','','g') from pg_constraint where connamespace in ($NS)"
diffcat indexes     "select schemaname||':'||indexname||':'||indexdef from pg_indexes where schemaname in ($SCHEMAS)"
diffcat enums       "select t.typname||':'||e.enumlabel||':'||e.enumsortorder::text from pg_type t join pg_enum e on e.enumtypid=t.oid"
diffcat functions   "select proname||':'||pg_get_functiondef(oid) from pg_proc where pronamespace in ($NS)"
diffcat triggers    "select tgname||':'||tgrelid::regclass::text||':'||pg_get_triggerdef(oid) from pg_trigger where not tgisinternal"
diffcat seed-rows   "select schemaname||'.'||relname from pg_stat_user_tables where schemaname in ($SCHEMAS) and n_live_tup>0"

[ "$fail" = 0 ] && echo "SQUASH PARITY: baseline == 123 migrations ✓" || { echo "SQUASH PARITY FAILED"; exit 1; }
