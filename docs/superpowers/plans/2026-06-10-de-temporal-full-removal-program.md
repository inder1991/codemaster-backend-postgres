# De-Temporal Full-Removal Program

> **Owner directive (2026-06-10, non-negotiable):** Temporal is removed **entirely**. Every workflow migrates to a Postgres-backed runner/scheduler; the Temporal runtime (Server, `@temporalio/*`, worker, sandbox, client adapters, schedule bootstrap, helm chart) is torn out. There is **no** "keep Temporal for some workloads" option.

**Goal:** codemaster-backend runs with **zero** Temporal, every feature intact, proven by per-workflow parity gates + a final end-to-end smoke.

**Execution model:** the project owner orchestrates (design, sequencing, parity-gate definition, controller-level verification); **fable-5 agents** implement and review each piece (dispatched via the Workflow tool, `model: claude-fable-5`), strict TDD against the disposable `:5434` DB. Each migrated workflow gets a **parity gate** (same trigger → byte-compare the Postgres-handler output vs. the Temporal path) before its Temporal version is deleted.

**Branch:** `feat/de-temporal-runner-phase1`. **Done so far:** `review_pull_request` → the `review_jobs` coarse runner (Phases 1–2 + the 4 chaos gates + the external-review remediation), pushed at `4a1e1b4`.

---

## The full surface (from the 2026-06-10 inventory)

| Shape | Workflows | Mechanism |
|-------|-----------|-----------|
| continuous-loop (linchpin) | `outbox_dispatcher` | leased continuous runner; rewire `temporal_workflow_start` sink → Postgres enqueue |
| simple-cron | `mark_stale_chunks`, `partition_maintenance`, `mutex_janitor`, `review_run_reaper` | scheduler row → handler (`review_run_reaper` already subsumed by `reapStuckRuns`) |
| linear-single-step | `reconcile` ×3, `sync_code_owners`, `refresh_semantic_docs`, `run_id_retention`, `trigger_page_resync` | enqueue → handler |
| multi-step-fanout | `confluence_ingest`, `workspace_retention` | in-process orchestration handler (per-step retry/fail-open preserved) |
| dead scaffold | `review_skeleton` | delete (never fired live) |

**Dependency order:** `outbox_dispatcher` migrates before every event-driven workflow (it starts them). Crons are independent. Multi-step ones are the hard tail.

---

## Phase 3a — FOUNDATION (the platform everything lands on) · *the fable pilot*

A single generic job platform that generalizes the proven `review_jobs` runner, plus a Postgres scheduler that replaces Temporal Schedules.

### Wave 1 — schema + contracts
- **Migration `0039_background_jobs.sql`**: `core.background_jobs` — generalize `review_jobs`:
  `job_id uuid PK, job_type text NOT NULL, payload jsonb NOT NULL, payload_sha256 text NOT NULL CHECK (~'^[0-9a-f]{64}$'), state text NOT NULL CHECK (state IN ('ready','leased','done','failed','dead')), priority int NOT NULL DEFAULT 0, run_after timestamptz NOT NULL DEFAULT now(), lease_owner text, attempt_token uuid, leased_until timestamptz, timeout_at timestamptz, heartbeat_at timestamptz, attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 3, dedup_key text, created_at/updated_at`. Partial unique index on `dedup_key WHERE state IN ('ready','leased')` (overlap=SKIP for scheduled enqueues).
- **Migration `0040_scheduled_jobs.sql`**: `core.scheduled_jobs` — `schedule_id text PK, job_type text NOT NULL, cadence_kind text CHECK (IN ('cron','interval')), cadence_spec text NOT NULL (cron expr or interval seconds), input jsonb NOT NULL DEFAULT '{}', overlap_policy text NOT NULL DEFAULT 'skip', enabled bool NOT NULL DEFAULT true, next_run_at timestamptz NOT NULL, last_enqueued_at timestamptz`. (Operator-pausable via `enabled`; mirrors `ensureCronSchedule` idempotency.)
- **Contracts** `libs/contracts/src/background_job.v1.ts` (`BackgroundJobV1`) + `scheduled_job.v1.ts` — Zod, schema_version.
- TDD: contract parse round-trips; migration forward + the CHECKs reject bad rows (vs `:5434`).

