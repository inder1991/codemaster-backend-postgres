# Non-Review Workflows — Resilience / Scale / Self-Healing / Quality Audit

**Date:** 2026-06-11
**Scope:** The 14 NON-review background workflows now ported onto the Postgres runtime (`background_jobs` runner + scheduler + outbox drain + `apps/backend/src/runner/handlers/*`; activity logic in `apps/backend/src/activities/*`). The review pipeline itself is OUT of scope here, but two reapers it depends on are in scope because they are non-review lifecycle sweeps.
**Worktree:** `/Users/ascoe/Projects/.cmb-worktrees/de-temporal-runner-phase1` · branch `feat/de-temporal-runner-phase1`
**Lenses:** Resilience · Scalability · Self-Healing · Quality (knowledge workflows feed review retrieval, so their quality is review quality).

**ID convention:** `OC*` = other-workflows Critical, `OH*` = other-workflows High, `OM*` = other-workflows Medium. The `O` prefix avoids collision with the main review-pipeline audit's `C/H/M` ids.

---

## Executive Summary

The non-review workflows have four structural failure classes that are individually serious and **compound** with each other. Several were verified directly against the code on-branch (`worker_heartbeats` has zero writers; the partman `part_config` table is never populated; the refresh handler has no feature-flag gate; the stuck-job reaper fires only on idle cycles; the review-jobs RunnerLoop is never booted).

**The five headline risks:**

1. **The knowledge corpus silently drifts from default-branch HEAD and never self-heals.** A chain of four refresh defects (`OC1` coalesce-discards-newer-SHA, `OH1` no FF kill-switch, `OH3` partial-embed strands a half-index, `OH4` no scheduled drift backstop) means `core.knowledge_chunks` can lag arbitrarily behind reality on exactly the busy monorepos the platform most cares about — and the jobs report `done`, so the gap is invisible. Reviews then cite stale CLAUDE.md / ADRs / runbooks.

2. **Partition maintenance is a structural no-op.** `pg_partman` is installed but **no migration ever registers a parent** (no `create_parent`, no `part_config` row), so the daily `partition_maintenance` cron iterates an empty config table and premakes/drops nothing while reporting `tables_processed=0` green (`OC2`). After Aug/Oct 2026 every audit/event row falls into `_default`, partition pruning the retention sweeps rely on stops working, and partition-drop retention never happens.

3. **The platform's self-healing reapers are unreachable at scale.** The `background_jobs` stuck-job reaper runs ONLY on idle cycles (`OC3`) — under steady 60-org load the queue never idles, so a single exhausted-lease row wedges an entire interval cron forever via its dedup key. Separately, the unified job+run+mutex+audit reaper (`ReviewJobsRepo.reapStuckRuns`) and its RunnerLoop are **never booted in any production process** (`OC4`) — the headline mutex-release-in-lockstep primitive is dead code at the Phase-4 cutover.

4. **Dead-worker / orphan reclamation is structurally offline.** The workspace orphan sweep JOINs `core.worker_heartbeats`, which **has no producer** (`OH5`) — crashed-runner leases are never reclaimed, leaking disk and starving the workspace pool. `FAILED_CLEANUP` leases that exhaust their retry budget leak forever with a comment promising an operator alert that the code never emits (`OH6`).

Across all of these, the recurring meta-pattern is **silent green**: the no-op / dropped / wedged condition reports success (`tables_processed=0`, job `done`, `orphaned_count=0`) so operators see health while the system drifts.

---

## Critical

### [OC1] Refresh coalescing discards the newer push's head_sha → knowledge index pins to a stale commit
- **Workflow:** `refresh_semantic_docs`
- **Location:** `apps/backend/src/ingest/_push_emitters.ts:221` (workflow_id drops head_sha) · `apps/backend/src/runner/background_jobs_repo.ts:111-138` (enqueue `ON CONFLICT (dedup_key) ... DO NOTHING` then re-SELECTs existing job_id) · `apps/backend/src/runner/background_jobs_temporal_port.ts:133-138`
- **Problem + scenario:** The dedup key is `refresh-semantic-docs/<iid>/<repoId>` with `head_sha` deliberately dropped. On conflict the enqueue does `DO NOTHING` and re-SELECTs the EXISTING job_id, so the newer enqueue's payload (carrying the new head_sha) is silently discarded (verified: `ON CONFLICT (dedup_key) WHERE ... state IN ('ready','leased') DO NOTHING`, then re-SELECT of the active row). Scenario: refresh for SHA-A is running; pushes B then C land; both coalesce onto the SHA-A job and their payloads are thrown away. The job embeds SHA-A, settles `done`, frees the key — but NO refresh is ever enqueued for C (C's enqueue already "succeeded" by returning the SHA-A job_id). The index reflects SHA-A while HEAD is SHA-C until the *next* push after settle.
- **Impact:** On busy monorepos `core.knowledge_chunks` lags arbitrarily behind default-branch HEAD. Reviews cite stale ADRs/runbooks/CLAUDE.md. Silent — the job shows `done`, not degraded.
- **Fix:** On a dedup-key conflict, **coalesce-to-latest**: `UPDATE` the existing ACTIVE `ready` row's payload to the newest head_sha before returning its id (instead of `DO NOTHING`), and re-enqueue when the running job's claimed SHA differs from the latest observed SHA. Change `BackgroundJobsRepo.enqueue` / `BackgroundJobsTemporalPort.startWorkflow`.

### [OC2] partition_maintenance is a structural no-op — no parent is registered in partman.part_config
- **Workflow:** `partition_maintenance`
- **Location:** `migrations/0001_baseline.sql:3-4` (extension created) — VERIFIED no `create_parent` / `INSERT INTO partman.part_config` anywhere in `migrations/*.sql` · `apps/backend/src/activities/partition_maintenance.activity.ts:121-160`
- **Problem + scenario:** The baseline creates `pg_partman` and 7 natively range-partitioned hot tables (`audit.audit_events`, `audit.webhook_events`, `audit.workflow_events`, `core.diff_snapshots`, `core.feedback_events`, `telemetry.llm_calls`, `telemetry.llm_payloads`) with HARDCODED monthly partitions running out at `_p20260801`/`_p20261001` plus a single catch-all `_default`. No migration calls `partman.create_parent()` or inserts a `part_config` row (verified via grep). The cron calls `SELECT partman.run_maintenance(...)`, which iterates the EMPTY `part_config` — premaking/dropping nothing — and the activity reports `tables_processed=0, partitions_created=0` green daily.
- **Impact:** After Aug 2026 (`workflow_events`) / Oct 2026 (`audit_events`) every new row falls into `_default`. (1) The partition-pruning the `run_id_delete_old_events` sweep relies on stops working — each batch becomes a full `_default` scan. (2) Retention-by-partition-drop (the contention-free 90-day expiry path) never happens, so `_default` grows unbounded and the row-by-row sweep is the only reclamation. The maintenance the owner believes is running does nothing.
- **Fix:** Add a migration registering each partitioned parent: `partman.create_parent(p_parent_table := 'audit.workflow_events', p_control := 'received_at', p_type := 'native', p_interval := '1 month', ...)`; set `premake >= 2` and retention to match the 90-day TTL. Pre-create Sep-2026+ partitions so there is no `_default` gap. Add an assertion in `partition_maintenance.activity.ts` that `tables_processed` equals the expected parent count (currently it silently accepts 0).

