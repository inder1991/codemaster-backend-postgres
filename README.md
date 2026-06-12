# codemaster-backend

The **codemaster** backend — an internal AI PR-review platform. TypeScript/Node.js.

A GitHub webhook (PR opened/updated) drives a review: the service clones the repo, classifies and
chunks the diff, runs static analysis + retrieval over your knowledge base, fans the chunks out to an
LLM, sanitizes and aggregates the findings, and posts a review with inline comments back to the PR.

> **Lineage.** This backend began as a 1:1 TypeScript port of an internal Python service, which used
> Temporal for orchestration. Both are now gone: the port is complete, and Temporal was replaced by a
> **Postgres-backed job runner** (see *Runtime* below). The Python parity oracle that proved the port
> has been retired — equivalence is now held by the TS test suite + the live smoke. (Some source
> comments still reference the original Python for historical rationale.)

## Runtime

One process / one pod runs **everything** (`apps/backend/src/main.ts`): the HTTP API **and** the
background runtime — there is no separate worker and no external orchestrator.

`CODEMASTER_RUNTIME_MODE` selects the runtime:

- `postgres` (default) — the live background runner: a **review-job runner**, a **scheduler** (cron
  loop over `core.scheduled_jobs`), and an **outbox-drain loop** over `core.outbox`. Work is durable
  in Postgres (`review_jobs` / `background_jobs` / `scheduled_jobs` / `outbox`) with lease + fence +
  attempt discipline, so the runtime is crash-safe and resumable — the role Temporal's event history
  used to play, now held by DB state.
- `shadow` — the same runner in observe-only mode (no side effects).

Boot is fail-loud: a schema-revision preflight, the field-encryption key load, and the dependency
checks (`/readyz`: Postgres + Vault + runtime-loop liveness) all gate before the server serves.

## Layout

```
libs/
  contracts/src/   Zod schemas for every wire/storage contract (one <name>.v1.ts)
  platform/src/    cross-cutting primitives: clock, randomness, db (pool, tenancy), observability
apps/backend/src/
  main.ts          the combined entrypoint (HTTP API + background runtime)
  api/             Fastify routes (webhook ingest, admin, auth) + readiness checks
  runner/          the Postgres runtime: review-job runner, scheduler, outbox-drain loop, handlers
  review/pipeline/ the review orchestrator + stages (classify, chunk, static-analysis, retrieve, review)
  activities/      the activity bodies the runner dispatches in-process
  cost/            the lock-free per-call cost-cap enforcer + the cost journal
  integrations/    LLM (Bedrock/Anthropic), GitHub, git, Vault
migrations/         up-only SQL migrations (node-pg-migrate), squashed baseline + additive on top
scripts/gates/      ts-morph CI gates (run by `npm run gates`)
test/{unit,integration,gates,smoke}/   unit (no DB) · real-DB integration · gate tests · static smokes
deploy/             Helm chart (codemaster-backend) + local-kind manifests
```

### Import convention

Cross-directory imports into the shared libs use **Node subpath imports** (`package.json` `imports`),
resolved natively by `tsc`, `tsx`, and `vitest` — not deep relative paths:

```ts
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { WallClock }       from "#platform/clock.js";
// #backend/* maps to apps/backend/src/* (app-internal imports).
```

Same-directory imports stay relative (`./clock.js`). The production build (`dist/`) resolves the
emitted JS via a `default` condition; dev/test resolve source.

## Commands

| Command | What it does |
|---|---|
| `npm run validate-fast` | gates → lint → typecheck → test (the one check before declaring work done) |
| `npm run gates` | ts-morph CI gates only (incl. the `no-temporal-imports` lock + tenancy/clock/migration gates) |
| `npm run lint` / `npm run typecheck` / `npm run test` | individually |
| `npm run build` | emit `dist/` (production code only; tests excluded) |
| `npm run migrate:up` | apply DB migrations (needs `CODEMASTER_PG_CORE_DSN`). **Up-only** — `migrate:down` is disabled and fails loudly (recreate a throwaway DB instead) |
| `npm run test:integration` | real-DB integration tests (needs `CODEMASTER_PG_CORE_DSN`; else they skip) |

DB-integration tests (`test/integration/**`) **skip** in `npm run test` / `validate-fast` unless
`CODEMASTER_PG_CORE_DSN` is set, so the default check stays green and fast without a database. To run
them against a throwaway Postgres (**never** a shared/cluster DB):

```bash
docker run -d --name cm-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -p 5434:5432 codemaster-postgres:dev
export CODEMASTER_PG_CORE_DSN=postgresql://postgres:postgres@localhost:5434/postgres
npm run migrate:up && npm run test:integration
```

The raw-SQL tenancy gate scans production source (`{libs,apps}/*/src`) in ERROR mode — test teardown
legitimately crosses tenants and is out of scope.

## Migrations

`migrations/0001_baseline.sql` is the squashed schema baseline; every later migration is **additive
on top** (node-pg-migrate, ordered by filename). Migrations are **up-only** — a squashed baseline is
irreversible by design, so recreate a throwaway database rather than rolling back. `CODEMASTER_PG_CORE_DSN`
is a plain libpq URL (`postgresql://user:pass@host:port/db`). **Never run migrations against a
shared/cluster database.**

## Deploy

The Helm chart is `deploy/helm/codemaster-backend` (`config.runtime.mode` selects postgres|shadow;
secrets come from Vault, never the ConfigMap). `deploy/local-kind/` holds throwaway-cluster manifests;
`scripts/live_cluster_smoke.sh` runs an end-to-end smoke (real webhook → review posted) against a kind
deployment.
