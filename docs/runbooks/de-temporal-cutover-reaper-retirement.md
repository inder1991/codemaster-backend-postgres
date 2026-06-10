# De-Temporal Cutover — Reaper Schedule Retirement (W6.3, D3)

After the Phase-4 cutover to the durable `core.review_jobs` runner (Phase-1 lease/fence/timeout
runner + the unified `reapStuckRuns` reaper, W6.1) and its soak window, **one Temporal Schedule must
be retired by hand**: `codemaster-review-run-reaper`. The sibling `codemaster-mutex-janitor` Schedule
**STAYS**. This runbook is the operator procedure for that retirement.

This is operator-gated. It is run ONCE, after cutover + soak — not on every deploy.

---

## Why the reaper schedule must be deleted by hand (not by removing code)

The boot-time schedule bootstrap (`ensureCronSchedule`, ADR-0074, Phase-1) is
**create-or-no-op only — it NEVER deletes**. On every worker boot it calls
`client.schedule.create(...)` for each Wave-1 schedule and **swallows `ScheduleAlreadyRunning`** so a
concurrent pod / redeploy never clobbers operator tuning:

> `apps/backend/src/worker/ensure_schedule.ts` — on `ScheduleAlreadyRunning` it `return`s (no-op);
> there is **no** `client.schedule.delete(...)` path anywhere in the bootstrap.

Consequence: **removing the `codemaster-review-run-reaper` entry from
`WAVE1_LIVENESS_SCHEDULES` (`apps/backend/src/worker/outbox_dispatcher_main.ts`) and redeploying does
NOT stop the schedule** — the already-registered Temporal Schedule keeps firing the
`reviewRunReaperWorkflow` every 10 minutes (`*/10 * * * *`) forever, because nothing ever issues the
delete. The operator must delete it explicitly.

### …but until the operator deletes it, its continued firing is SAFE

The W6.2 live-job shield (D3, gate ④ — ADR-0077) makes a still-firing age-sweep reaper **harmless**.
The age-sweep CTE UPDATE in `reviewRunReaperActivity`
(`apps/backend/src/activities/review_run_reaper.activity.ts`) carries:

```sql
AND NOT EXISTS (
  SELECT 1 FROM core.review_jobs j
  WHERE j.run_id = review_runs.run_id
    AND j.state IN ('ready','leased')
)
```

So a stale-by-age `RUNNING` run that still has a **live** `core.review_jobs` row (state `ready` or
`leased`) is **skipped** by the Temporal age-sweep — the Phase-1 runner's own per-job lease +
heartbeat is the liveness authority, and the age-sweep must not fight it. The schedule firing on its
10-minute cadence is therefore a no-op against any run the runner is actively driving. It only ever
cancels a run whose job has already reached a terminal state (`done`/`dead`/`cancelled`) and which is
*also* stale by age — i.e. genuine orphans the runner is no longer touching. This is why the
retirement is a **soak-then-delete** procedure and not a deploy-blocking emergency: the system is
correct with the schedule present or absent; deleting it merely stops a now-redundant sweep.

---

## Why the mutex-janitor schedule STAYS (do NOT retire it)

`codemaster-mutex-janitor` (every 5 min, `*/5 * * * *`) is the **hard-crash mutex backstop** and is
**permanently retained**. Do not delete it during or after cutover.

The two are NOT redundant:

- The unified reaper (`reapStuckRuns`, W6.1 — `apps/backend/src/runner/review_jobs_repo.ts`) releases
  **shell-held** PR mutexes *first*, during normal stuck-job reaping: for every reaped job that held a
  mutex (`mutex_id IS NOT NULL`) it stamps `core.pr_review_mutex.released_at = now()` in the **same**
  transaction that dead-letters the job and cancels the run. That covers mutexes held by a job the
  runner tracked.

- The mutex janitor (`mutexJanitorActivity` —
  `apps/backend/src/activities/mutex_janitor.activity.ts`) sweeps `core.pr_review_mutex` rows whose
  lease has **expired** (`released_at IS NULL AND lease_expires_at < now()`) regardless of any job
  row. It is the **last-resort backstop** for mutexes orphaned by paths the reaper does not cover —
  e.g. a hard crash that acquired a mutex before the job row reached a state the reaper sweeps, or any
  future mutex-acquiring path not subordinated to a `review_jobs` lease.

Retiring the janitor would remove the only backstop for that orphan class. **It stays.**

---

## Pre-conditions (ALL must hold before running this)

1. **Phase-4 cutover is complete.** The production enqueue caller writes `core.review_jobs` and the
   Phase-1 runner drives reviews end-to-end (the Temporal `review_pull_request` path is no longer the
   live driver).
2. **The soak window has passed.** The durable runner has run in production for the agreed soak period
   with the W6.2 shield observed working (stale RUNNING runs with a live job row are skipped; only
   genuine orphans are reaped). Confirm via the `review_run.reaped` audit-event volume and the runner
   liveness metrics before proceeding.
3. **You are pointed at the right Temporal namespace.** Confirm `temporal` CLI env
   (`TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE`) targets the **production** namespace the worker boots
   against — not a dev namespace. Deleting the schedule in the wrong namespace is a silent no-op (and
   leaves prod untouched).

> Note: the code-side removal of the `codemaster-review-run-reaper` entry from
> `WAVE1_LIVENESS_SCHEDULES` is a **separate, optional** cleanup. Because the bootstrap only
> create-or-no-ops, leaving the code entry in place would simply **re-create** the schedule on the next
> worker boot. Therefore: **delete the code entry FIRST and ship it, THEN run the delete below.** If you
> delete the schedule while the code entry still ships, the next pod boot resurrects it.

---

## Procedure

### 1. (Code) Remove the reaper from the boot bootstrap and deploy

Drop the `codemaster-review-run-reaper` object from `WAVE1_LIVENESS_SCHEDULES` in
`apps/backend/src/worker/outbox_dispatcher_main.ts` (leave the `codemaster-mutex-janitor` object).
Ship and roll all worker pods. After this rolls, no pod will *re-create* the schedule — but the
existing one is still registered and still firing (see "Why … by hand" above).

### 2. (Operator) Delete the Temporal Schedule

```bash
temporal schedule delete --schedule-id codemaster-review-run-reaper
```

This is the only step that actually stops the age-sweep from firing.

---

## Verification

```bash
temporal schedule list
```

Assert:

- `codemaster-review-run-reaper` is **GONE** from the list.
- `codemaster-mutex-janitor` is **PRESENT** in the list (the retained backstop).

Optionally confirm no new reaper executions start after the delete:

```bash
temporal workflow list --query "WorkflowId = 'codemaster-review-run-reaper-workflow'"
# expect: no new runs after the delete timestamp
```

---

## Rollback

Re-creating the schedule is trivial and **idempotent** — it is exactly what the boot bootstrap does:

- **Fast path:** revert the Step-1 code change (restore the `codemaster-review-run-reaper` entry in
  `WAVE1_LIVENESS_SCHEDULES`) and **roll a worker pod**. On boot the pod calls `ensureCronSchedule`,
  which re-`create`s the schedule with the same id / workflow type / `*/10 * * * *` cadence (and
  swallows `ScheduleAlreadyRunning` if a racing pod beat it). No manual Temporal command needed.
- Because cutover already shipped, restoring the schedule is **safe at any time**: the W6.2 shield
  means a re-enabled age-sweep still cannot cancel a run the runner is actively driving. Rollback
  reinstates a redundant-but-harmless backstop, not a behavior change.

There is nothing to undo for the mutex janitor — it was never touched.