### [OC3] background_jobs stuck-job reaper runs ONLY on idle cycles — a never-idle runner wedges every interval cron via the dedup key
- **Workflow:** background runner `reapStuckRuns` + all interval crons (`mutex_janitor`, `review_run_reaper`, `workspace_retention`, `confluence_ingest`)
- **Location:** `apps/backend/src/runner/background_runner.ts:181-182` (VERIFIED: `runIdleMaintenance` invoked only when `outcome === "idle"`) · `apps/backend/src/runner/background_jobs_repo.ts:257-267` (`reapStuckRuns`), `:176` (claim reclaim arm requires `attempts < max_attempts`), `:126-134` (re-SELECT on conflict) · `migrations/0039_background_jobs.sql:48-49` (dedup index)
- **Problem + scenario:** `runIdleMaintenance()` (the only invoker of `repo.reapStuckRuns()`) is called only when `runOneBackgroundJob` returns `idle`. Under steady 60-org load `claim()` never returns idle, so the reaper NEVER fires. A row stuck `leased` with `attempts >= max_attempts` (a handler that crashed the pod ~3× or overran maxRuntime losing its fenced settle) is NOT reclaimable by `claim()` (reclaim arm needs `attempts < max_attempts`) and NOT flipped to `dead` by the reaper. It keeps holding `dedup_key = schedule_id` in an ACTIVE state, so the scheduler's re-enqueue `DO NOTHING`/re-SELECTs the stuck row forever and NO new tick is ever created.
- **Impact:** One exhausted-lease row silently wedges that entire cron. If `mutex_janitor` wedges, lease-expired `pr_review_mutex` rows leak forever and every push on those PRs is blocked from acquiring the mutex. If `review_run_reaper` wedges, dead-worker RUNNING runs stay "In Progress" forever. Self-heals ONLY if the queue drains to empty — which does not hold at scale.
- **Fix:** Decouple the reaper from idle. Run `repo.reapStuckRuns()` on a wall-clock cadence independent of `claim()` outcome — a throttled timer inside `BackgroundRunnerLoop.run()` (mirror the review runner's monotonic ledger-prune throttle at `review_job_runner.ts:182-187`), or once per loop iteration (it is a single cheap WHERE-guarded UPDATE), or model it as its own scheduled `background_job`. It MUST fire under saturation, because saturation is when crashed-pod leases accumulate.

### [OC4] The unified job+run+mutex+audit reaper and the review-jobs RunnerLoop are never booted in production
- **Workflow:** `ReviewJobsRepo.reapStuckRuns` (the only reaper that releases a stranded PR-mutex in lockstep with cancelling a stuck RUNNING run) — a non-review lifecycle sweep
- **Location:** `apps/backend/src/runner/review_jobs_repo.ts:387-468` (`reapStuckRuns`, releases mutex at step 3) · `apps/backend/src/runner/review_job_runner.ts:163-199` (`RunnerLoop`) · `apps/backend/src/runner/background_runner_main.ts:200` (VERIFIED: constructs only `BackgroundRunnerLoop`), `:266` (`ReviewJobsRepo` constructed solely for the outbox enqueue sink)
- **Problem + scenario:** `ReviewJobsRepo.reapStuckRuns` is the documented unified fix: flips stuck `review_jobs → dead`, cancels the run → `CANCELLED`, **releases the held `core.pr_review_mutex`**, and emits the per-run audit. But its only caller is `RunnerLoop.runIdleMaintenance`, and `RunnerLoop` is constructed nowhere in production (grep: referenced only by its own module + tests). `background_runner_main.ts` constructs `ReviewJobsRepo` only to wire the outbox sink. `boot_tasks.ts` wires temporal-worker, temporal-outbox-dispatcher, and (flag-gated) background-runner — no review-jobs runner. The cron `review_run_reaper` that IS scheduled cancels the run but does NOT release the mutex (see OH8).
- **Impact:** At Phase-4 cutover the outbox port routes `reviewPullRequest` onto `core.review_jobs` (`background_jobs_temporal_port.ts:180`) but **no process claims/runs/reaps them** — review jobs pile up and stuck rows are never dead-lettered by the unified reaper. The mutex-release-in-lockstep path (the whole point of ADR-0064) is dead code; the audit-correct dead-job↔cancelled-run linkage never runs.
- **Fix:** Boot the review-jobs `RunnerLoop` (or at minimum schedule `ReviewJobsRepo.reapStuckRuns` as a `background_job`/cron) before/with the Phase-4 flip. If Phase-1 deliberately defers the review-jobs runner, add an explicit blocker note in `boot_tasks.ts` AND a guard that refuses to flip `CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS` for `reviewPullRequest` rows while no review-jobs consumer is booted — otherwise the cutover enqueues work nothing drains.

---

## High

### [OH1] refresh_semantic_docs has NO feature-flag gate — unconditional clone+embed on every default-branch push, fleet-wide
- **Workflow:** `refresh_semantic_docs`
- **Location:** `apps/backend/src/runner/handlers/event_handlers.ts:413-458` (VERIFIED: handler has no `isEnabled` check, unlike `sync_code_owners` gated at `:381`) · `apps/backend/src/workflows/refresh_semantic_docs.workflow.ts:118-136` (no gate) · `apps/backend/src/ingest/_push_emitters.ts:190-191` (FALSE claim of a downstream FF gate)
- **Problem + scenario:** `_push_emitters.ts:190-191` claims the `refresh_semantic_docs_workflow_enabled` FF "short-circuits INSIDE the workflow body when disabled" — no such gate exists. The handler runs clone→refresh unconditionally; there is no `refreshIsEnabled` dep on `EventHandlersDeps`. There is NO operator lever to disable refresh without redeploying ingest.
- **Impact:** Every default-branch push to any of ~3000 repos triggers a full GitHub clone + discover→embed→upsert — embedding cost, clone bandwidth, DB write load — with no kill switch. If the embed service degrades or costs spike, operators cannot turn refresh off. No per-installation/per-repo ramp, so one hyperactive monorepo cannot be excluded.
- **Fix:** Add a real FF gate mirroring `sync_code_owners`: thread a `refreshIsEnabled?: IsEnabled` dep into `EventHandlersDeps` and short-circuit at the top of the refresh handler (DEFAULT-OFF until the flag reader is wired). Correct the false claim at `_push_emitters.ts:190-191`. Consider an installation/repo-scoped allowlist for the ramp.

### [OH2] Refresh clone-cache (/clone-cache) is never reaped — unbounded disk growth across 3000 repos
- **Workflow:** `refresh_semantic_docs` (clone step)
- **Location:** `apps/backend/src/activities/clone_repository.activity.ts:175-208` (`performClone` only wipes a STALE same-repo target on the NEXT clone) · `apps/backend/src/runner/handlers/event_handlers.ts:107-110` (FALSE "workspace retention sweeps own leftover reaping") · `apps/backend/src/runner/handlers/cron_handlers.ts:419-461` (`workspace_retention` scope) · `apps/backend/src/activities/release_workspace.activity.ts:56-79`
- **Problem + scenario:** Refresh clones into `CODEMASTER_CLONE_CACHE_ROOT` (default `/clone-cache`) at `<root>/<iid>/<repoId>/repo` and never cleans up; `performClone` only wipes a stale same-repo target at the next clone of THAT repo. The `event_handlers.ts:107-110` comment claims `workspace_retention` reaps leftovers, but that cron operates only on the DB-tracked `core.workspaces` lease table and the SEPARATE `CODEMASTER_WORKSPACE_ROOT` tree. The refresh clone path allocates no workspace lease (no `allocateWorkspace`/`core.workspaces` reference), so clone-cache dirs are invisible to the sweep.
- **Impact:** Every repo that receives ≥1 default-branch push leaves a permanent clone in `/clone-cache`; at 3000 repos the cache only ever shrinks via per-repo overwrite. Churning fleets (enabled→disabled, renamed, deleted repos) leave orphans forever. Eventually `/clone-cache` fills and refresh (plus any clone consumer sharing the volume) fails with ENOSPC — wedging knowledge refresh platform-wide.
- **Fix:** Either (a) tear the clone-cache dir down in the refresh handler's `finally` after Step 2 (refresh doesn't need cache persistence), or (b) add a dedicated clone-cache retention cron reaping `<CODEMASTER_CLONE_CACHE_ROOT>/*` older than N hours (mtime-based), analogous to `workspace_retention`. Fix the misleading comment at `event_handlers.ts:107-110`.