### Wave 2 — the generic runner
- `apps/backend/src/runner/background_jobs_repo.ts` — `enqueue` (job_type + payload + optional dedup_key; identity/hash like `review_jobs_repo`), `claim` (FOR UPDATE SKIP LOCKED, lease/token/heartbeat), `heartbeat`, `markDone`, `markFailed` (retry backoff), `terminalSettle`, `reapStuckRuns` — **lift the proven `review_jobs_repo` primitives**; same fence/lease/attempt discipline.
- `apps/backend/src/runner/handler_registry.ts` — `Map<job_type, (payload, signal, deps) => Promise<void>>`; the runner dispatches a claimed job to its registered handler. Unknown job_type → dead-letter + metric.
- `apps/backend/src/runner/background_runner.ts` — the `RunnerLoop` analogue (claim → dispatch handler → settle; hard-timeout + orphan observer from F4; abort-aware).
- TDD: a fake handler job runs end-to-end (claim→done); crash→retry; timeout→failed+metered; unknown type→dead. vs `:5434`.

### Wave 3 — the scheduler/poller
- `apps/backend/src/runner/scheduler.ts` — a leased singleton loop: reads `scheduled_jobs WHERE enabled AND next_run_at <= now()`, enqueues a `background_jobs` row (dedup_key = `${schedule_id}:${bucket}` for overlap=SKIP), advances `next_run_at` (cron/interval). Clock seam; no wall-clock.
- A cron-expression evaluator (small, deterministic, tested) OR reuse a vetted dep (justify if added).
- TDD: a schedule due → exactly one job enqueued; overlap=SKIP suppresses a second enqueue while one is in-flight; `enabled=false` suppresses; `next_run_at` advances correctly. vs `:5434`.

### Wave 4 — wiring + verification
- Compose the runner + scheduler into a process entrypoint (`apps/backend/src/runner/main.ts`) — **not yet started in prod**, but constructed + integration-tested (closes part of F6).
- Full verify: typecheck/lint/gates 0; the new suites green twice; no regression to the review runner.

**Phase-3a exit:** the generic platform exists + is proven; nothing migrated onto it yet.

---

## Phases 3b–3e — migrate the 14 (each: register + handler + **parity gate** + delete Temporal version)

- **3b — simple crons** (4): register a `scheduled_jobs` row + move each single activity body into a `job_type` handler. Parity: run the handler vs the Temporal activity on identical DB state → identical row mutations.
- **3c — `outbox_dispatcher`**: port the continuous drain loop onto a leased `background_jobs` singleton; **rewire the `temporal_workflow_start` sink** to `background_jobs.enqueue` (this is the cutover hinge — after it, no event-driven workflow needs Temporal).
- **3d — event-driven** (7): `reconcile` ×3, `sync_code_owners`, `refresh_semantic_docs`, `run_id_retention`, `trigger_page_resync` → enqueue + handler. Preserve out-of-order-webhook retry semantics (reconcile_repositories before installation).
- **3e — multi-step** (2): `confluence_ingest`, `workspace_retention` → in-process orchestration handlers; preserve per-page / per-id fail-open + the transcribed retry curves.

Each migrated workflow's parity gate must be green **before** its `*.workflow.ts` + activity-proxy entry is deleted.

---

## Phase 4 — runtime teardown (only here is Temporal actually gone)

- Delete all `*.workflow.ts` (14) + `all_workflows.ts` + `review_skeleton`.
- Delete `worker/main.ts`, `worker/outbox_dispatcher_main.ts`, `activity_proxy.ts`, `data_converter.ts`, `ensure_schedule.ts` + schedule constants, `temporal_config.ts`, `adapters/real_temporal_client.ts` + `temporal_port.ts`.
- Remove `@temporalio/*` deps (5) from `package.json`.
- Retire the Temporal-only gates (`check_workflow_bundle.ts`, the workflow-scope `check_clock_random`) + ADRs 0065/0066/0074 (mark superseded).
- Delete the `temporal-helmchart` + the Temporal Server deployment.
- **Final end-to-end smoke** + the parity ledger: every workflow's parity gate green; zero `@temporalio` imports remain (grep gate); the system boots + serves with no Temporal connection.

---

## Parity-gate pattern (used in 3b–3e)

For each workflow: a test that drives identical input/DB-state through (a) the existing Temporal activity/body and (b) the new Postgres handler, then asserts identical observable effects (row mutations, GitHub/Qwen calls, emitted metrics). Where the Temporal body is non-trivial (multi-step), the gate shadow-runs both and byte-compares the result + the touched rows. This is the evidence that "every feature works" — not assumed.
