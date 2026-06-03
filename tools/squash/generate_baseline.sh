#!/usr/bin/env bash
# Task 0.6 — generate the squashed migration baseline.
#
# Runs ALL alembic migrations from zero on a DISPOSABLE Postgres, then dumps the resulting schema
# (0001_baseline.sql) + the migration-seeded data (0002_seed.sql). On a from-zero DB the ONLY rows
# are the migration SEEDS — backfill migrations no-op on empty data — so seed-vs-backfill needs no
# hand-classification: whatever rows exist ARE the canonical seeds.
#
# ⚠ DB-SAFETY: runs ONLY against a throwaway Postgres (default localhost:5434, codemaster-postgres:dev
# container). NEVER point this at the in-cluster `codemaster`-namespace Postgres.
set -euo pipefail
: "${DISPOSABLE_PG:=postgresql://postgres:postgres@localhost:5434}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SUBMODULE="$(cd "$HERE/../../vendor/codemaster-py" && pwd)"
OUT="$HERE/../../migrations"; mkdir -p "$OUT"

psql "$DISPOSABLE_PG/postgres" -c "DROP DATABASE IF EXISTS cm_ref"
psql "$DISPOSABLE_PG/postgres" -c "CREATE DATABASE cm_ref"

# Canonical end-state: all migrations from zero (alembic env.py rewrites +asyncpg -> +psycopg).
( cd "$SUBMODULE" && CODEMASTER_PG_CORE_DSN="${DISPOSABLE_PG/postgresql:/postgresql+psycopg:}/cm_ref" \
    .venv/bin/alembic upgrade head )

# node-pg-migrate runs these via the `pg` driver, NOT psql — so the dumps MUST be free of psql-only
# constructs or `npm run migrate:up` fails with `syntax error at or near "\"` (code 42601):
#   * `\restrict` / `\unrestrict` — PG17+ pg_dump access-control meta-commands (psql-only). Stripped.
#   * `COPY ... FROM stdin` — the inline-data COPY protocol is psql-only; we dump seeds as
#     `--column-inserts` (portable INSERTs the pg driver can execute) instead. See README "Migrations".

# 0001 schema. pg_dump OMITS the extensions, so prepend them. Strip session-SET noise, CONCURRENTLY
# (a fresh DB needs no concurrent index builds), and the psql-only \restrict/\unrestrict wrapper.
{
  printf 'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;\n'
  printf 'CREATE SCHEMA IF NOT EXISTS partman;\n'
  printf 'CREATE EXTENSION IF NOT EXISTS pg_partman WITH SCHEMA partman;\n'
  pg_dump "$DISPOSABLE_PG/cm_ref" --schema-only --no-owner --no-privileges \
    --schema=core --schema=audit --schema=cache --schema=telemetry
} | sed -e '/^SET /d' -e '/^SELECT pg_catalog.set_config/d' -e 's/ CONCURRENTLY//g' \
        -e '/^\\restrict/d' -e '/^\\unrestrict/d' > "$OUT/0001_baseline.sql"

# 0002 seeds — data-only (a from-zero DB holds ONLY migration seeds). --column-inserts (NOT the default
# COPY) so node-pg-migrate's pg driver can run them; strip the same psql-only noise as 0001.
pg_dump "$DISPOSABLE_PG/cm_ref" --data-only --column-inserts --no-owner \
  --schema=core --schema=audit --schema=cache --schema=telemetry \
  | sed -e '/^SET /d' -e '/^SELECT pg_catalog.set_config/d' \
        -e '/^\\restrict/d' -e '/^\\unrestrict/d' > "$OUT/0002_seed.sql"

echo "wrote $OUT/0001_baseline.sql + $OUT/0002_seed.sql"