### [OH3] Partial embed failure leaves a half-updated index, skips the orphan sweep, and settles the job 'done' with no retry
- **Workflow:** `refresh_semantic_docs` (embed step)
- **Location:** `apps/backend/src/activities/embed_doc_chunks.ts:100-163` (per-batch commit then throw; Pass 3 orphan sweep at `:150-163`) · `apps/backend/src/activities/refresh_semantic_docs.activity.ts:172-199` (catch → `retrieval_degraded`, settle done)
- **Problem + scenario:** `embedDocChunks` Pass 2 embeds+upserts one batch per transaction. If the embed service rate-limits/drops on batch K of N, the throw propagates AFTER batches 1..K-1 committed. The activity catches `EmbeddingsRateLimitedError`/`EmbeddingsConnectivityError` and returns `retrieval_degraded=true`; the handler settles `done` (no throw). Two consequences: (1) Pass 3 orphan-sweep never runs, so docs deleted-in-this-push keep stale rows; (2) the partial write is NOT retried — the job is `done`, not `ready`. Convergence happens only if a later push re-runs the whole refresh.
- **Impact:** A transient embed blip during a large refresh permanently leaves a mixed index (some chunks new, some stale, orphans not purged) until the next unrelated push — possibly days away on a low-churn repo. Reviews retrieve a Frankenstein index. The "degraded" result is logged but there is no auto re-drive and no staleness marking.
- **Fix:** On embed degradation, do not silently settle `done`: re-throw a retryable error so the runner's `markFailed` backoff re-drives the attempt, or enqueue a follow-up refresh. At minimum gate the orphan sweep on ALL batches embedding (not just non-empty chunks) so a partial failure doesn't strand orphans. Change `embed_doc_chunks.ts` / `refresh_semantic_docs.activity.ts`.

### [OH4] No scheduled drift/staleness backstop for the repo-doc knowledge corpus — a dropped refresh = permanently stale knowledge
- **Workflow:** `refresh_semantic_docs`
- **Location:** `apps/backend/src/runner/cron_schedules.ts:54-123` (VERIFIED: only `mutex_janitor`, `review_run_reaper`, `mark_stale_chunks`, `partition_maintenance`, `run_id_retention`, `workspace_retention`, `confluence_ingest` — no refresh/knowledge cron) · `apps/backend/src/activities/mark_stale_chunks.activity.ts:5,98-113` (VERIFIED: flips `core.confluence_chunks.page_status` ONLY, never `core.knowledge_chunks`)
- **Problem + scenario:** `core.knowledge_chunks` is updated only by push-event-driven refresh; there is no scheduled re-index cron. `mark_stale_chunks` ages out only `core.confluence_chunks` (verified). So a refresh that is dropped (resolver skip when repo not yet recorded), dead-lettered (`markFailed` exhaustion), or coalesced-away (OC1) leaves the repo's knowledge index stale with NO drift detection and NO staleness flag.
- **Impact:** Combined with OC1/OH1/OH3, the repo-doc corpus drifts arbitrarily with zero self-healing — no periodic reconciliation re-clones+re-embeds, and stale rows are never marked stale so retrieval cannot deprioritize them. Over months, review quality silently degrades on repos whose refreshes failed or coalesced.
- **Fix:** Add a scheduled reconcile cron for the repo-doc corpus: periodically (e.g. daily) enqueue a refresh for repos whose `knowledge_chunks.updated_at` is older than the repo's last default-branch push, and/or extend `mark_stale_chunks` to age out `core.knowledge_chunks` past a threshold so retrieval can deprioritize. Add to `cron_schedules.ts` + a handler in `cron_handlers.ts`.

