# codemaster-backend

TypeScript/Node.js port of the **codemaster** backend (an internal AI PR-review platform). This is a
1:1 migration of the frozen Python source — pinned as the `vendor/codemaster-py` submodule at tag
`migration-source-freeze` — proven equivalent by a two-tier parity harness (see below). The Python
repo is frozen; all new backend development happens here.

## Layout

```
libs/
  contracts/src/   Zod ports of the Python contracts/ (one <name>.v1.ts per contracts/<name>/v1.py)
  platform/src/    cross-cutting primitives: clock, randomness (+ _mt19937), … (Python codemaster/infra/)
apps/backend/       (Phase 1+) the modular monolith — two deploy entrypoints: backend.api, backend.worker
migrations/         single squashed baseline (0001_baseline.sql) + seeds (0002_seed.sql), via node-pg-migrate
scripts/gates/      ts-morph CI gates (ports of the Python scripts/check_*.py) — run by `npm run gates`
test/
  contracts/        Pydantic↔Zod parity tests, one per contract
  unit/             ported unit tests (mirrors the source tree under test/unit/<subsystem>/)
  gates/            tests for the CI gates
  parity/           the parity harness (oracle, canonicalizer, path-map, random oracle)
  cassettes/        golden HTTP/response fixtures for external services
tools/
  parity/           Python ref drivers the parity harness shells into (run against the submodule venv)
  squash/           the Task 0.6 migration-squash + parity scripts
  workflows/         multi-agent orchestration scripts (run by the Workflow runtime; not app code)
```

### Import convention

Cross-directory imports into the shared libs use **Node subpath imports** (`package.json` `imports`),
not deep relative paths — resolved natively by `tsc`, `tsx`, and `vitest`:

```ts
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { WallClock }       from "#platform/clock.js";
// #backend/* is reserved for apps/backend/src/backend/* (Phase 1+).
```

Same-directory imports stay relative (`./clock.js`). When the production build (`dist/`) and the
`backend.api`/`backend.worker` entrypoints land in Phase 1, the `imports` map gains a `default →
./dist/...` condition so prod resolves the emitted JS while dev/test keep resolving source.

## Commands

| Command | What it does |
|---|---|
| `npm run validate-fast` | gates → lint → typecheck → test (the one gate before declaring work done) |
| `npm run gates` | ts-morph CI gates only |
| `npm run lint` / `npm run typecheck` / `npm run test` | individually |
| `npm run build` | emit `dist/` (production code only; tests excluded) |
| `npm run migrate:up` / `migrate:down` | apply / revert DB migrations (needs `CODEMASTER_PG_CORE_DSN`) |
| `npm run test:integration` | real-DB integration tests (needs `CODEMASTER_PG_CORE_DSN`; else they skip) |
| `npm run test:magika` | opt-in cross-impl magika label-agreement (~150s, loads an ONNX model) |

DB-integration tests (`test/integration/**`) **skip** in `npm run test` / `validate-fast` unless
`CODEMASTER_PG_CORE_DSN` is set, so the default gate stays green and fast without a database. To run
them against a throwaway Postgres (never a shared/cluster DB):

```bash
docker run -d --name cm-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -p 5434:5432 codemaster-postgres:dev
docker exec cm-pg psql -U postgres -c 'CREATE DATABASE codemaster'
export CODEMASTER_PG_CORE_DSN=postgresql://postgres:postgres@localhost:5434/codemaster
npm run migrate:up && npm run test:integration
```

CI runs `test:integration` (and `test:magika`) in a dedicated job that provisions the Postgres + the
frozen submodule venv. The raw-SQL tenancy gate scans **production source only** (`{libs,apps}/*/src`),
matching the frozen Python gate — test teardown legitimately crosses tenants and is out of scope.

## Parity model (how 1:1 is proven)

- **Tier-A (function/contract level):** the harness shells into the frozen submodule's venv, runs the
  Python original, and diffs canonical JSON against the TS port. Most contracts and pure functions.
  Floats that can't round-trip canonically (and the randomness seam) are compared by IEEE-754 hex bits.
- **Tier-B (end-to-end dual-run):** both backends run on parallel Temporal task queues against
  isolated DB schemas with cassette-pinned LLM + fixed clock + seeded randomness; persisted findings
  and the posted review are diffed. Any non-determinism source left live invalidates the comparison.

## Migrations

`migrations/0001_baseline.sql` is the squash of the 123 source alembic migrations into one schema
baseline (parity-proven — see `tools/squash/verify_parity.sh`); `0002_seed.sql` is the migration-seeded
data. They are **up-only** (a squashed baseline is irreversible by design — recreate the database
rather than rolling it back). `CODEMASTER_PG_CORE_DSN` is a plain libpq URL
(`postgresql://user:pass@host:port/db`). **Never run migrations against a shared/cluster database** —
use a throwaway Postgres (see `tools/squash/`).
