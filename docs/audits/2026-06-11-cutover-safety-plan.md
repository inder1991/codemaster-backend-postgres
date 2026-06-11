# Cutover Safety Plan — first safe Postgres-runtime cutover

**Date:** 2026-06-11
**Branch:** `feat/de-temporal-runner-phase1`
**Worktree:** `/Users/ascoe/Projects/.cmb-worktrees/de-temporal-runner-phase1`
**Parent:** `docs/audits/2026-06-11-MASTER-hardening-plan.md` (this is the executable cutover-gate subset of that plan's Tier 0)

---

## Scope — what this plan is, and is NOT

> **This is the CUTOVER-CODE gate** — the minimal, independently-verifiable set of blockers that must land (and be verified green) before `CODEMASTER_RUNTIME_MODE=postgres` is flipped in any environment carrying real traffic. Each blocker below is a **separate, narrowly-scoped, independently-verifiable wave** — they are NOT bundled. Land and verify them in order (CS1 first; the ordering is a dependency chain).
>
> **Production go-live requires MORE than this plan.** In addition to CS1–CS8 below, putting real production traffic for the 60 orgs onto the Postgres runtime additionally requires:
> - the **Postgres HA/DR decision** (master plan **W0.8 / XC1**) — a defended Postgres (replica / PITR / failover / DR runbook). Dev/stage may cut over on a single Postgres with an explicit, recorded SPOF acceptance; production may not.
> - the **OTel metrics pipeline** (master plan **W0.4 / W0.5b**) — **DEFERRED per the owner steer (2026-06-11)**; metrics-based alerting is a production-go-live concern, not a cutover-code gate. (Observability-via-**logs** is in-scope here as CS8; observability-via-**metrics** is not.)
> - the broader **quality / scale / self-healing tiers** of the master plan (Tiers 1–5) — including the fail-open/fan-out hardening (W1.9a–e), backpressure (W2.3), the retrieval rewrite, the eval harness, and the dead-letter operator surface.

Effort key: **S** ≈ ≤1 day · **M** ≈ 2–4 days · **L** ≈ ≥1 week.

Each wave below states: the **closed master-plan finding IDs**, the **approach (files/seams)**, the **test that proves it**, and an **effort**.

---

## CS1 — Runtime MODE exclusivity (`temporal | postgres | shadow`)

**Closes:** RT1, C7, C9, RC8, C8 (master plan **W0.1**). **Effort: M.**
**Depends on:** nothing — CS1 is the foundation; every later CS assumes the mode boundary exists.

**Approach.** Replace the two additive boolean cutover flags (`CODEMASTER_RUN_BACKGROUND_RUNNER` + `CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS`) with a single `CODEMASTER_RUNTIME_MODE ∈ {temporal, postgres, shadow}`, parsed once at boot. In `resolveBootTasks` (the boot-task wiring) make the three modes mutually exclusive **by construction**, with a single sink-registration owner per mode:

- **`temporal`** — boots the Temporal worker + the Temporal outbox dispatcher; does NOT boot the background-runner / review-jobs runner.
- **`postgres`** — boots ONLY the background-runner + review-jobs runner; **does NOT construct or boot the Temporal worker and does NOT boot the Temporal outbox dispatcher.** (This is what removes the double-sink-registration crash and the double-cron.)
- **`shadow`** — runs the Postgres runtime alongside Temporal for validation, with the **precise no-side-effects contract from CS-shadow below**.

Render `runtime.mode` to the Helm ConfigMap and add it to `values.schema.json` (closes the missing-Helm-knob gap, C8). Reject any boot where both worlds' sinks would register the same route.

**Shadow mode — precise no-side-effects definition (NORMATIVE; identical to master plan W0.1).** In `shadow` mode the runtime exercises claim/route/orchestrate but MUST NOT:
- make any **GitHub write** (no review post, no check-run create/update, no PR-description update, no fix-prompt comment);
- make any **LLM call** (no Bedrock/Anthropic invocation — curator, chunk review, walkthrough, arbitration all skipped/stubbed);
- **mark any outbox row dispatched** (`markDispatched` / dead-letter transitions forbidden);
- **advance any schedule** (`scheduled_jobs.next_run_at` MUST NOT move);
- **mutate any production table** — the only permitted writes are to dedicated **shadow tables** (e.g. `shadow.review_jobs`, `shadow.outbox_observations`) recording what the Postgres runtime *would* have done.

Enforcement is at the seam (sink/port/client short-circuits when `mode=shadow`), not by convention.

**Test that proves it.** Integration boot test parameterized over the three modes:
1. `mode=postgres` boots: assert the Temporal worker and Temporal outbox dispatcher are **not constructed** (spy/registry has zero Temporal entries) and exactly one owner registered each sink route.
2. `mode=temporal` boots: assert the inverse.
3. `mode=shadow` boots and drives one synthetic review through the claim/route/orchestrate path against fakes that **record-and-reject** GitHub writes, LLM calls, `markDispatched`, and `next_run_at` advancement; assert **zero** forbidden effects occurred and that the only writes landed in the shadow tables.
4. A boot where two owners would register the same sink route → boot fails loud.

---

## CS2 — Compose & boot the review-jobs RunnerLoop + unified reaper; fail-loud on an orphaned sink/workflow_type

**Closes:** C6, OC4 (master plan **W0.2**) + OC3 wall-clock reaper (master plan **W0.3**). **Effort: M.**
**Depends on:** CS1 (the runner is booted only in `postgres`/`shadow` mode).

**Approach.** Construct the review-jobs `RunnerLoop` (bound to `runReviewJob`) and `ReviewJobsRepo.reapStuckRuns` in `buildBackgroundRunner` (or a dedicated Deployment), so the table something enqueues into is actually drained. Add a **boot-time fail-loud guard in `wireOutboxSinks`**: it refuses to start when any registered sink route — or any `workflow_type` the dispatcher can route — has **no composed consumer** in the current mode. This converts the "green webhook 200 → silent black-hole" failure into a loud boot crash. Run `reapStuckRuns()` on a **throttled wall-clock timer inside the loop** (mirror the review runner's monotonic prune throttle), decoupled from `claim()` outcome, so it fires under saturation — exactly when crashed-pod leases pile up — and one exhausted-lease row cannot wedge an entire interval cron via its dedup key.

**Test that proves it.**
1. Boot in `postgres` mode and assert the review-jobs `RunnerLoop` + the reaper timer are live (heartbeat ticks).
2. **Fail-loud guard:** register the review-route sink but compose NO review-jobs consumer → assert boot crashes with a clear "sink `X` has no consumer in mode `postgres`" error (and the analogous `workflow_type` case).
3. **Wall-clock reaper:** seed a stuck `review_jobs` row (`state='ready'`, expired lease) and hold `claim()` saturated (no idle); advance the fake clock past the throttle window → assert `reapStuckRuns` fired and released the row independent of `claim()` returning anything.

---

## CS3 — Loop-health integrated into readiness with CORRECT K8s semantics

**Closes:** C5, H7, XH11, RT2 (master plan **W0.6**). **Effort: M.**
**Depends on:** CS2 (the loops whose health is reflected must exist first).

**Approach.** Wire `buildApp({ postgresCheck: SELECT 1, vaultCheck, loopLivenessCheck })`. Each supervised loop publishes a last-tick heartbeat. The two probes have **distinct, non-interchangeable semantics** — getting this wrong causes restart storms during downstream outages:

- **`/readyz` (readiness) — fails on DEPENDENCY issues.** NOT-READY when DB or Vault is unreachable, or when a *required* supervised loop is stale (no recent heartbeat). Effect: Kubernetes **stops routing traffic**; the rollout controller replaces a persistently-degraded pod via a normal rolling-replace. The pod is allowed to recover internally and flip back to Ready — **no crash loop.**
- **`/healthz` (liveness) — fails ONLY on a WEDGE.** Unhealthy ONLY when the process itself cannot make progress even after internal recovery (event loop stuck; a required loop crashed unrecoverably and `stopAll` was tripped; the supervisor can no longer schedule ticks). Liveness MUST NOT fail merely because DB/Vault is transiently down — otherwise every pod restarts in lockstep while the dependency is the actual problem.

On the first *required-loop crash* the supervisor cannot recover, trip `stopAll` and transition the pod to liveness-fail so K8s restarts it; routine dependency staleness stays a readiness-only condition.

**Test that proves it.**
1. **Dependency down ⇒ readiness only:** make `postgresCheck` (or a required loop's heartbeat) stale → assert `/readyz` returns NOT-READY **and `/healthz` stays healthy** (no restart). Restore → `/readyz` recovers.
2. **Unrecoverable wedge ⇒ liveness:** simulate a required-loop crash the supervisor cannot recover → assert `stopAll` tripped and `/healthz` now fails.
3. **No restart-storm regression test:** a transient DB blip flips `/readyz` but never `/healthz`.

---

## CS4 — `delivery_id` on the review enqueue + idempotent enqueue + retryable/permanent classification + one minimal retry/backoff

**Closes:** RT3, H9 (idempotency slice), RC7, T2, H3, RC6, XH2 (master plan **W0.10** — minimal cutover slice). **Effort: M.**
**Depends on:** CS1 (enqueue runs in the Postgres runtime); CS2 (the consumer that processes the enqueued job exists).

**Approach.** This is the *minimal* resilience the cutover needs — NOT the full fail-open/fan-out hardening (that is master-plan Tier-1 W1.9a–e, explicitly out of scope here).

- **`delivery_id` persisted on the review enqueue.** Thread `delivery_id` through `#enqueueReviewJob` (it currently omits `deliveryId:`, so the column is always NULL and `assertPayloadIdentityMatchesEnvelope`'s delivery_id cross-check is silently skipped). Assert it is present at enqueue.
- **Idempotent review enqueue.** Use `ON CONFLICT DO NOTHING RETURNING` + re-SELECT on the dispatch identity; **catch the `uq_review_jobs_active_run` unique-violation (SQLSTATE 23505) and return the existing active `job_id`** instead of raising — so a webhook **redelivery deduplicates** rather than double-posting.
- **Retryable-vs-permanent classification.** Honor `PermanentSinkError` vs `RetryableSinkError` in the outbox drain (RC7); wrap permanent event-handler faults in `PermanentJobError` (T2). A permanent fault dead-letters; a retryable one re-claims.
- **ONE minimal retry/backoff path.** Plumb GitHub/Bedrock `Retry-After` / `resetAt` hints into `run_after` **without burning an attempt** (H3/RC6/XH2) — the single path that stops routine throttling from dead-lettering a review a retry would have saved.

**Test that proves it.**
1. **delivery_id present:** enqueue a review → assert `review_jobs.delivery_id` is non-NULL and the envelope cross-check now runs (not skipped).
2. **Redelivery dedup:** enqueue the same dispatch identity twice (simulate webhook redelivery) → assert the second call hits 23505, returns the **existing active `job_id`**, and there is exactly **one** active `review_jobs` row (no double-post downstream).
3. **Classification:** a sink raising `PermanentSinkError` → row dead-letters and is NOT re-claimed; a sink raising `RetryableSinkError` → row re-claims.
4. **Backoff without attempt burn:** a port returns a `Retry-After` → assert `run_after` advanced by the hint and the **attempt counter did not increment**.

---

## CS5 — DB schema-revision boot preflight (fail-loud) + migration-0042 cold-only guard

**Closes:** XH7, L16, RT6 (master plan **W0.9**). **Effort: S.**
**Depends on:** CS1 (the preflight runs in the Postgres runtime boot path).

**Approach.** Read the applied head from `pgmigrations`; assert it equals the image's compiled-in expected head (plus a fingerprint of the expected migration set). On mismatch, `process.exit(1)` **before** binding HTTP and **before** starting any runner loop — this closes the exact 2-week silent-schema-drift class. Add a cold-only guard to **migration 0042**, which `DROP`s a CHECK + index and `CREATE`s indexes non-concurrently on the assumption `core.background_jobs` is empty: assert the table is empty (or abort with a clear "0042 requires a cold `core.background_jobs`" error) so it cannot corrupt a populated table.

**Test that proves it.**
1. **Preflight match:** boot against a DB at the expected head → boot proceeds.
2. **Preflight mismatch:** boot against a DB one revision behind (or a wrong fingerprint) → assert `process.exit(1)` fires **before** HTTP bind and before any loop starts.
3. **0042 guard:** run 0042 against a `core.background_jobs` with rows → assert it aborts loud; against an empty table → assert it applies cleanly.

---

## CS6 — Field-encryption key registry on worker/runner boot (fail-loud in PROD, explicit dev/test source) + stop storing cleartext secrets

**Closes:** EC5, RC1 (master plan **W0.7**). **Effort: M.**
**Depends on:** CS1 (loaded in the Postgres-runtime boot path); CS5 (boot-time preflight ordering).

**Approach.** Call `loadFieldEncryptionKeyRegistry(...) + setAuditKeyRegistry(...)` at `worker/main.ts` and `background_runner_main.ts` boot, **decoupled from `CODEMASTER_AUTH_ROUTES_ENABLED`**, with a startup self-check. Posture by environment (unconditional Vault loading would break dev/test where no Vault exists):

- **Production (`nodeEnv=production`):** the registry MUST load from Vault; a null registry ⇒ **fail-loud `process.exit(1)`.** No silent degradation. (This is what stops every self-healing audit-emit from throwing and re-wedging the ADR-0064 stuck-review class.)
- **Dev/test:** provide an **explicit non-Vault key source** selected by env (`CODEMASTER_FIELD_KEY_SOURCE=file|vault-agent|vault`) **OR** explicitly **disable the audit-emitting routes** in dev so no encrypt path is exercised. Dev/test MUST NOT require a live Vault and MUST NOT silently fall back to an unencrypted write.

Separately, **stop storing the pre-redaction `original_text` (a detected secret) in cleartext** in `audit.audit_events.before`: encrypt the audit `before` payload with the AES-GCM-AAD codec (fail-closed), or drop `original_text` entirely (RC1).

**Test that proves it.**
1. **PROD fail-loud:** boot with `nodeEnv=production` and the Vault key source unavailable → assert `process.exit(1)` and that boot does not proceed.
2. **Dev explicit source:** boot with `nodeEnv=development` + `CODEMASTER_FIELD_KEY_SOURCE=file` → assert the registry loads from the file source and the pod boots without Vault.
3. **No cleartext:** trigger an audit emit on a secret-bearing finding → assert `audit.audit_events.before` contains ciphertext (or no `original_text` at all), never the cleartext secret.

---

## CS7 — Scheduler per-schedule transaction isolation (savepoint / per-schedule txn)

**Closes:** RT4, M13 (per-schedule isolation slice; master plan **W0.12**). **Effort: S.**
**Depends on:** CS1 (the scheduler is part of the cutover boot surface).

**Approach.** The scheduler currently advances all due schedules in ONE transaction, so a single poisoned `UPDATE` (bad row, constraint violation) rolls back and **cascade-reticks the whole due batch**. Wrap each schedule's claim+advance in its own `SAVEPOINT` (or a per-schedule transaction) so one poisoned schedule isolates itself and every other due schedule advances cleanly. (The cron-vocabulary expansion and the remaining scheduler robustness — master-plan W3.8 — are explicitly out of scope here.)

**Test that proves it.** Seed a due batch where one schedule's advance UPDATE is poisoned (e.g. violates a constraint) and the others are healthy → assert the poisoned schedule is isolated (its savepoint rolls back, it is left for retry/quarantine) and **all healthy schedules advanced their `next_run_at`** in the same run — i.e. the batch did NOT cascade-retick.

---

## CS8 — Structured logging for degraded reviews (the discard-logger fix)

**Closes:** C4 (master plan **W0.5a**) + L12 (trace correlation), XM14 (structured-logs slice). **Effort: S.**
**Depends on:** CS1–CS3 (so the runtime, loops, and degradation paths whose logs we assert on are live). No OTel/metrics dependency — this is the logs-only observability gate.

**Approach.** Replace the discard `StageLogger` (`void msg` — it currently drops every degradation warning) with a **structured pino sink** carrying `run_id / installation_id / head_sha / repo / stage / outcome / trace_id`, so a degraded review is visible **in logs** with no OTel pipeline required. Add a structured WARN at the outbox per-row catch and at every `stageOutcome` degradation path. (The **metric-emission** half — recordStage/finding-lifecycle/outbox counters — is master-plan W0.5b, **DEFERRED with OTel** and explicitly NOT part of this cutover gate.)

**Test that proves it.** Drive a review whose pipeline degrades on one stage (e.g. a fail-soft chunk) → capture the log sink and assert a structured record was emitted carrying `run_id`, `stage`, and `outcome=degraded` (plus `installation_id`/`head_sha`/`repo`/`trace_id`) — i.e. the degradation is no longer silently discarded.

---

## Cutover readiness checklist (all must be GREEN)

| # | Wave | Closes (master-plan IDs) | Effort | Test green? |
|---|------|--------------------------|--------|-------------|
| CS1 | Runtime MODE exclusivity (+ shadow no-side-effects) | RT1, C7, C9, RC8, C8 | M | ✅ |
| CS2 | RunnerLoop + unified reaper + fail-loud orphaned sink | C6, OC4, OC3 | M | ✅ |
| CS3 | Loop-health → readiness (correct K8s semantics) | C5, H7, XH11, RT2 | M | ✅ |
| CS4 | delivery_id + idempotent enqueue + classification + one retry/backoff | RT3, H9, RC7, T2, H3, RC6, XH2 | M | ✅ |
| CS5 | DB schema-revision boot preflight + 0042 cold-only guard | XH7, L16, RT6 | S | ☐ |
| CS6 | Key registry fail-loud (PROD) + dev/test source + no cleartext secrets | EC5, RC1 | M | ☐ |
| CS7 | Scheduler per-schedule txn isolation | RT4, M13 | S | ☐ |
| CS8 | Structured logging for degraded reviews | C4, L12, XM14 (logs slice) | S | ☐ |

When CS1–CS8 are all green, `CODEMASTER_RUNTIME_MODE=postgres` may be flipped in dev/stage (with explicit Postgres-SPOF acceptance per W0.8). **Production go-live additionally requires W0.8 (HA/DR), the deferred OTel metrics (W0.4 / W0.5b), and the broader master-plan quality/scale tiers.**

---

*End of cutover safety plan. Waves are referenceable as CS1–CS8; each maps to a master-plan wave (W0.x) and closes the listed audit finding IDs.*