### [OH5] Workspace orphan-sweep is dead in production (no worker_heartbeats producer) — dead-worker leases never detected
- **Workflow:** `workspace_retention` (orphan sweep)
- **Location:** `apps/backend/src/activities/workspace_retention.activity.ts:33-46,160-225` (orphan sweep JOINs `core.worker_heartbeats`) — VERIFIED: `worker_heartbeats` is referenced ONLY by this file in `apps/backend/src`; ZERO INSERT/UPDATE writers exist
- **Problem + scenario:** `runWorkspaceOrphanSweepActivity` detects dead-worker leases by JOINing `core.worker_heartbeats WHERE last_seen_at < worker_dead_cutoff`. The heartbeat producer is unported — no TS code writes `worker_heartbeats` (grep confirms only this activity reads it). So the `dead_workers` CTE always matches zero rows; the sweep is a guaranteed `orphaned_count=0` no-op. ALLOCATED leases whose owning runner pod crashed (OOM, SIGKILL, eviction) are never transitioned `ALLOCATED → ORPHANED`, so the reap step never sees them and `releaseWorkspace` is never invoked.
- **Impact:** When a review-runner pod dies mid-review holding an ALLOCATED lease, the lease and its on-disk clone are never reclaimed. At 60 orgs / 3000 repos with rolling deploys and the documented kind connection-budget crashloops, crashed-worker leases accumulate; the workspace root fills and the lease table grows with permanently-ALLOCATED zombies. The one sweep designed to recover dead-worker state can never fire.
- **Fix:** Port the `WorkspaceManager` heartbeat producer (FOLLOW-UP-port-workspace-manager-heartbeat), OR add a fallback liveness signal — e.g. detect ALLOCATED leases whose `run_id` maps to a review_run already declared dead/timed-out by `review_run_reaper`. Until a producer exists, emit a WARN-level metric noting the sweep ran against an empty `worker_heartbeats` so operators know dead-worker reclamation is offline rather than seeing a falsely-green `orphaned_count=0`.

### [OH6] No dead-letter visibility for permanently-stuck FAILED_CLEANUP leases — exhausted retries leak disk forever, no alert
- **Workflow:** `workspace_retention` (reap)
- **Location:** `apps/backend/src/activities/workspace_retention.activity.ts:98` (comment claims operator alert) `,277-294` (reap stops at `cleanup_attempts >= 5`) · `apps/backend/src/activities/release_workspace.activity.ts:188-211` (bumps `cleanup_attempts` per failure)
- **Problem + scenario:** Reap only re-drives `FAILED_CLEANUP` leases with `cleanup_attempts < CLEANUP_MAX_ATTEMPTS (5)`. Once a lease fails `rm -rf`/path-validation 5×, reap permanently stops selecting it. The comment at `:98` says "FAILED_CLEANUP rows at/over this are NOT reaped (operator alert)", but grep confirms NO metric/gauge/counter/alert exists for stuck `FAILED_CLEANUP` leases. The lease falls out of the sweep with its on-disk workspace never deleted.
- **Impact:** A workspace whose cleanup genuinely fails (corrupt FS, permission change, hostile-symlink `WorkspaceSecurityViolation`) lands in `FAILED_CLEANUP` permanently and silently after 5 attempts; its directory leaks disk indefinitely with no operator notification. At 3000-repo scale a systematic cleanup bug (e.g. a workspace-root permission regression) would strand thousands of dirs with zero observability.
- **Fix:** Add a bounded-cardinality observable gauge (in the `workspace_retention` handler or a dedicated idle-maintenance sweep) counting `FAILED_CLEANUP` leases with `cleanup_attempts >= CLEANUP_MAX_ATTEMPTS` (and `ORPHANED` leases older than a threshold), emitted every cycle and wired to an alert. This is the dead-letter visibility the comment promises but never delivers.

### [OH7] run_id_retention chain aborts on the first sweep's failure — a transient PR-closer error skips retire + delete for the whole day
- **Workflow:** `run_id_retention`
- **Location:** `apps/backend/src/runner/handlers/cron_handlers.ts:381-405` (sequential await of three sweeps; any throw aborts) · `apps/backend/src/activities/run_id_retention.activity.ts:353,400` (`closeOneRow` re-throws non-client errors), `:411-418`/`:302-331` (`emitCloseAudit` awaited with no try/catch)
- **Problem + scenario:** The handler runs close → retire → delete sequentially; a throw from any sweep fails the whole job. Sweep 1 (PR-closer) is most failure-prone: `closeOneRow` re-throws ANY non-`GitHubClientError`, and `emitCloseAudit` (a fresh-transaction DB write) is awaited with NO try/catch, so a transient Postgres error AFTER a PR is already closed on GitHub throws out of the sweep. The docstring claims "a single failed audit cannot taint the rest of the sweep" — false; it propagates up the unguarded for-loop and aborts the entire chain.
- **Impact:** When the PR-closer hits any non-client error, the retire (`review_runs` soft-delete at 30d) and event-delete (`workflow_events` hard-delete at 90d) sweeps never run that day. Across days, terminal `review_runs` and 90-day-old `workflow_events` accumulate unbounded even though those pure-DB sweeps would have succeeded — the external-API-dependent sweep gates the two pure-DB sweeps. On retry the chain re-runs all three from the top, re-issuing GitHub calls for already-processed PRs.
- **Fix:** Decouple the three sweeps: wrap each sweep's await in its own try/catch that logs + continues (retire/delete have no dependency on close), surface a per-sweep failure count. Wrap `emitCloseAudit` in try/catch so a failed post-close audit write is logged + counted (the PR is already closed; losing the audit row must not abort the sweep). Alternatively register close/retire/delete as three separate `scheduled_jobs`.

