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

# 0001 schema. pg_dump OMITS the extensions, so prepend them. Strip session-SET noise + CONCURRENTLY
# (a fresh DB needs no concurrent index builds).
{
  printf 'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;\n'
  printf 'CREATE SCHEMA IF NOT EXISTS partman;\n'
  printf 'CREATE EXTENSION IF NOT EXISTS pg_partman WITH SCHEMA partman;\n'
  pg_dump "$DISPOSABLE_PG/cm_ref" --schema-only --no-owner --no-privileges \
    --schema=core --schema=audit --schema=cache --schema=telemetry
} | sed -e '/^SET /d' -e '/^SELECT pg_catalog.set_config/d' -e 's/ CONCURRENTLY//g' > "$OUT/0001_baseline.sql"

# 0002 seeds — data-only (a from-zero DB holds ONLY migration seeds).
pg_dump "$DISPOSABLE_PG/cm_ref" --data-only --no-owner \
  --schema=core --schema=audit --schema=cache --schema=telemetry \
  | sed -e '/^SET /d' -e '/^SELECT pg_catalog.set_config/d' > "$OUT/0002_seed.sql"

echo "wrote $OUT/0001_baseline.sql + $OUT/0002_seed.sql"
