# ADR-0074: Temporal Schedule bootstrap seam (boot-time `ensureCronSchedule`)

- **Status:** Accepted
- **Date:** 2026-06-07
- **Supersedes:** —
- **Related:** ADR-0064 (mutex lease liveness), ADR-0065 (workflow-sandbox crypto boundary),
  ADR-0073 (per-review installation routing). Python parity: `codemaster/worker/main.py`
  `ensure_*_schedule` boot block; `codemaster/workflows/{mutex_janitor,review_run_reaper}.py`.

## Context

The TypeScript port has, until now, shipped **zero Temporal Schedules**. Every cron-cadence
workflow in the frozen Python reference (`mutex_janitor`, `review_run_reaper`, the three retention
crons, the Confluence/retrieval-trace crons — 13 of the 20 unported workflows) is driven by a
Temporal **Schedule** that the Python worker creates idempotently at boot via an
`ensure_<name>_schedule(client)` helper, called fail-open from `worker/main.py`:

```python
try:
    await ensure_mutex_janitor_schedule(client)
except Exception:
    _LOG.exception("ensure_mutex_janitor_schedule failed")  # log + continue; worker still boots
```

Each helper calls `client.create_schedule(id, Schedule(action=ScheduleActionStartWorkflow(...),
spec=ScheduleSpec(cron_expressions=[...]), policy=SchedulePolicy(overlap=SKIP)))` and swallows
`ScheduleAlreadyRunningError` so concurrent pods / redeploys never clobber operator tuning
(e.g. a schedule paused for an incident).

Porting Wave 1 (`mutex_janitor` + `review_run_reaper` — the ADR-0064 liveness backstops) requires
this seam. Since **13 of 20** remaining workflows consume it, it is built once here as shared infra
rather than inlined per-workflow.

## Decision

### 1. A single shared `ensureCronSchedule` helper

`apps/backend/src/worker/ensure_schedule.ts` exports:

```ts
export async function ensureCronSchedule(
  client: ScheduleCreatingClient,
  args: { scheduleId: string; workflowType: string; workflowId: string;
          taskQueue: string; cronExpression: string },
): Promise<void>
```

It calls `client.schedule.create({ scheduleId, spec: { cronExpressions: [cron] },
action: { type: "startWorkflow", workflowType, taskQueue, workflowId },
policies: { overlap: ScheduleOverlapPolicy.SKIP } })` and **swallows `ScheduleAlreadyRunning`**
(the `@temporalio/client@1.17` analogue of Python's `ScheduleAlreadyRunningError`); any other error
re-throws to the fail-open boot caller. `ScheduleCreatingClient` is a narrow structural type
(`{ schedule: { create(opts): Promise<unknown> } }`) so the helper is unit-testable with a mock and
does not widen the `RealTemporalClient` port surface.

### 2. Boot placement — outside the V8 workflow sandbox

The ensure calls live in `runOutboxDispatcherWorker()` (`worker/outbox_dispatcher_main.ts`),
immediately after `ensureOutboxDispatcherSingleton`, where a `@temporalio/client` `Client` is already
constructed. This **mirrors the `ensureOutboxDispatcherSingleton` placement** (ADR-0073 lineage): the
`@temporalio/client` import is sandbox-illegal, so it must never enter the workflow bundle. The
workflow modules (`workflows/*.workflow.ts`) import ONLY `@temporalio/workflow` + type-only contract
shapes (ADR-0065 crypto boundary holds); the schedule-creation literals (`scheduleId`, `cron`,
`workflowType` string) live in the boot file, never imported from the sandboxed workflow module.

### 3. Schedules target the review worker's queue

The combined single-pod process runs both the review worker (queue `review-default`, whose
`workflowsPath` bundle = `all_workflows.ts`) and the outbox-dispatcher worker. Wave-1 workflows are
re-exported from `all_workflows.ts`, so the schedule's `taskQueue: "review-default"` lands the
started workflow on the review worker. This diverges from the frozen Python (dedicated `ingest`
queue) for the same reason ADR-0073 colocates the reconcile workflows: the TS port reuses the
combined-pod review worker. Cadence + `overlap=SKIP` are byte-faithful (`*/5` janitor, `*/10`
reaper).

### 4. Fail-open at boot

Each ensure call is wrapped `try { await ensureCronSchedule(...) } catch { log + continue }` — a
schedule-registration failure (Temporal transient, RBAC) MUST NOT crash worker startup, matching the
Python boot block. A logged error + the next pod's idempotent retry is the recovery path.

## Divergence — reaper stale-threshold reads env, not `core.platform_config`

The Python `review_run_reaper_activity` reads its stale threshold from `core.platform_config` key
`review_run_reaper_stale_after_seconds` (default 3600) via the `platform_config_cache`. **That cache
is not yet ported** (the ported `renew_pr_review_mutex_lease.activity.ts` already established the
interim pattern: read an env var with a floored default). Wave 1 follows that precedent:
`CODEMASTER_REVIEW_RUN_REAPER_STALE_AFTER_SECONDS` (default `3600`, floored at `300`s operator-safe
minimum). When `platform_config_cache` is ported, the activity re-bases onto it (the env var becomes
the fallback). This is recorded as `FOLLOW-UP-platform-config-cache` so the divergence is tracked,
not silent.

## Consequences

- **+** The liveness backstops (ADR-0064) can finally fire in the TS deployment — a leaked mutex /
  stuck `RUNNING` run self-heals, closing the 37-row-leak regression class for the port.
- **+** The 11 remaining cron workflows (Waves 2/4/5) reuse `ensureCronSchedule` with one literal
  config object each — no new infra.
- **−** A small, deliberate divergence (env-var threshold) until `platform_config_cache` ports.
- **Operator note:** to retune cadence/threshold, edit the Temporal Schedule directly
  (`tctl schedule update`) — the boot helper never overwrites an existing schedule.