### [OH8] review_run_reaper live-job shield is blind to Temporal-driven RUNNING runs — can false-positive cancel a live review at cutover
- **Workflow:** `review_run_reaper`
- **Location:** `apps/backend/src/activities/review_run_reaper.activity.ts:150-166` (VERIFIED: CTE `AND NOT EXISTS (SELECT 1 FROM core.review_jobs j WHERE j.run_id = review_runs.run_id AND j.state IN ('ready','leased'))`; touches only `core.review_runs`) · `review_jobs` rows minted only at `background_jobs_temporal_port.ts:180`
- **Problem + scenario:** The shield only protects runs driven by the Phase-1 review-jobs runner. `review_jobs` rows are minted exclusively by the flag-ON outbox port; the Temporal review-worker path creates `core.review_runs (RUNNING)` with NO `review_jobs` row. So for any Temporal-driven RUNNING run the `NOT EXISTS` is trivially true and the only protection is `started_at < now() - staleAfterSeconds` (default 3600s). A legitimately long-but-live Temporal review past 1h is cancelled with no liveness check against the worker.
- **Impact:** During the migration window and at the cutover boundary where both worlds coexist, a slow-but-live review past the 1h threshold is reaped — the user sees a spuriously cancelled review, the mutex/run flip to `CANCELLED` while the Temporal workflow is still executing, producing split-brain between the cron's `CANCELLED` run and the still-running workflow.
- **Fix:** Make the shield aware of each driver's liveness authority: for Temporal-era runs gate on a run-level heartbeat/liveness signal (`review_runs` has no heartbeat/lease columns today), or scope the reaper to only runs that HAVE a `review_jobs` row until Temporal is fully removed. At minimum add an explicit "only reap runner-era runs" predicate so the cron cannot cancel a workflow it has no liveness visibility into.

### [OH9] review_run_reaper cancels a stuck RUNNING run but never releases its pr_review_mutex — reclamation lags by lease-TTL + janitor cadence
- **Workflow:** `review_run_reaper` + `mutex_janitor` interaction
- **Location:** `apps/backend/src/activities/review_run_reaper.activity.ts:150-166` (VERIFIED: no mutex release; CTE updates only `review_runs`) · release path lives only in `ReviewJobsRepo.reapStuckRuns:433-441` and `mutex_janitor.activity.ts:105-122`
- **Problem + scenario:** When the cron reaper cancels a dead-worker RUNNING run, it does not touch `core.pr_review_mutex`. The mutex is reclaimed only when its lease expires and `mutex_janitor` sweeps it. The lease TTL default is 1800s floored at 600s; the reaper's run-stale threshold default is 3600s. Normally the lease expires (~30 min) before the 1h run threshold so the janitor reclaims first — but the two thresholds are independent env vars (`CODEMASTER_PR_REVIEW_MUTEX_LEASE_TTL_SECONDS` vs `CODEMASTER_REVIEW_RUN_REAPER_STALE_AFTER_SECONDS`) with no cross-check. If an operator raises the lease TTL or lowers the run threshold, the run is `CANCELLED` while the mutex is still live, blocking the next push until the janitor catches the lease expiry.
- **Impact:** A cancelled-but-mutex-still-held PR silently blocks its next review trigger for up to `(lease_TTL - run_threshold) + janitor cadence`. No audit/metric ties a reaped run to its still-held mutex, so the gap is invisible.
- **Fix:** Either (a) have `reviewRunReaperActivity` also release the run's associated mutex in the same transaction (resolve via `review_jobs.mutex_id` and release like `ReviewJobsRepo.reapStuckRuns` step 3), or (b) add a cross-field guard that the run-stale threshold is `<=` mutex lease TTL so the lease always expires first, documented next to `resolveStaleAfterSeconds`.

---

## Medium

### [OM1] Push-storm cost amplification: every default-branch push = full clone + full discover/embed; only in-flight coalescing, no debounce window
- **Workflow:** `refresh_semantic_docs`
- **Location:** `apps/backend/src/ingest/_push_emitters.ts:195-244` (emit per push) · `apps/backend/src/runner/background_jobs_repo.ts:126` (coalesce only while ACTIVE)
- **Problem + scenario:** A refresh is emitted on EVERY default-branch push. Coalescing collapses only pushes arriving while a refresh is ACTIVE; once it settles `done` the key frees and the next push enqueues a fresh full clone+embed. No time-window debounce. A repo with rapid back-to-back merges (release trains, bots, squash bursts) triggers a serialized chain of full clones + discover/embed passes (the hash-skip spares re-EMBED of unchanged chunks but NOT the clone or file walk/hash).
- **Impact:** At 3000 repos with busy monorepos, clone+walk cost (bandwidth, disk, CPU) is paid once per push rather than once per meaningful change window; these jobs share the review-default queue, competing with the review pipeline for runner/DB capacity.
- **Fix:** Add a coalescing debounce via `run_after`: on enqueue set `run_after = now() + debounceWindow` so rapid successive pushes for the same `(iid, repo)` collapse onto one delayed job (the dedup_key holds the slot while `ready`). Implement in `maybeEmitRefreshSemanticDocs` or `BackgroundJobsTemporalPort.startWorkflow`. (Pairs with the OC1 coalesce-to-latest fix.)

### [OM2] Oversize and cap-overflow knowledge docs silently dropped; chunks_skipped_oversize hardcoded 0 and docs_cap_hit discarded
- **Workflow:** `refresh_semantic_docs` (discover step)
- **Location:** `apps/backend/src/policy/discover_knowledge_docs.ts:160-167` (cap break after lexicographic sort), `:184-186` (oversize skip), `:256` (`docs_cap_hit` computed but unpropagated) · `apps/backend/src/activities/refresh_semantic_docs.activity.ts:126,206` (`chunks_skipped_oversize: 0` hardcoded)
- **Problem + scenario:** `discoverRepoDocs` silently `continue`s past any doc over `MAX_DOC_BYTES` and `break`s once `MAX_DOCS_PER_REPO` is reached after a lexicographic sort, so in a large monorepo the survivor set is the lexicographically-first N docs. `docs_cap_hit` is computed but never propagated into the result, and the activity hardcodes `chunks_skipped_oversize: 0`. No telemetry on dropped docs (the OTel emit is unported per the activity header's "Metrics divergence" note).
- **Impact:** On large/monorepo repos knowledge coverage is silently incomplete — ADRs/runbooks that sort late or exceed the byte cap never enter the corpus, and operators have NO signal coverage was truncated. Reviews retrieve a partial knowledge set and may miss governing guidance.
- **Fix:** Propagate `docs_cap_hit` and a real skipped-oversize count into `RefreshSemanticDocsResultV1` and emit a counter/log when either fires. Port the unported `record_knowledge_docs_cap_hit` metric. Consider raising/parameterizing `MAX_DOCS_PER_REPO` for monorepos or sorting by `doc_kind` priority rather than path lexicographic order so high-value docs survive the cap.

### [OM3] Clone size cap enforced only AFTER the full clone completes — a huge monorepo is fully cloned before rejection, every push
- **Workflow:** `refresh_semantic_docs` (clone step)
- **Location:** `apps/backend/src/activities/clone_repository.activity.ts:182-199` (clone then `byteSizeOfDir` then reject), `:70,72` (1 GiB cap, 300s timeout) · `apps/backend/src/integrations/git/cloner.ts:163-189`
- **Problem + scenario:** `performClone` runs the full clone+fetch+checkout first, then measures `byteSizeOfDir(targetDir)` and only then wipes + throws `CloneSizeCapExceeded` if over `DEFAULT_MAX_BYTES`. It's a post-hoc check, not a streaming/quota guard. The 300s clone timeout means a slow huge clone burns up to 5 min per attempt before the cap is evaluated, and `CloneError` is not in the non-retryable list so it burns the retry curve.
- **Impact:** A genuinely huge monorepo pays the full clone cost (bandwidth, disk, up to 5 min × up to 3 attempts) only to be rejected at the end every time, wasting runner capacity and GitHub bandwidth repeatedly on every push.
- **Fix:** Treat `CloneSizeCapExceeded` as non-retryable (add to `nonRetryableErrorTypes` / classify as `PermanentJobError`) so an oversize repo dead-letters on the first attempt. Better: gate clone admission on a cheap pre-check (GitHub repo `size` from the repository API) before spending a full clone. Change `clone_repository.activity.ts` + the refresh handler error classification.

### [OM4] run_id retire sweep opens a fresh non-memoized PgPool per run, bypassing the ADR-0062 single-pool invariant
- **Workflow:** `run_id_retention` (retire sweep)
- **Location:** `apps/backend/src/activities/run_id_retention.activity.ts:476-480` (`kyselyOver` builds `new PgPool({connectionString: dsn})`), `:560,656` (`kysely.destroy()` in finally)
- **Problem + scenario:** `runIdRetireOldRunsActivity` needs a Kysely Transaction handle for `emitWorkflowEvent` and constructs a brand-new `pg.Pool` wrapped in a one-off Kysely (`kyselyOver`) rather than the shared memoized pool (`tenantKysely(dsn)` / `getPool(dsn)` per ADR-0062), destroying it in `finally`. This is the exact anti-pattern ADR-0062 eliminated. It is bounded (one pool, destroyed each run, once daily) so not the unbounded-leak class, but it still opens a second connection source against the same DSN during the run.
- **Impact:** The kind/dev Postgres connection budget is ~89/100 steady-state with no rolling-deploy headroom. A second pool (default pg max 10) during the 03:00 retire sweep can push over `max_connections` and crashloop a pod, or fail with `TooManyConnectionsError`. A SIGKILL mid-sweep before `finally` leaks sockets until process exit. The close + delete sweeps in the same file correctly use `getPool(dsn)`.
- **Fix:** Route the retire sweep through the shared pool: use `tenantKysely(dsn)` (memoized Kysely over the ADR-0062 pool) for the transaction, or thread `emitWorkflowEvent` through the shared pg pool the way `emitCloseAudit`/the delete sweep do. Remove `kyselyOver` entirely so `run_id_retention` obeys the one-pool-per-DSN invariant.

### [OM5] Event-delete sweep caps at 1M rows/day with no backlog detection — a webhook/post-downtime backlog silently outpaces it
- **Workflow:** `run_id_retention` (event-delete sweep)
- **Location:** `apps/backend/src/activities/run_id_retention.activity.ts:115-116` (`EVENTS_BATCH_SIZE=5000`, `EVENTS_MAX_BATCHES=200`), `:695-722` (bounded loop), `:724-737` (watermark is a `console.info`, not a metric)
- **Problem + scenario:** `run_id_delete_old_events` deletes at most `5000 × 200 = 1,000,000` rows per daily run, then stops. `audit.workflow_events` accrues a row per webhook delivery, lifecycle transition, workspace state change, and retire-orphan emit across 60 orgs / 3000 repos. If the daily count older than the 90-day cutoff exceeds 1M (post multi-day downtime per OM6, or a webhook storm 90 days prior), the sweep can never catch up. The only signal is a `console.info` watermark; the `EVENTS_DELETED` counter increments but nothing alerts when the cap is hit with rows remaining.
- **Impact:** Unbounded growth of the hot partitioned `audit.workflow_events` once the per-day cap is exceeded, with no alert. Because partition_maintenance is a no-op (OC2), partition-drop cannot relieve this either, so the hard-capped row-by-row sweep is the ONLY reclamation. The watermark being a log line means the backlog is invisible to dashboards until disk pressure surfaces it.
- **Fix:** Emit the `oldest_remaining_received_at` watermark and a `batches_capped` boolean as an OTel gauge/counter so an alert fires when the sweep exits at `EVENTS_MAX_BATCHES` with rows still older than the cutoff. Better: once partman is registered (OC2), let partition-drop own bulk 90-day expiry (O(1) DDL vs deleting millions under `FOR UPDATE SKIP LOCKED`) and reduce the row-by-row sweep to a small safety net.

### [OM6] Missed daily crons catch up only ONCE — multi-day downtime silently drops skipped occurrences and fires off-window
- **Workflow:** `scheduler` driving all daily crons (`partition_maintenance`, `run_id_retention`, `workspace_retention`)
- **Location:** `apps/backend/src/runner/scheduler.ts:120-159` (`computeNextRun` from `enqueuedAt = clock.now()`, not the prior due instant), `:61-86` (`computeNextRun`)
- **Problem + scenario:** `pollAndEnqueue` reschedules forward from the poll instant, not the missed scheduled instant. For a daily `0 2 * * *` cron, if the runner is down 06-09 02:00 → 06-11 14:00, the first poll at 14:00 fires exactly ONCE, then sets next to tomorrow 02:00 — the two fully-missed days are lost. For retention this is mostly self-correcting (TTL cutoff sweeps everything older regardless of skipped days), but for `partition_maintenance` (once partman is registered) a small premake window can deplete mid-gap. The late single run also fires at an unpredictable peak hour (14:00) rather than the low-traffic 02:00 window, putting a heavy events-delete sweep into peak hours.
- **Impact:** Compounds OC2's partition-exhaustion risk once partman is registered with a small premake; and heavy sweeps can land in peak hours after an outage. No metric flags the drift.
- **Fix:** Size partman premake generously (`>= 2` intervals) so a missed-run gap cannot deplete partitions. When a daily cron is detected to have missed its window by more than one cadence, log a WARN with the count of skipped occurrences (`computeNextRun` can detect `now - prior_next_run_at > cadence`) so operators see drift.

### [OM7] mutex_janitor and reviewRunReaper sweep the whole eligible set in one unbounded transaction — no LIMIT/batching at 3000-repo scale
- **Workflow:** `mutex_janitor`, `review_run_reaper`, `reapStuckRuns`
- **Location:** `apps/backend/src/activities/mutex_janitor.activity.ts:105-143` · `apps/backend/src/activities/review_run_reaper.activity.ts:150-196` · `apps/backend/src/runner/review_jobs_repo.ts:395-467`
- **Problem + scenario:** All three sweep the full eligible set in ONE `withPgTransaction`, looping per row with an audit INSERT each, with no LIMIT/batching. `mutex_janitor` additionally holds `FOR UPDATE SKIP LOCKED` locks on every eligible row for the whole transaction. After an incident that leaks many leases (a worker-pool outage, or the OC3 wedge finally clearing), the eligible set is large; a single long transaction holds locks + accumulates per-row audit writes, and the 900s `maxRuntimeS` ceiling can abort mid-sweep, rolling back the whole batch — zero progress, same large set retried next tick.
- **Impact:** At 60+ orgs / 3000 repos a backlog-clearing sweep can run long, contend on `audit.audit_events` writes, and under the hard timeout repeatedly roll back without forward progress — a self-sustaining stall right when the system most needs to drain.
- **Fix:** Add a bounded LIMIT (sweep N rows per invocation) to each reaper SELECT/CTE and let the next tick continue; commit per-batch so partial progress survives a timeout. Crons fire every 5-10 min, so capping per-run work trades a slightly longer drain for guaranteed forward progress and bounded lock/transaction duration.

### [OM8] Orphan runs (broken repo FK chain) reaped without any audit row or dedicated metric — silent drift, no operator visibility
- **Workflow:** `review_run_reaper` + `reapStuckRuns`
- **Location:** `apps/backend/src/activities/review_run_reaper.activity.ts:169-180` · `apps/backend/src/runner/review_jobs_repo.ts:445-451`
- **Problem + scenario:** When the FK chain (`review_id → pull_request_reviews.repo_id → repositories.installation_id`) is broken, `installation_id` resolves NULL; the code reaps the run but skips the audit emit, logging only a `console.warn`. Not rolling back the sweep on one orphan is the right resilience choice, but there is no bounded counter for orphan reaps — only an unstructured log line. An orphaned-run condition is data drift (a run whose repository row was deleted/never recorded) — exactly a self-healing signal operators should alert on.
- **Impact:** A rising orphan-reap rate (a repositories-table consistency bug, or installation offboarding leaving dangling runs) is invisible in Grafana — it surfaces only as buried warn logs, with no audit trail of which runs were cancelled.
- **Fix:** Emit a bounded-cardinality counter (`codemaster_review_run_reaped_orphan_total`, no per-tenant label) alongside the warn in both reaper paths, and consider a system-scoped audit row (`actorKind=system`) that does not require `installation_id` binding so orphan reaps are auditable. Mirror the `recordCrashLoopReaped` idiom in `runner_metrics.ts`.

### [OM9] sync_code_owners is hard-wired DEFAULT-OFF (flag reader unported) so suggested-reviewers reads empty/stale code-owner data
- **Workflow:** `sync_code_owners`
- **Location:** `apps/backend/src/runner/handlers/event_handlers.ts:374` (`codeOwnersIsEnabled` default `async () => false`) · `apps/backend/src/activities/sync_code_owners.activity.ts:196-198` (short-circuit to 0) · consumer `apps/backend/src/llm/walkthrough_sections/suggested_reviewers.ts`
- **Problem + scenario:** The handler defaults `isEnabled` to `async () => false`, and the activity short-circuits to 0 with no I/O when disabled. The `core.flags` reader is unported (FOLLOW-UP-code-owners-v1-flag-reader), so there is NO way to turn it on without code change. Meanwhile `core.code_owners` IS consumed by the walkthrough's suggested-reviewers section.
- **Impact:** Because the producer is permanently off in this build, `core.code_owners` is never populated/refreshed, so suggested-reviewers renders against empty/stale rules — degraded review output quality, silently. The missing flag reader makes "off" the only reachable state.
- **Fix:** Port the `core.flags` reader and wire a real `codeOwnersIsEnabled` so the producer can be enabled per the rollout; until then, document clearly that suggested-reviewers is inert. Track FOLLOW-UP-code-owners-v1-flag-reader to closure.

### [OM10] run_id close-stale-PR sweep has no per-tenant fairness, no LIMIT, and serial GitHub round-trips — risks the 15-min ceiling
- **Workflow:** `run_id_retention` (close-stale-PR sweep)
- **Location:** `apps/backend/src/activities/run_id_retention.activity.ts:214-233` (`CANDIDATE_SQL` `ORDER BY started_at`, no LIMIT), `:445-458` (serial per-row GitHub list+close) · `apps/backend/src/runner/background_runner_main.ts:361` (`maxRuntimeS` default 900s)
- **Problem + scenario:** `runIdCloseStalePrsActivity` selects ALL ephemeral candidates older than 7 days with no LIMIT and processes them strictly serially — one GitHub GET (list open pulls) + one PATCH (close) per candidate, awaited in sequence, each opening a fresh audit transaction. No batching, no per-installation fairness (one org with thousands of stale ephemeral runs drains oldest-first before any other org), no bound on candidate-set size.
- **Impact:** After an incident leaving many ephemeral PRs open (or first run against a large backlog), the serial sweep can run many minutes. If it exceeds the 900s ceiling the job is force-settled failed and re-driven from the top, re-issuing GitHub calls (already-closed ones skip as not_found but still cost a GET) and re-burning rate limit. One noisy installation's backlog can starve all others and repeatedly time out the daily chain (which also blocks retire+delete per OH7).
- **Fix:** Add a LIMIT to `CANDIDATE_SQL` and process in bounded batches across runs (TTL cutoff makes a partial sweep safe), and interleave by `installation_id` for fairness rather than pure `started_at` order. Consider parallelizing per-candidate GitHub calls with a small concurrency bound and rate-limit-aware backoff so each run stays under `maxRuntimeS` regardless of backlog.

### [OM11] Scheduler advances next_run_at from the enqueue instant — a wedged or starved schedule is indistinguishable from a healthy one
- **Workflow:** `scheduler` driving `mutex_janitor` / `review_run_reaper` cadence
- **Location:** `apps/backend/src/runner/scheduler.ts:120-159` (`computeNextRun` from `enqueuedAt`; `next_run_at` advanced once per poll)
- **Problem + scenario:** `pollAndEnqueue` computes `next_run_at` a single interval forward from the poll instant. If the scheduler/runner is down 2h, the `mutex_janitor` (300s) schedule does not accumulate 24 missed ticks; on recovery exactly one job is enqueued. Acceptable for idempotent liveness backstops, but there is no metric for cadence lateness — `next_run_at` can sit far in the past during an outage and nothing flags that liveness sweeps have not run. Combined with the OC3 wedge, a stalled cron is indistinguishable from a healthy one at the schedule level.
- **Impact:** Operators have no direct signal that a liveness cron stopped firing (OC3 dedup wedge or scheduler outage); detection relies on downstream symptoms (leaked mutexes, stuck runs) rather than the schedule itself.
- **Fix:** Add an observability gauge/alert on `max(now() - next_run_at)` over enabled `core.scheduled_jobs` (cadence-lateness), and/or a `last_enqueued_at` staleness metric, so a wedged/starved schedule is directly visible. Cheap; complements (not replaces) the OC3 fix.

---

## Knowledge → Review Quality

The knowledge workflows are not "background chores" — they are the input plane for review retrieval, so their failure modes are review-quality regressions that surface to every reviewed PR with no obvious cause. The chain that governs whether a review cites *current* governing guidance (`core.knowledge_chunks`: CLAUDE.md, ADRs, runbooks) is composed of FIVE defects that each independently lets the corpus drift, and they compound:

- **OC1 (coalesce-discards-newer-SHA):** the index pins to a stale commit whenever pushes outpace a refresh — the busy-monorepo case. The corpus reflects an older HEAD silently.
- **OH1 (no FF kill-switch):** there is no operator lever to pause or ramp refresh, so when the embed service degrades the only options are "keep producing a bad index" or "redeploy ingest."
- **OH3 (partial-embed strands a half-index):** a transient embed blip leaves a mixed new/stale index with un-purged orphans, settled `done`, until the next unrelated push.
- **OH4 (no scheduled drift backstop):** nothing periodically reconciles `core.knowledge_chunks`, and `mark_stale_chunks` ages out only `confluence_chunks` (verified) — so a dropped/dead-lettered/coalesced-away refresh leaves the repo permanently stale with no staleness flag retrieval could deprioritize.
- **OM2 (silent coverage truncation):** large monorepos silently drop late-sorting/oversize docs with `chunks_skipped_oversize` hardcoded `0` and `docs_cap_hit` discarded — reviewers never learn coverage was incomplete.

Additionally **OM9 (sync_code_owners permanently off)** degrades the suggested-reviewers walkthrough section because its producer is hard-wired off (no flag reader), so `core.code_owners` is never populated.

**The unifying remediation theme:** the repo-doc knowledge corpus needs the same self-healing discipline the platform already gives Confluence — coalesce-to-latest on enqueue (OC1), a scheduled reconcile + staleness backstop (OH4), retry-don't-swallow on embed degradation (OH3), an operator kill-switch/ramp (OH1), and coverage-truncation telemetry (OM2). Until then, "the review cited a stale ADR" is an unattributable, undetectable quality bug.

---

## Prioritized Implementation Order

Ordered by `(blast radius × likelihood at scale) ÷ fix cost`, and respecting dependencies (the Phase-4 cutover gates must land before the flip; partman must land before its downstream retention paths matter).

**P0 — cutover blockers + invisible no-ops (must land before / with Phase-4 flip):**
1. **OC4** — boot the review-jobs RunnerLoop OR add a cutover guard refusing the outbox flip while no consumer drains `review_jobs`. Without this the cutover enqueues work nothing runs.
2. **OC3** — decouple the stuck-job reaper from idle (wall-clock cadence). A single exhausted-lease row wedging every interval cron is the canonical platform-wedge.
3. **OC2** — register partman parents + pre-create Sep-2026+ partitions + assert `tables_processed > 0`. The clock is running (Aug/Oct 2026); after that every event/audit row lands in `_default`.

**P1 — knowledge-quality core (silent review-quality drift):**
4. **OC1** — coalesce-to-latest on dedup conflict (carry/refresh head_sha). Highest-leverage single knowledge fix.
5. **OH3** — retry/re-enqueue on embed degradation instead of settling `done`; gate orphan sweep on full embed.
6. **OH4** — scheduled reconcile cron + extend `mark_stale_chunks` to `core.knowledge_chunks`.
7. **OH1** — add the refresh FF kill-switch/ramp; correct the false `_push_emitters.ts:190-191` claim.

**P2 — disk/lease self-healing (slow leaks that surface as outages):**
8. **OH5** — port the `worker_heartbeats` producer (or a fallback liveness signal) so the orphan sweep actually fires; until then emit a WARN metric.
9. **OH2** — reap the clone-cache (handler `finally` teardown or a dedicated retention cron); fix the misleading comment.
10. **OH6** — dead-letter gauge/alert for stuck `FAILED_CLEANUP` (+ aged `ORPHANED`) leases.

**P3 — retention chain robustness + reaper correctness:**
11. **OH7** — decouple the three run_id_retention sweeps (per-sweep try/catch); guard `emitCloseAudit`.
12. **OH8** — make `review_run_reaper`'s shield aware of Temporal-driven runs (no false-positive cancel at cutover).
13. **OH9** — release the mutex in lockstep with the reaped run, or add the `run_threshold <= lease_TTL` cross-check.
14. **OM7** — add LIMIT/batching + per-batch commit to the unbounded reaper sweeps.

**P4 — observability + scale hardening (cheap, complete the four-lens story):**
15. **OM5** — event-delete watermark/`batches_capped` as OTel metrics (and let partition-drop own bulk expiry post-OC2).
16. **OM8** — orphan-reap counter + system-scoped audit row.
17. **OM11** — cadence-lateness gauge/alert over `core.scheduled_jobs` (directly surfaces OC3/scheduler wedges).
18. **OM1** — debounce window via `run_after` (pairs with OC1).
19. **OM2** — propagate `docs_cap_hit` + real `chunks_skipped_oversize`; port the cap-hit metric.
20. **OM10** — LIMIT + per-tenant fairness + bounded concurrency for the close-stale-PR sweep.
21. **OM3** — classify `CloneSizeCapExceeded` non-retryable; add a cheap GitHub `size` pre-check.
22. **OM4** — route the retire sweep through the shared ADR-0062 pool (remove `kyselyOver`).
23. **OM6** — size partman premake `>= 2` intervals + WARN on missed-window drift.
24. **OM9** — port the `core.flags` reader so `sync_code_owners` can be enabled.
