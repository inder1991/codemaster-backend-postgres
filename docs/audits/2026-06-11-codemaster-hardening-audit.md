# codemaster Hardening Audit — de-Temporal Postgres Runtime (Phase 1)

**Date:** 2026-06-11
**Branch:** `feat/de-temporal-runner-phase1`
**Worktree:** `/Users/ascoe/Projects/.cmb-worktrees/de-temporal-runner-phase1`
**Scope:** the new de-Temporal Postgres runtime (review_jobs runner + background_jobs + scheduler + outbox drain loop + handlers replacing Temporal workflows) and the core review loop it now hosts (clone → classify → redact → chunk → build-context → retrieve-knowledge → per-chunk LLM review → aggregate → arbitrate → post → fix-prompt + walkthrough).
**Goal lens:** resilient, scalable, highly-available, self-healing, and highest-quality PR reviews at 60+ GitHub orgs / ~3000 repos.

Synthesized from 86 raw lens-reviewer findings; deduplicated, re-ranked, and verified against the code at branch head.

**Final deduped counts:** Critical 9 · High 15 · Medium 16 · Low 7 (= 47 findings; 39 raw duplicates merged or dropped).

---

## Executive Summary

The de-Temporal runtime is a genuine architectural improvement (Postgres-only state, no V8 sandbox, simpler dependency graph), but it ships with **two classes of regression** that, if cut over as-is, make the platform *less* resilient than the Temporal system it replaces and silently degrade review output. The owner's goal (beat market SaaS tools on resilience + quality) is undermined at the root by a small number of high-leverage gaps.

### Headline risks for going to production

1. **The cutover is a loaded gun.** Flipping the two cutover env flags (`CODEMASTER_RUN_BACKGROUND_RUNNER` + `CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS`) today either **crash-loops the whole pod** (double sink-registration, **C7**), or **silently black-holes every review** (the review-jobs runner loop is never composed/booted, **C6**), or **double-runs every cron** (the flags only *add* the Postgres runtime, they never remove Temporal, **C9**). There is no Helm surface to set the flags safely (**C8**), and the readiness/liveness probes are wired to nothing (**C5**) so Kubernetes can never self-heal a degraded pod. None of these are enforced in code — only in prose comments the operator never sees.

2. **Per-activity resilience was deleted in the port.** Under Temporal every activity (per-chunk LLM, retrieve-knowledge, GitHub calls) had its own retry policy. In the in-process runtime, ports are wrapped *only* in `withAbortGate` — `runWithRetry` exists but has **zero production callers** (verified). The only retry is the whole-job retry, which re-clones + re-reviews + re-pays the entire PR. Combined with a **first-error-wins fan-out** (one chunk's transient 429 aborts all peers, **C2**) and a **bare `Promise.all` around the Tier-1 curator** (one Haiku throttle or cost-cap hit fails the entire review before Tier-2 even starts, **C1**), routine Bedrock throttling at scale dead-letters reviews that a single retry would have saved (**H1**).

3. **The new runtime is observability-dark.** The canonical per-stage metric (`codemaster_review_stage_total`), the finding-lifecycle metrics, and the policy-invariant (security) metrics are **all gated on `inWorkflowContext()`** and silently no-op in the plain-Node shell (**C3**, **H10**). The review-job shell injects a **discard logger** (`void msg`) that throws away every degradation warning (**C4**), and failure settlement writes only to a DB column with no log and no error-class metric (**H11**). An on-call engineer cannot detect, let alone diagnose, a fleet-wide regression from telemetry.

4. **No tenant fairness or rate-limit backpressure.** The review claim queue is a single global FIFO with no per-installation cap (**C8-fair** → re-IDed **C... see H2 / High**); one noisy org head-of-line-blocks all 59 others. GitHub/Bedrock `Retry-After`/`resetAt` hints are computed and thrown away — a rate-limit event dead-letters a review in ~7s instead of waiting for the reset window (**H3**).

5. **Self-healing gaps.** A single crashed supervised loop leaves the pod "healthy" with crons/reaper/outbox-drain silently dead (**H7**); out-of-order installation webhooks dead-letter in ~3s with the documented repair path *not wired* (**C... → H/C** below), permanently dropping review coverage for whole repos; dead-lettered jobs have no operator surface or replay path (**H8**).

6. **Review output quality is below the product bar.** Per-chunk LLM is capped at 2048 output tokens with no continuation — dense chunks silently drop findings past ~3 (recall gap, **H13**). Cross-file/consumer-breakage awareness is rendered in the prompt but fed hard-coded empties (**H14**). Oversized governance docs are skipped entirely instead of truncated (**H5**). These directly cap recall/precision below the SaaS tools the platform aims to beat.

**Bottom line:** the cutover must be **blocked in code** until the review-runner is composed, the sinks are mutually exclusive, the probes are real, and per-activity retry + fail-soft fan-out + fail-open Tier-1 are restored. Quality fixes follow.

---

## Critical

### [C1] Tier-1 curator failure (throttle / cost-cap / output-unsafe) fails the ENTIRE review before any Tier-2 chunk runs
**Location:** `apps/backend/src/review/pipeline/orchestrator.ts:528-545` (Step 3 bare `Promise.all`) · `apps/backend/src/analysis/curator.ts:226-240` (re-raises `isTypedLlmError`) · `apps/backend/src/activities/static_analysis.activity.ts` · `apps/backend/src/runner/review_job_shell.ts:489-507` (catch rethrows)
**Problem:** Step 3 runs `Promise.all([ports.chunkAndRedact(...), ports.staticAnalysis(...)])` with **no `stageOutcome` wrap** — verified at orchestrator.ts:528. It is the only orchestrate stage left bare (policy_compute, embed_query, retrieve_knowledge, persist are all wrapped). `staticAnalysis` calls the Haiku curator, which **re-raises every typed LLM error** — `BedrockBudgetExceededError`, `LlmOutputUnsafeError`, and the whole `LlmInvocationError` family (`LlmRateLimitError`/`LlmServerError`/`LlmTimeoutError`/`LlmAuthError`) via `isTypedLlmError` (curator.ts:236). With no per-activity retry in the runtime, the bare `Promise.all` rejects, `orchestrate()` throws, the shell catch rethrows, and the job fails. `BedrockBudgetExceededError` is a *normal steady-state condition* at 60 orgs with per-org cost caps.
**Failure scenario:** an org at/near its daily cost cap opens a PR with lint findings → the curator's Haiku call hits the cap → the entire review fails *before the expensive Tier-2 correctness layer runs*. Retries hit the same exhausted cap → permanent `dead`. Priority inversion: a cheap optimization layer starves the review.
**Impact:** violates the documented contract ("Tier 1 is an optimization layer for Tier 2 quality, not a correctness dependency"). Produces a stream of permanently-FAILED reviews exactly when an org is at its cap. Directly breaks SEED scenario (a).
**Fix:** wrap the `ports.staticAnalysis(...)` dispatch in a fail-open `stageOutcome('static_analysis', ...)` that substitutes an empty-valid `StaticAnalysisResultV1.parse({})` + a degradation note (mirror the policy_compute wrap). Split the parallel pair so only `chunkAndRedact` can be fatal. Independently, make the curator fail-open on retryable `LlmInvocationError` subclasses (return always-promote findings + `curator_skipped`) and never re-raise `BedrockBudgetExceededError`.

### [C2] One chunk's LLM hard-failure discards ALL chunks' findings (fan-out first-error-wins)
**Location:** `apps/backend/src/review/pipeline/parallelism.ts:170-200` (fanOutReview) · `apps/backend/src/review/pipeline/orchestrator.ts:603-633` (Step 5b, `raiseAfterLog:true`) · `apps/backend/src/review/review_activity.ts:157-210`
**Problem:** verified — each worker's `catch` sets `aborted=true` and rethrows; the first-observed error propagates through `Promise.all`, cancelling all peers. Step 5b wraps each chunk dispatch in `stageOutcome` with `raiseAfterLog:true`, so a chunk failure re-raises. `doReview` re-raises on non-sanitizable `LlmOutputUnsafeError` (reasons length/privileged_tag/tool_call_shape — common LLM output drift), `BedrockBudgetExceededError`, and any `LlmInvocationError`. With no per-chunk retry, one chunk hitting any of these throws the whole review.
**Failure scenario:** a 50-chunk PR; 49 review cleanly; chunk #37 trips the output-safety validator on `tool_call_shape` (or hits a rate-limit, or trips the cost cap mid-fan-out) → all 50 chunks' completed LLM work is discarded → review fails (and re-pays everything on retry).
**Impact:** the single most expensive and valuable stage is the *least* fault-tolerant — inverted from the owner's goal. Breaks SEED scenario (d).
**Fix:** make the fan-out fail-soft. Change the Step 5b dispatch to `raiseAfterLog:false` so a failed chunk contributes zero findings + a degradation note, OR add a failure-isolation slot in `fanOutReview` that records the failure and continues peers. Surface "N of M chunks failed review" in the walkthrough. Reserve hard-abort only for a genuine global budget kill-switch (and even then post the chunks that succeeded).

### [C3] De-Temporal pipeline emits ZERO per-stage metrics — `codemaster_review_stage_total` goes dark
**Location:** `apps/backend/src/review/pipeline/degradation.ts:114-129` (recordStage) · `apps/backend/src/runner/review_job_shell.ts:447` (orchestrate runs outside any workflow context)
**Problem:** verified — `recordStage` imports `inWorkflowContext` from `@temporalio/workflow` (degradation.ts:31) and **short-circuits to a no-op when `inWorkflowContext()` is false** (line 123). In the de-Temporal shell, `orchestrate(ctx)` runs in a plain Node process, so `inWorkflowContext()` is *always* false. Every stage emit (clone, classify, review_chunk, aggregate, post_review, walkthrough, fix_prompt, persist_findings, policy_post_filter — 40+ call sites) silently produces nothing.
**Failure scenario:** any review through the new runner post-cutover. A review that degrades (BODY_ONLY_POSTED, post_review error, chunk failures, persist failure) is structurally invisible — no metric fires.
**Impact:** the entire per-stage observability surface that Grafana dashboards/alerts depend on (CLAUDE.md invariant 12: operators MUST union `error` + `fallback` outcomes) is blind in the new runtime. The dominant observability blind spot for the resilience/HA goal.
**Fix:** decouple metric emission from Temporal. Replace the `metricMeter`/`inWorkflowContext` path with the platform OTel meter (`libs/platform/src/observability/metrics.ts::getMeter`, the same no-op-safe seam `runner_metrics.ts` uses), emitting in BOTH the workflow worker and the plain-Node shell. Keep replay-safety where a workflow context exists; add a non-workflow emit branch instead of returning early.

### [C4] Review-job shell injects a discard `StageLogger` — every degradation warning is silently dropped
**Location:** `apps/backend/src/runner/review_job_shell.ts:291` (`{ warning: (msg) => { void msg; } }`)
**Problem:** the shell threads a no-op logger into every `stageOutcome()` call and `runLifecycleBookkeeping`. `stageOutcome`'s failure path writes a fully-structured WARN line (error_class + truncated msg + truncated stack + head_sha + run_id) to exactly this logger — and `void msg` discards it. Combined with C3, every fail-soft stage (enrich_pr_files, fetch_linked_issues, fetch_manifest_snapshots, load_parent_review_findings, persist_findings, walkthrough, post_check_run, fix_prompt, cleanup, and the rfid/comment_id length-mismatch invariant) produces NEITHER a log NOR a metric.
**Failure scenario:** a customer reports "the bot posted a thin/empty review"; there is no log line and no metric to root-cause which stage failed and why.
**Impact:** silent degradation with zero diagnostic trace. Blocks self-healing and incident response.
**Fix:** replace the discard logger with a real structured sink — at minimum `{ warning: (msg) => console.warn(msg) }`, ideally a structured logger carrying run_id/installation_id/head_sha/repo. The cron/event handlers already use `console.warn` correctly; mirror that.

### [C5] Readiness/liveness probes reflect nothing — `/readyz` is permanently `ready:true` regardless of DB/Vault/runner health
**Location:** `apps/backend/src/api/server.ts:26` (`buildApp()` with no args) · `apps/backend/src/api/app.ts:61-91`
**Problem:** verified — `runServer()` calls `buildApp()` with no deps; `/readyz` aggregates `postgresCheck` + `dependencyChecks`, and with none supplied hits the `checks.length === 0` branch and returns `{ ready: true }`. `/healthz` returns `UNKNOWN_HEALTH` but always HTTP 200. The Helm probes (startup + liveness → `/healthz`, readiness → `/readyz`) are all process-up-only. The new runner/scheduler/outbox loops run in the SAME process; a crashed loop is supervised to keep the pod alive while DEGRADED, but nothing surfaces that to the probe.
**Failure scenario:** a pod whose Postgres is unreachable, whose Vault token expired, or whose scheduler/outbox loop has crashed still reports Ready + Live. Kubernetes never restarts it and never pulls it from the Service.
**Impact:** self-healing is structurally impossible — crons stop firing, outbox stops draining, reviews stall, and every probe says green. Defeats the HA/self-healing goal at the root.
**Fix:** wire `buildApp({ postgresCheck, vaultCheck, dependencyChecks })` in `server.ts` with a real `SELECT 1` + Vault token check; expose a per-loop liveness heartbeat (each supervised loop publishes a last-tick timestamp; `/readyz` fails if `backgroundRunnerEnabled` and any loop's heartbeat is stale); point `livenessProbe` at a `/healthz` that 503s on a dead combined process.

### [C6] Cutover flag enqueues onto `core.review_jobs` but NO production process drains it — reviews pile up unexecuted
**Location:** `apps/backend/src/runner/background_runner_main.ts:138-208` (buildBackgroundRunner) · `apps/backend/src/runner/background_jobs_temporal_port.ts:168-186` (#enqueueReviewJob) · `apps/backend/src/runner/review_job_runner.ts:163` (RunnerLoop, never constructed in prod)
**Problem:** verified — `buildBackgroundRunner` composes ONLY `BackgroundRunnerLoop` + `SchedulerLoop` + `OutboxDispatcherLoop`. It never constructs the review-jobs `RunnerLoop` or `runReviewJob`. `ReviewJobsRepo.claim` (the only seam that drains `core.review_jobs`) is called only from `review_job_runner.ts`; `new RunnerLoop(...)`/`runReviewJob(...)` appear ONLY in tests. Yet `CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS=true` routes `reviewPullRequest` rows into `core.review_jobs`.
**Failure scenario:** on cutover, every PR review enqueues a `core.review_jobs` row that nothing claims. The webhook returns 200 and the outbox row marks dispatched, so there is **no failing signal**. Reviews never run.
**Impact:** a one-line env flip turns the platform into a black hole for reviews with no alert. The single biggest threat to resilience. Only protection today is prose comments.
**Fix:** (1) compose the review-jobs `RunnerLoop` (bound to `runReviewJob`) into `buildBackgroundRunner`, supervised alongside the other loops — or a dedicated entrypoint + Deployment. (2) Add a boot-time guard in `wireOutboxSinks` that refuses to register the review-route sink when no review-jobs consumer is composed (fail loud at boot). (3) Add a liveness alert on `core.review_jobs` rows `state='ready'` with `run_after` older than N minutes.

### [C7] Cutover crashes the entire combined pod via double sink-registration
**Location:** `apps/backend/src/runner/background_runner_main.ts:269-270` · `apps/backend/src/worker/outbox_dispatcher_main.ts:186-187` · `apps/backend/src/outbox/sink_registry.ts` (`SinkAlreadyRegisteredError`) · `apps/backend/src/boot_tasks.ts:70-78`
**Problem:** verified — both `outbox_dispatcher_main` (the Temporal dispatcher, always booted) and `background_runner_main::wireOutboxSinks` (booted when the flag is on) call the SAME `registerTemporalWorkflowStartSink` + `registerInstallationReconcileSink`. `resolveBootTasks` always adds the two Temporal tasks and conditionally appends background-runner — no flag removes the Temporal dispatcher. `registerSink` throws `SinkAlreadyRegisteredError` on the second registration of a name.
**Failure scenario:** operator flips `RUN_BACKGROUND_RUNNER=true` to begin cutover → whichever boot task registers second throws → `main()`'s `Promise.all` rejects → `process.exit(1)` → the whole combined pod (API + worker + dispatcher + runner) crash-loops.
**Impact:** the single documented action to start the cutover instantly crash-loops the production pod, taking down the API and all review processing. Self-inflicted full outage at the highest-risk migration moment.
**Fix:** make the boot tasks mutually exclusive (see C9) — when `RUN_BACKGROUND_RUNNER` is true, drop `temporal-outbox-dispatcher` (and `temporal-worker`) from the task list so only one process registers the sinks.

### [C8] Cutover flags have no Helm knob — the de-Temporal runtime cannot be turned on/off via the chart
**Location:** `deploy/helm/codemaster-backend/templates/configmap.yaml` · `values.yaml` · `apps/backend/src/boot_tasks.ts:26` · `apps/backend/src/runner/background_jobs_temporal_port.ts:79`
**Problem:** verified — neither `CODEMASTER_RUN_BACKGROUND_RUNNER` nor `CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS` appears anywhere in `values.yaml`, the ConfigMap template, or `values.schema.json`. The only way to set them is the untyped `config.extra` string-map. The two flags MUST be flipped together (per boot_tasks.ts), but nothing couples them.
**Failure scenario:** the cutover is performed via an unvalidated free-text map. Setting the runner flag while the Temporal worker is still booted double-runs every cron; setting `OUTBOX_USE_BACKGROUND_JOBS=true` without the runner booted makes reviews pile up unexecuted (C6).
**Impact:** the highest-leverage deploy footgun on the branch — the cutover literally cannot be performed safely through the chart.
**Fix:** add a first-class `config.runtime` block (`backgroundRunnerEnabled` + `outboxUseBackgroundJobs`), render both to the ConfigMap, and add a `values.schema.json` rule (or `_helpers.tpl` `fail`) rejecting `outboxUseBackgroundJobs=true` unless `backgroundRunnerEnabled=true`.

### [C9] Cutover flag only ADDS the Postgres runtime — it never removes Temporal, so every cron double-runs
**Location:** `apps/backend/src/boot_tasks.ts:70-78` (resolveBootTasks) · `apps/backend/src/runner/cron_schedules.ts` (byte-identical schedule_ids)
**Problem:** verified — `resolveBootTasks` always pushes `temporal-worker` + `temporal-outbox-dispatcher`, then *additively* pushes `background-runner`. The Temporal worker hosts Temporal Schedules; the `SchedulerLoop` polls `core.scheduled_jobs` for the SAME crons. Module docs warn the flag "MUST stay OFF while the Temporal worker is also booted" — but no code path removes the Temporal tasks when the flag flips. Exclusivity is enforced only by reading a comment.
**Failure scenario:** operator flips the flag ON before deleting the Temporal worker (the safe-sounding order) → every cron double-fires (two partition-maintenance / retention / mark-stale / workspace-release sweeps, two outbox drainers racing the same rows).
**Impact:** doubles DB load on the maintenance window across 60+ orgs, creates duplicate operational signals, and the outbox double-drain races dispatchers. (Sweeps are mostly idempotent via SKIP LOCKED, so not instant data loss — but exactly the confusing degradation a cutover must avoid.)
**Fix:** make the flag mutually exclusive in code: in `resolveBootTasks`, when `RUN_BACKGROUND_RUNNER` is on, OMIT `temporal-worker` + `temporal-outbox-dispatcher` (return `[background-runner]` only). This also resolves C7.

---

## High

### [H1] No per-activity retry in the de-Temporal runtime — a transient single-chunk blip forces a full re-clone + re-review + re-pay
**Location:** `apps/backend/src/runner/in_process_ports.ts:386-423` (ports wrapped only in `withAbortGate`) · `apps/backend/src/runner/run_with_retry.ts` (zero production callers — verified) · `apps/backend/src/review/pipeline/activity_ports.ts:229-260` (`RETRY_POLICIES`, now vestigial) · `review_job_runner.ts:110-160`
**Problem:** verified — `makeInProcessPorts` wires every port as `pick(name, real)` → `withAbortGate` (a pure abort check, no retry). `runWithRetry` exists with the right policy shape but a grep confirms **zero production callers**. The `RETRY_POLICIES` constants are now vestigial. Under Temporal, a transient Bedrock 429/5xx, a pgvector timeout, or a flaky DB call retried *that activity* in place; now any single transient failure throws straight to the job-level `markFailed`, which re-runs the WHOLE shell (re-clone, re-classify, re-chunk, re-embed, re-LLM ALL chunks). Only the ADR-0068 idempotency ledger partially mitigates re-pay.
**Impact:** resilience regression vs the Temporal baseline; a flaky LLM call on chunk 18/20 discards 19 good chunks and redoes them, multiplying Bedrock cost + latency. With only 3 job attempts at 1s base backoff, a brief incident dead-letters reviews a single in-place retry would have saved. Thundering-herd of full re-reviews under load.
**Fix:** wire `runWithRetry` into `in_process_ports.ts::pick` for the retryable, idempotent ports (`reviewChunk`, `retrieveKnowledge`, `embedQuery`, the curator path, GitHub GET fetches), parameterized from `RETRY_POLICIES`: classify `LlmRateLimitError`/`LlmServerError`/`LlmTimeoutError` as retryable with backoff+jitter; `BedrockBudgetExceededError`/`LlmAuthError` as non-retryable. Keep non-idempotent post-side activities on their existing claim/takeover idempotency.

### [H2] No per-tenant fairness in the review claim queue — one noisy org head-of-line-blocks all 60+ others
**Location:** `apps/backend/src/runner/review_jobs_repo.ts:194-198` (claim) · `:143-148` (enqueue, `priority ?? 0`)
**Problem:** verified — the claim is a single global FIFO: `... ORDER BY priority DESC, run_after FOR UPDATE SKIP LOCKED LIMIT 1`. `priority` is hardcoded to 0 at enqueue and nothing sets it per-installation. There is NO per-installation in-flight cap; each pod processes one job at a time. The denormalized `installation_id` column exists (migration 0036, "for future per-installation fairness") but is unused.
**Failure scenario:** one org bursts the queue (monorepo merge-train, force-push CI bot, `installation_repositories.added` reconcile fanning out hundreds of PRs) → those 300 jobs are the oldest `ready` rows → every pod claims them in FIFO order before any other org's review.
**Impact:** a burst org occupies ALL N pods for its 300 reviews; the other 59 orgs wait with unbounded latency. SaaS competitors isolate tenants — this defeats that directly. Will happen routinely at scale.
**Fix:** add per-tenant fairness in `claim` using the existing `installation_id` column: a per-installation in-flight cap in the inner SELECT (skip installations holding ≥K leased jobs), or a fair-scheduling key (`ROW_NUMBER() OVER (PARTITION BY installation_id ORDER BY run_after)`) so the queue round-robins across tenants. Pair with a per-installation concurrency gauge.

### [H3] GitHub/Bedrock rate-limit + Retry-After is discarded — a rate-limit event dead-letters the review in ~7s instead of waiting for reset
**Location:** `apps/backend/src/runner/review_job_shell.ts:489-507` (catch → rethrow) · `review_job_runner.ts:117` (markFailed `baseBackoffMs:1000`) · `apps/backend/src/integrations/github/api_client.ts:455,498-507` (`GitHubRateLimitExceeded` carries `resetAt`/`retryAfterSeconds`) · `bedrock_sdk_adapter.ts:184` (`LlmRateLimitError`)
**Problem:** the GitHub client raises `GitHubRateLimitExceeded` carrying `resetAt` + `retryAfterSeconds`; the Bedrock adapter maps throttling to retryable `LlmRateLimitError`. But nothing in the in-process runtime reads those hints — the shell catch rethrows, routing to `markFailed` with a hardcoded `baseBackoffMs:1000` + default `max_attempts:3`. The retry curve is 1s→2s→4s; the job dead-letters after ~7s. GitHub primary-rate-limit resets are up to an hour away; secondary `Retry-After` is often 60s+.
**Failure scenario:** during peak hours an org's 5000-req/hr GitHub budget is consumed (large PRs paginate files + post many comments), or Bedrock throttles under regional load — the moments that occur AT SCALE.
**Impact:** reviews FAIL during exactly the high-load periods the platform must survive, instead of pausing and resuming. The info needed to do the right thing is computed and thrown away.
**Fix:** plumb the reset hint into `run_after`. In the shell catch (or a `settleFailure` classify seam), detect `GitHubRateLimitExceeded`/`LlmRateLimitError` and route to a `markFailed` variant that sets `run_after = max(now()+backoff, resetAt)` WITHOUT consuming an attempt (or with a much larger attempt budget) — mirror the outbox's `RetryableSinkError`. Add `baseBackoffMs`/`run_after` override params to `markFailed`.

### [H4] Out-of-order `installation_repositories` webhook dead-letters in ~3s with no self-healing recovery
**Location:** `apps/backend/src/runner/background_jobs_repo.ts:124` (maxAttempts default 3) · `apps/backend/src/runner/handlers/event_handlers.ts:331` · `apps/backend/src/activities/reconcile_installation.activity.ts:106-117` (repair kickoff NOT wired — verified, FOLLOW-UP/INTEGRATOR comment only)
**Problem:** GitHub does not guarantee webhook ordering. When `installation_repositories.added` arrives before `installation.created`, the reconcile job's activity intentionally throws when the parent `core.installations` row is absent, relying on platform redrive. But `background_jobs` enqueue defaults `maxAttempts=3`, `baseBackoffMs=1000` → total redrive window ~3s before `dead`. The Temporal path used a 10-attempt curve. Worse, the documented recovery — `reconcile_installation` enqueuing a repair to re-hydrate repos via the GitHub API — is **not wired** (verified: lines 106-117 are a FOLLOW-UP comment, no `maybeEnqueueRepair` call).
**Failure scenario:** any installation where `installation.created` lands >~3s after `installation_repositories.added` (common concurrent fan-out at 60+ orgs).
**Impact:** repos are NEVER registered in `core.repositories`; every subsequent PR webhook resolves `internalRepoId=null` and skips review dispatch. **Permanent, silent loss of review coverage for whole repos.** No alert fires.
**Fix:** (1) WIRE the deferred `maybeEnqueueRepair({ tx, githubInstallationId, triggerSource:'installation_created' })` call in `reconcile_installation.activity.ts` so a repair re-hydrates repos once the installation exists. (2) Raise `maxAttempts` (~10-15) and/or backoff on the `reconcile_repositories` enqueue so the out-of-order window exceeds GitHub's fan-out skew.

### [H5] Oversized guideline files (CLAUDE.md / ADR > 256 KiB) are silently dropped — zero policy rules instead of truncating
**Location:** `apps/backend/src/policy/discover_repo_docs.ts:415-418` (`if (data.length > MAX_GUIDELINE_BYTES) { oversizeCount++; continue; }` — verified) · `libs/contracts/src/guideline_files.v1.ts:22`
**Problem:** a guideline file > 256 KiB is skipped entirely, never truncated or parsed. The only signal is the `oversize_files_count` integer, not surfaced as a review notice.
**Failure scenario:** a real CLAUDE.md / ARCHITECTURE.md / STANDARDS.md crosses 256 KiB → contributes NO rules; the review continues but reviews against the wrong (empty) policy set. As docs grow, this flips on with no warning. Violates SEED scenario (c) (huge doc must STILL produce rules via truncation, "not skip").
**Impact:** a repo's most important governance doc silently stops contributing policy — a silent output-quality regression visible only on the oversize counter.
**Fix:** replace the wholesale skip with head-truncation to `MAX_GUIDELINE_BYTES` on a UTF-8 boundary, parse the bounded prefix, set a per-file `truncated` marker, and surface a "policy doc X was truncated" degradation note. Keep the cap as a memory guard but parse the prefix.

### [H6] Synchronous policy compute blocks the event loop with no enforced timeout
**Location:** `apps/backend/src/runner/in_process_ports.ts:95-107,387-396` (`withAbortGate` checks only `signal.aborted` at entry) · `apps/backend/src/activities/compute_policy_rules.activity.ts:108-112` (`Promise.resolve(computePolicyChain(input))`) · `activity_ports.ts:192-198` (the `5s` timeout is consumed only by the dead Temporal path)
**Problem:** `computePolicyRules` runs the entire A-1 discovery walk + A-2 markdown parse over up to 200 files + A-3 resolve **synchronously** before the Promise is even constructed. `withAbortGate` has no `Promise.race` against a timer and no AbortSignal threaded into the work. The `review_job_runner` hard-timeout is `setTimeout`-based and **cannot fire while synchronous work holds the loop**, so the 5s policy budget AND the job-level `maxRuntimeS` are unenforceable during the sync burst.
**Failure scenario:** SEED scenario (c) — a repo with many large guideline docs or a PR touching hundreds of `changed_paths` (no cap) produces seconds-to-minutes of synchronous CPU on the single Node loop.
**Impact:** the blocked loop starves the lease heartbeat → the mutex lease can lapse → the reaper re-dispatches the review elsewhere (duplicate review). The whole worker slot freezes for every co-tenant review on that pod.
**Fix:** wrap CPU-bound pure activities (at minimum `computePolicyRules`) in a real timeout: offload `computePolicyChain` to a `worker_threads` pool (so the race can win), or chunk the A-1/A-2/A-3 loops with `await yieldToEventLoop()` between files/paths honoring the composed AbortSignal. Make the per-activity `startToCloseTimeout` authoritative in the in-process path.

### [H7] A crashed supervised loop leaves the pod "healthy" with crons/reaper/outbox-drain silently dead
**Location:** `apps/backend/src/runner/background_runner_main.ts:403-440` (superviseLoop/runSupervisedLoops) · `:456-521` (runBackgroundRunner) — no liveness probe exists
**Problem:** `superviseLoop` catches a loop's escaped error, logs ONE `console.error`, bumps `codemaster_runner_loop_crashed_total`, and returns — the crashed loop's `run()` never restarts. `runBackgroundRunner` only re-throws (letting the platform restart the pod) after ALL loops end; a single dead loop while siblings run leaves the process alive. No liveness/readiness probe observes loop state (the admin health envelope reports only bedrock/postgres/temporal).
**Failure scenario:** any transient pass-level DB error escapes `SchedulerLoop.run()` once.
**Impact:** the scheduler death silently stops ALL cron cadences (mutex_janitor → stuck PR mutexes never released; review_run_reaper → stuck RUNNING reviews never cancelled → PRs stuck "In Progress"; retention/partition maintenance; Confluence ingest). The pod looks healthy, is never restarted, and the operator has only an un-alerted counter. The opposite of self-healing.
**Fix:** have `runSupervisedLoops` trip `stopAll` + return on the FIRST crash so `runBackgroundRunner`'s fail-loud re-throw fires (platform restarts the pod); and/or expose per-loop liveness through a readiness endpoint (each loop publishes a last-tick timestamp) so K8s restarts on the first dead loop; wire `codemaster_runner_loop_crashed_total` to a paging alert.

### [H8] Dead-lettered review_jobs / background_jobs have no operator surface or replay path
**Location:** `apps/backend/src/runner/review_jobs_repo.ts:273-287` (markFailed→dead) · `background_jobs_repo.ts:214-267` · `apps/backend/src/api` (no admin route reads `state='dead'`)
**Problem:** terminal rows flip to `state='dead'` with `dead_reason` and sit in the table. There is NO admin/API route to list, inspect, or replay dead-lettered jobs (grep of `apps/backend/src/api` returns nothing). The only outbox dead-letter signal is a `console.error` JSON line; the runner outcome vocabulary has no `dead` label.
**Failure scenario:** a review crash-loops 3 times during a transient Bedrock/GitHub incident and dead-letters.
**Impact:** a dead-lettered review silently never posts. Recovery is manual SQL spelunking; no way to see which reviews died, why, or re-drive them once the incident clears. Blocks self-healing.
**Fix:** add an admin route listing `state='dead'` jobs (job_id, run_id/review_id, installation_id, dead_reason, finished_at) + a fenced operator replay primitive (reset a dead row to `ready` with a fresh attempt budget, lease-fenced). Add a `dead` label/counter to the runner outcome metrics.

### [H9] Review-job enqueue is not idempotent under outbox redelivery — spurious dead-letter pages + post-completion double-review
**Location:** `apps/backend/src/runner/review_jobs_repo.ts:129-150` (bare INSERT, no `ON CONFLICT` — verified) · `background_jobs_temporal_port.ts:168-186` (#enqueueReviewJob ignores workflowId/conflict policy) · `migrations/0036_review_jobs.sql:33` (`uq_review_jobs_active_run`) · `outbox_dispatcher_loop.ts:106-134` (dispatchRow + markDispatched are separate statements)
**Problem:** verified — the review route enqueues via a bare `INSERT ... VALUES` with a fresh `job_id`, no `ON CONFLICT`, `delivery_id` never threaded. The generic `background_jobs` path is idempotent via `ON CONFLICT (dedup_key) DO NOTHING` + re-SELECT (verified) — the review path lacks the analog. The outbox drain commits the INSERT then `markDispatched` as two statements; a crash/lease-expiry between them re-claims the row and re-dispatches.
**Failure scenario:** **Case A** (review still active): redrive INSERT hits `uq_review_jobs_active_run` → raw 23505 → not a recognized sink error → retried `outboxMaxAttempts` times → dead-lettered outbox row with a confusing "duplicate key" error even though the review actually ran (spurious page). **Case B** (first job already settled, partial index freed): redrive INSERT SUCCEEDS → a SECOND review_jobs row → the review re-runs and **double-posts comments**.
**Impact:** at scale, `markDispatched` failures are routine during incidents; every one produces a false dead-letter page, and the post-completion window produces genuine duplicate reviews / duplicate PR comments — degrading output quality + operator trust.
**Fix:** make `enqueue` idempotent on the dispatch identity — add a unique constraint / partial unique on `delivery_id` (or unconditional on `run_id`), use `INSERT ... ON CONFLICT DO NOTHING RETURNING job_id` + re-SELECT existing job_id (the exact `BackgroundJobsRepo.enqueue` idiom). Thread `delivery_id` from the payload through `#enqueueReviewJob`. New migration + repo change.

### [H10] Finding-lifecycle + policy-invariant (security) metrics also go dark in the shell
**Location:** `apps/backend/src/observability/finding_lifecycle_metrics.ts:52-90` · `workflow_policy_metrics.ts:53-90` · call sites `review_job_shell.ts:590/598/613/628` + `orchestrator.ts:1220`
**Problem:** `recordLifecycleSetterSucceeded/Failed` and `recordInvariantViolationAttempted` all guard on `inWorkflowContext()` (same pattern as C3) and no-op outside a workflow. In the shell all three are no-ops; the rfid/comment_id length-mismatch invariant emits nothing AND its warning is dropped by the void logger (C4).
**Impact:** (a) finding-delivery bookkeeping failures are invisible — operators can't tell a posted review's findings were silently mis-recorded. (b) **Security signal:** `codemaster_finding_invariant_violation_attempted_total` (a prompt-injection / policy-bypass-attempt indicator per CLAUDE.md invariants 14 & 15) never fires, so adversarial findings attempting to escape chunk scope or fabricate evidence refs are unobservable.
**Fix:** apply the C3 fix — route these counters through the platform OTel meter with a non-workflow emit branch.

### [H11] Review-job failure settlement writes only to a DB column — no log, no failure-reason metric
**Location:** `apps/backend/src/runner/review_job_runner.ts:110-160` (settleFailure, catch at :144) · `review_jobs_repo.ts` markFailed/terminalSettle (no logging)
**Problem:** when `orchestrate()` throws a non-terminal error, `settleFailure(e.message)` writes the message to `core.review_jobs.last_error` and increments `codemaster_runner_jobs_total{outcome='failed'}` (no error_class/stage label). Nothing logs to stdout/stderr.
**Impact:** a production failure produces an anonymous counter tick + a buried DB row. An operator can't tell an LLM 503 storm from a GitHub-permissions outage from a code bug. Mean-time-to-diagnose explodes during incidents.
**Fix:** in the failure paths, emit a structured ERROR log `{ job_id, run_id, installation_id, head_sha, attempts, error_class, error_msg (truncated), outcome }`. Add a bounded `error_class`/`terminal` label to a dedicated failures counter (NOT installation_id — keep cardinality bounded).

### [H12] Outbox dispatch failures below the dead-letter threshold are completely silent
**Location:** `apps/backend/src/runner/outbox_dispatcher_loop.ts:106-135` (per-row catch) · `apps/backend/src/activities/outbox_dispatch.activity.ts:132-153` (markAttemptFailed)
**Problem:** a dispatch failure calls `markAttemptFailed` and continues; the loop logs NOTHING about which sink/row failed. `markAttemptFailed` only logs (event=`outbox.dead_letter`) when the row CROSSES into `dead`. So the first `maxAttempts-1` failures per row are silent. No outbox metrics module exists. The dead-letter log omits installation_id/run_id.
**Impact:** a sink outage that's retrying-but-not-yet-dead is invisible — rows pile up with rising attempts and no telemetry until review-triggering / reconcile events have already been silently delayed for 60 orgs. No metric to alert on a rising backlog.
**Fix:** add a `codemaster_outbox_dispatch_total{sink,outcome}` counter (outcome ∈ {dispatched, attempt_failed, dead_letter}) via the platform meter, a structured WARN log at the per-row catch `{ row_id, sink, attempt, installation_id, run_id, error }`, and add installation_id/run_id to the dead-letter log.

### [H13] Per-chunk review LLM is capped at 2048 output tokens with no continuation — dense chunks silently lose findings (recall)
**Location:** `apps/backend/src/review/review_activity.ts:131-132,188-193` (verified: `maxTokens: 2048`, truncation handling "observability-only with NO downstream behaviour change")
**Problem:** the chunk call uses `maxTokens: 2048` ("covers ~3 findings cleanly"). When a chunk legitimately contains many issues, the model emits `report_finding` blocks until `stop_reason='max_tokens'`; the trailing block is truncated → `parseWithSkipMalformed` SKIPS it. There is NO continuation turn, no re-invoke, no retry — findings past ~3 are silently dropped. The sibling walkthrough call already learned this (`WALKTHROUGH_MAX_TOKENS=4096`), so the gap is asymmetric.
**Impact:** direct recall loss on exactly the highest-value PRs (large, risky changes). A hard ~3-finding-per-chunk ceiling caps recall below SaaS tools that paginate/continue. The loss is invisible (no metric, no walkthrough note).
**Fix:** when `result.stop_reason === 'max_tokens'`: (a) emit a truncation counter + a `state.degradation` note so the walkthrough flags incomplete coverage; (b) issue a continuation turn (append the assistant tool_use blocks + a "continue reporting remaining findings" message, accumulating until `stop_reason !== 'max_tokens'` or a bounded turn cap), or split the chunk. At minimum raise the default `maxTokens` to 4096-8192.

### [H14] Cross-file/cross-repo awareness is rendered but never populated — `consumer_hits`, `removed_or_changed_symbols`, `prior_findings` are hard-coded empty
**Location:** `apps/backend/src/review/pipeline/orchestrator.ts:1087,1109-1111` (verified: all literal empties at the only construction site)
**Problem:** `buildChunkContext()` constructs every `ReviewContextV1` with `prior_findings: []`, `removed_or_changed_symbols: []`, `consumer_hits: []`, `consumer_hits_truncated: false`. The prompt builder renders dedicated sections for all three (`# cross-repo consumers`, `removed or signature-changed public symbols`, `## prior findings (do not repeat)`) — fed nothing. Combined with the epistemic-boundary clause + scope enforcement (cross_chunk/pr_global findings are DROPPED at the parser), the reviewer is **structurally prevented** from reporting "this signature change breaks consumer X."
**Impact:** major recall gap vs SaaS competitors that do cross-file impact analysis. A PR renaming a public symbol used across the 3000-repo fleet generates zero breakage findings. `prior_findings` being empty also means a re-push re-reviews from scratch with no "do not repeat" grounding → duplicate inline comments across pushes.
**Fix:** wire a real producer in `orchestrator.ts`: populate `removed_or_changed_symbols`/`consumer_hits` from symbol-graph data the contracts already model (`ConsumerHitV1`/`RemovedOrChangedSymbolV1` exist), and grant narrow scope authority for consumer-backed `context_breaks_consumer` findings. For `prior_findings`, load the prior review's posted findings for the same `pr_id`. If deferred, track as an explicit product gap rather than leaving dormant rendered sections.

### [H15] Subprocess stdout/stderr accumulated unbounded — a chatty tool OOMs the worker pod and kills ALL co-located reviews + self-healing loops
**Location:** `apps/backend/src/analysis/in_worker_runner.ts:182-184,205-229`
**Problem:** `runSubprocess` pushes `proc.stdout`/`proc.stderr` into arrays with no size cap, then `Buffer.concat`s. Node's `spawn` has no `maxBuffer`. The 60s timeout doesn't bound memory — a tool can produce gigabytes within 60s.
**Failure scenario:** ESLint/Ruff `--format=json` over a generated/minified/vendored file (a 50MB bundle, a giant lockfile, tens of thousands of lint hits) emits hundreds of MB of JSON; or gitleaks emits a massive report scanning the whole tree. The background runner runs multiple loops in ONE process, so an OOM crashes the WHOLE process.
**Impact:** process-level OOM takes down every concurrent review job AND the scheduler/outbox-drain/reaper loops — a multi-review + self-healing outage triggered by one pathological file. A reliable DoS surface (a PR can deliberately include a file that makes a linter emit huge output).
**Fix:** cap accumulated stdout+stderr at a configurable ceiling (32-64MB); track running byte totals in the `data` handlers; once exceeded, kill the process group and surface a typed `oom`/`output_too_large` outcome the orchestrator maps to `ToolStatusV1` (the `oom` literal already exists).

---

## Medium

### [M1] No file-count cap before passing `sandbox_files` as argv — large PRs hit E2BIG and silently lose ALL Tier-1 linting (incl. gitleaks)
**Location:** `apps/backend/src/activities/static_analysis.activity.ts:160-167` · `eslint_runner.ts:99-108` · `ruff_runner.ts:103-116`
**Problem:** every code file is spread as `...files` onto the command line; `classify_files` pushes every classified file with no limit. The Tier-2 fan-out IS capped (`MAX_CHUNKS_PER_REVIEW`) but Tier-1 is not. A large PR (vendored-dep bump, generated code, mass rename touching 1000+ files) builds an argv exceeding `ARG_MAX` (~2MB) → `spawn` fails E2BIG → `failed_startup`.
**Impact:** the fail-open path means the review completes, but the LARGEST/highest-risk PRs get ZERO static analysis from ruff, eslint, AND gitleaks — including the **secret scan**. Silent, scale-correlated security degradation exactly on the big PRs most likely to slip a credential.
**Fix:** cap the per-runner file list (`MAX_FILES_PER_RUNNER`, surface dropped counts), OR batch into multiple invocations, OR pass files via `--stdin-filenames`/argfile. For gitleaks the whole-tree `--source` sidesteps argv (but see M3).

### [M2] classify, dedup, and aggregate stages are unwrapped — a throw after the expensive fan-out discards all completed LLM work
**Location:** `apps/backend/src/review/pipeline/orchestrator.ts:447-451` (classify), `:644-648` (dedup), `:663-667` (aggregate)
**Problem:** three pipeline stages are bare awaits with no `stageOutcome` wrap. `dedup` and `aggregate` run AFTER the full chunk fan-out, so a `ZodError` on a malformed finding (aggregate) discards every chunk's paid-for LLM findings. The shell catch rethrows.
**Impact:** a dedup/aggregate throw wastes the entire fan-out's Bedrock spend and posts nothing, when the safe degradation is "skip dedup/cap and post the raw findings."
**Fix:** wrap all three in `stageOutcome` with fallbacks: classify failure → treat all changed files as review_files + note; dedup failure → pass `deduped=llmFindings` unchanged + note; aggregate failure → build a minimal `AggregatedFindingsV1` from deduped findings (skip ranking/cap) + note.

### [M3] Gitleaks scans the entire checked-out tree per PR — cost/timeout amplifier at scale
**Location:** `apps/backend/src/analysis/gitleaks_runner.ts:91-103` (`--source=${workspace}`) · `orchestrator.ts:381-382` (full checkout)
**Problem:** gitleaks scans the WHOLE working tree; the per-file changed-line filter is applied only AFTER. A PR changing one file in a large monorepo still triggers a full-tree scan, then discards nearly all findings.
**Impact:** every PR on a large repo pays a full-tree secret scan regardless of PR size — wasted CPU + a real timeout risk (the tool may not finish a giant tree in 60s → `timed_out`, losing secret detection on big repos exactly where it matters). With M-OOM (H15), also an OOM amplifier.
**Fix:** scope gitleaks to the changed file set (it supports a file list / `git diff` mode) instead of `--source=${workspace}`, so scan cost scales with PR size. If whole-tree coverage is intentional, cap it (size/time) and surface partial-coverage in `ToolStatusV1`.

### [M4] Orchestrator soft-barrier deadline equals the per-tool timeout (both 60s) — the "authoritative" deadline never preempts a hung tool
**Location:** `apps/backend/src/worker/build_activities.ts:243` (`TIER1_STATIC_ANALYSIS_SECONDS=60`) vs `in_worker_runner.ts:42` (`DEFAULT_TIMEOUT_SECONDS=60`) · `in_process_ports.ts:333` (hardcoded 60)
**Problem:** the orchestrator is documented to own the authoritative Tier-1 deadline with per-tool timeouts as "only safety guards" — but the production deadline equals the per-tool guard, so the soft barrier never preempts a slow tool, and three concurrent tools each get the full 60s.
**Impact:** the Tier-1 stage can consume ~60s even when the orchestrator should have cut it short, eating into the job runtime ceiling and delaying Tier-2.
**Fix:** set `TIER1_STATIC_ANALYSIS_SECONDS` strictly less than `DEFAULT_TIMEOUT_SECONDS` (e.g. 45s deadline, 60s per-tool guard); fix the hardcoded 60 in `in_process_ports.ts:333` to read the configured value.

### [M5] OOM-killed tools degrade to `failed_runtime` — the dedicated `oom` status is never emitted
**Location:** `apps/backend/src/analysis/static_analysis_orchestrator.ts:221-239` · `in_worker_runner.ts:197-199` · `tool_status.v1.ts:21` (`oom` literal exists but nothing emits it)
**Problem:** a kernel OOM-kill (SIGKILL) surfaces as `code=null` → mapped to `-1` → parser throws `RunnerToolError` → `failed_runtime`. OOM is indistinguishable from a generic crash.
**Impact:** operators can't distinguish resource exhaustion (needs a memory-limit / input-size fix) from a tool bug; alerting on resource pressure is blind. Compounds H15.
**Fix:** detect signal-kill termination (`code===null` + `signal==='SIGKILL'`, or the output-cap breach from H15) and surface a distinct typed error mapped to the existing `oom` `ToolStatusV1` status. At minimum capture the termination signal in `error_message`.

### [M6] Malformed `.codemaster.yaml` fails open to defaults but never surfaces the required notice
**Location:** `apps/backend/src/config/config_loader.ts:57-64,168-172` · `load_repo_config.activity.ts:35-39` · `libs/contracts/src/load_repo_config.v1.ts` · `helpers.ts:180-195`
**Problem:** `loadRepoConfig` is correctly fail-open but returns only a `CodemasterConfigV1` — no `was_malformed`/`reason` field, so the orchestrator can't tell a valid-equals-defaults config from a rejected-malformed one. The Python WARN-log + `record_config_malformed` OTel are a structural no-op in this port. The only config notice fires when the PR *touches* the file, not when it's malformed.
**Failure scenario:** a user writes `enabled: nope` or `max_findings_per_file: 9999` (out of 1..100) → the WHOLE doc is rejected, defaults used, their intended opt-out / settings silently vanish with zero feedback. Violates SEED scenario (b) ("fail-open to defaults + a NOTICE").
**Impact:** customers silently lose their review settings (including the safety-critical `enabled: false` opt-out) on any typo. Trust gap, invisible until manual comparison.
**Fix:** add `config_status: 'absent' | 'valid' | 'malformed'` + optional `reason` to the return contract; populate on each fail-open branch; append a "your .codemaster.yaml was malformed and ignored; using defaults" notice finding when status is `malformed`. Port the WARN log + OTel counter.

### [M7] Force-included forbid/security policy rules can blow the prompt token budget with no aggregate ceiling
**Location:** `apps/backend/src/review/prompt_assembler.ts:113-134,237-240` · `extracted_rules.v1.ts:18`
**Problem:** the enforcer force-includes every forbid-intent OR security-category rule past the 3000-token cap with no upper bound; `assertPromptSafety` even throws if such a rule were dropped, so they can't be trimmed. Each rule body is capped at 4000 chars (~1000 tokens) but there's no cap on the NUMBER of forced rules. The classifier matches substrings ('auth','secret','crypto') liberally.
**Impact:** per-chunk prompt cost balloons (paid tokens × every chunk × every PR); the prompt can crowd out retrieved knowledge entirely (`remaining` goes negative → all knowledge dropped); worst case the policy section exceeds the model context budget, risking truncation of the LLM's actual review output.
**Fix:** add a hard ceiling on forced-include tokens (`FORCED_MAX_TOKENS`); when exceeded, keep the highest-priority forbid/security rules and emit a degradation counter. Bound the per-rule body for forced rules. Surface `forced_include_count` breaches as an alert.

### [M8] Rule extractor has no code-fence awareness — code blocks in CLAUDE.md/ADR corrupt the heading tree and mint spurious rules
**Location:** `apps/backend/src/policy/rule_extractor.ts:41,96-137,225-233,265-328`
**Problem:** `splitIntoSections` treats ANY `#`-prefixed line as a heading — including inside fenced ``` code blocks (shell/Python comments, diff hunks). Zero code-fence tracking. `sectionHasListItems` flags a section list-style if any line starts with `-`/`*`/`N.` (common in YAML/diffs/CLI examples), so each code line becomes its own "rule."
**Failure scenario:** SEED scenario (c) — a CLAUDE.md/ADR with a big code block pollutes the heading stack (wrong scope/category/rule_id) and turns code lines into dozens-to-hundreds of garbage rules.
**Impact:** degrades review OUTPUT quality — the LLM is fed nonsense `<policy>` blocks derived from code; rule count explodes (amplifying H6 + M7). "Produces rules" but they're wrong — worse than skipping, because they actively mislead the reviewer.
**Fix:** track triple-backtick (and `~~~`) fenced regions; lines inside an open fence must NOT match `HEADING_RE`/`LIST_MARKER_RE` (treat the block as opaque body text or drop it).

### [M9] Policy resolution is unbounded O(changed_paths × total_rules) with no rule-count cap
**Location:** `apps/backend/src/activities/compute_policy_rules.activity.ts:81-93` · `scope_resolver.ts:131-178` · `policy_compute.v1.ts` (no `changed_paths` cap)
**Problem:** `computePolicyChain` flatMaps `extractRules` over up to 200 files (cap is on FILES, not rules), then calls `resolveGuidance` for EVERY `changed_path`, filtering/dedup/sorting the full rule list per path. `changed_paths` has no max length.
**Impact:** combined with H6 (unenforced timeout), a large monorepo PR pins a shared worker for an extended synchronous burst, stalling the heartbeat + every co-tenant review.
**Fix:** add `MAX_TOTAL_RULES` and a `changed_paths` cap (or batched resolution). Precompute a `scope_dir → rules` index once and look up per path instead of re-filtering. Pair with the H6 yield/offload.

### [M10] Mutex-renew loop is fail-open on transient DB errors → silent lease expiry + possible double-post during a sustained DB blip
**Location:** `apps/backend/src/runner/review_job_shell.ts:247-289` (both renew paths `.catch(() => true)`)
**Problem:** both the claim-check renew and the background renew loop treat ANY renew error as fail-open. During a sustained DB outage affecting only renew round-trips (pool exhaustion, slow primary), the loop swallows errors forever, the DB-side lease silently expires, the janitor / a newer run reclaims it, and TWO executions can post on the same PR.
**Impact:** low-probability, high-consequence: duplicate review comments precisely during a DB incident, the moment the system is least observable.
**Fix:** bound the fail-open window — track consecutive renew failures (or elapsed time since last success) and, once it exceeds the lease TTL, treat it as a definitive loss (abort → `TerminalCancelError` mutex-lost). Also increment a `codemaster_runner_mutex_renew_errors_total` counter + WARN (see observability gaps).

### [M11] `reapStuckRuns` only covers leased jobs — a review in long backoff (`state='ready'`) strands its run at RUNNING
**Location:** `apps/backend/src/runner/review_jobs_repo.ts:387-411` (reapStuckRuns: `state='leased'` only) · `review_run_reaper.activity.ts` (NOT EXISTS guard excludes ready/leased)
**Problem:** after `markFailed` re-enqueues to `state='ready'` with exponential backoff (up to minutes), the run stays RUNNING. `reapStuckRuns` only reaps `leased` rows; the age-sweep reaper excludes any run with a `review_jobs` row in (ready, leased). So the backing-off run is covered by neither reaper.
**Impact:** PRs show a stuck "In Progress" review for the whole multi-minute backoff window — degraded UX + a coverage seam in the liveness backstop.
**Fix:** surface the backoff state in the UI ("retrying" not "in progress"), or move a re-enqueued run out of RUNNING during backoff, or extend the age-sweep to reap runs whose only review_jobs row is a far-future `ready` past the stale threshold.

### [M12] Scheduler cron vocabulary is daily-only — every-N-minute cadences drift; richer crons poison-loop every poll
**Location:** `apps/backend/src/runner/scheduler.ts:61-86` (computeNextRun) · `cron_schedules.ts:51-128`
**Problem:** `computeNextRun` supports only `interval` (N seconds) and daily `M H * * *`; any step/list/range throws. The Temporal `*/5`/`*/10` schedules were re-encoded as `interval=300/600`, which drifts off wall-alignment. An operator inserting a legitimate `*/15 * * * *` produces a row that throws on EVERY poll — left unadvanced and re-WARN-logged forever.
**Impact:** strictly less expressive than the Temporal Schedules it replaces; interval re-encoding drifts relative to wall clock; a normal cron becomes a silent permanently-stuck schedule. Operator-authored schedules are inevitable at scale.
**Fix:** extend `computeNextRun` to handle the common cron subset (`*/N`, comma-lists, ranges) — the parser is pure and unit-testable — OR validate `cron_spec` at insert/seed time so a poison schedule is rejected up front.

### [M13] One poisoned UPDATE in a scheduler pass aborts the shared transaction, cascading every remaining schedule to re-tick
**Location:** `apps/backend/src/runner/scheduler.ts:120-158` (single trx wrapping all per-row advances)
**Problem:** `pollAndEnqueue` runs the whole due batch inside ONE `db.transaction()`. The per-schedule try/catch isolates `computeNextRun` (pure-JS) faults, but if a single `next_run_at` UPDATE errors (serialization failure, deadlock), Postgres aborts the ENTIRE transaction — every subsequent advance fails with "current transaction is aborted" and is swallowed as "left unadvanced."
**Impact:** a single transient UPDATE failure makes every later schedule re-fire its enqueue on the next poll. Dedup keeps it at-least-once (not duplicate work), but it amplifies one transient fault into a whole-batch re-tick + WARN burst.
**Fix:** advance each schedule's `next_run_at` in its OWN transaction (or a SAVEPOINT per schedule) so one poisoned UPDATE rolls back only that schedule. Update the module doc to stop claiming full per-schedule isolation for SQL-level faults.

### [M14] Ledger replay double-counts cost in `telemetry.llm_calls` (cost-attribution/billing table)
**Location:** `apps/backend/src/integrations/llm/client.ts:715-737`
**Problem:** on a ledger replay HIT, `recordCallCost` into `cost_daily` (the cap) is correctly skipped via `if (!isReplay)`, but `telemetry.recordCall` into `telemetry.llm_calls` runs UNCONDITIONALLY under a fresh `requestId`. Every replay writes another `llm_calls` row charging the same completion.
**Impact:** `SUM(cost_usd_cents)` over `telemetry.llm_calls` overstates real Bedrock spend whenever chunks replay (the whole-job retry recovery path). Per-org cost reporting + incident cost attribution become inaccurate at 60+ orgs (the actual cap `cost_daily` stays correct).
**Fix:** gate the cost-bearing fields of the replay-path telemetry row — skip `recordCall` on `isReplay`, or write the row with `costUsdCents=0`/`status='replay'`.

### [M15] Crash between ledger store and `recordCallCost` leaks the cost-cap reservation permanently for that day
**Location:** `apps/backend/src/integrations/llm/client.ts:651-664` (store) vs `:730-737` (recordCallCost)
**Problem:** on a paid MISS, the order is reserve `estimated` → store ledger → `recordCallCost` reconciles `actual - estimated`. A crash AFTER `store` but BEFORE `recordCallCost` means the retry's ledger lookup HITS, `isReplay=true`, and `recordCallCost` is SKIPPED — the `estimated` reservation is never reconciled down to `actual`. Since `estimateCentsPreCall` uses a conservative 1024-token ceiling, `cost_daily` is left over-reserved by `(estimated - actual)`.
**Impact:** daily `cost_daily` drifts upward on every crash-during-store → premature cost-cap denials (`BedrockBudgetExceededError`) blocking legitimate reviews for the rest of the UTC day — biting HA during the pod-churn incidents when reviews most need to flow.
**Fix:** make the store→reconcile pair crash-safe: persist the reconciliation diff atomically with the ledger row (store final cents; replay path applies the reconciliation once via an idempotent marker), or move `recordCallCost` BEFORE `store`.

### [M16] LLM review calls never force `tool_choice` — the model may answer in prose and yield ZERO parsed findings
**Location:** `apps/backend/src/integrations/llm/bedrock_sdk_adapter.ts:110-116` · `client.ts:593-605`
**Problem:** the Bedrock request params are only `{model, messages, max_tokens, system?, tools?}` — no `tool_choice`. The parser ignores non-`tool_use` blocks. Absent `tool_choice:{type:'tool'|'any'}`, the model is free to respond with plain-text analysis and emit no tool call → the chunk produces ZERO findings even though it "reviewed."
**Impact:** intermittent silent recall loss — chunks where the model chose prose contribute no comments, with no error/signal. Degrades completeness vs SaaS competitors that force structured output.
**Fix:** thread a `tool_choice` (`{type:'tool', name:'report_finding'}` or `{type:'any'}`) through `BedrockCreateParams` + `createMessage` for the review-chunk purpose. Validate empirically against a corpus before flipping.

---

## PR-Review Output Quality (product-quality improvements)

These are the levers to beat market SaaS tools on recall/precision/usefulness. Several appear above as H/M findings; collected here for the quality roadmap.

- **[H13] Per-chunk 2048-token ceiling with no continuation** — the dominant recall cap. Continuation turns + a truncation note are the single highest-leverage quality fix.
- **[H14] Cross-file/consumer-breakage awareness fed empties** — wire the symbol-graph producer so `context_breaks_consumer` findings can fire; load `prior_findings` to stop duplicate inline comments across pushes.
- **[H5] Oversized governance docs skipped** — truncate-and-parse so the biggest CLAUDE.md still drives policy.
- **[M8] Rule extractor mints garbage rules from code blocks** — code-fence awareness; wrong rules are worse than no rules.
- **[M16] No forced `tool_choice`** — prose responses silently yield zero findings.
- **[Q1] No confidence floor / calibration** (`apps/backend/src/llm/review_prompt.ts:222`, `post_review_results.activity.ts:239-258`) — `confidence` is a bare 0.0-1.0 with no schema description, no calibration guidance, and is never a precision gate (used only for ranking/dedup). A 0.30 speculative finding posts as a normal inline comment at full weight. Add calibration anchors to the field description + system prompt, and a configurable confidence floor (drop/down-rank below ~0.5) surfaced via `.codemaster.yaml`.
- **[Q2] Dedup is exact-key + same-file 0.92-cosine only** (`aggregation.ts:115-165`, `aggregation_semantic.ts:138-227`, `dedup_findings.activity.ts:113-119`) — a linter "E501 line too long" and an LLM "this line exceeds the style limit" on the same line have different categories + bodies, so neither dedup stage fires → both post. Two LLM findings one line apart bypass exact-dedup and miss 0.92 cosine. Add a line-proximity-aware pass: collapse same-file findings whose ranges OVERLAP (or within N lines) with a lower threshold for the linter↔LLM cross-source case.
- **[Q3] Walkthrough generated with the REVIEW system prompt + only sees finding titles** (`walkthrough_activity.ts:297,162-198`) — `change_summary` per-file text is ungrounded (no diff input → hallucination risk); clean files (no findings) can't appear. Introduce a dedicated walkthrough system prompt and feed a compact per-file change manifest (paths + change kind + line counts from topology already in the orchestrator).
- **[Q4] `suggestion` field has no schema description and isn't encouraged** (`review_prompt.ts:221`, `review_activity.ts:114-118`) — the renderer turns a non-null suggestion into a one-click GitHub `suggestion` block, but whether the model populates it is left to chance. Add a field description + a system-prompt sentence encouraging concrete minimal fixes for localized bug/security/performance findings.
- **[Q5] Retrieved-knowledge budget is only `top_k=5`** (`orchestrator.ts:1019`) — thin grounding for subsystems with substantial docs. Make `top_k` configurable (default ~8-10), sized against `MAX_KNOWLEDGE_CHARS`, routed through the budget enforcer so extra chunks are ranked/trimmed rather than displacing policy/forbid rules.

---

## Lower-severity findings (Low)

- **[L1] No per-tenant fairness in the outbox drain** (`outbox_dispatcher_loop.ts:100-135`, `outbox_repo.ts:208-212`) — single sequential-per-row FIFO loop; a slow/burst tenant's rows block every other tenant's dispatch (including review-trigger + repair events post-cutover). Dispatch rows concurrently within a batch (bounded pool; rows are already leased), and add a per-installation cap in the claim. *(Medium-leaning; sits at the boundary with H2/H12.)*
- **[L2] GitHub 5xx backoff has no jitter** (`api_client.ts:461-471`) — synchronized retry herd across the fleet during a GitHub incident amplifies load on the degraded endpoint. Add full jitter via the injected randomness seam (the job-level `markFailed` already jitters ±25%).
- **[L3] `core.review_jobs` claim index doesn't cover the leased-reclaim arm or the reaper scan** (`migrations/0036_review_jobs.sql:34`) — the identical issue was fixed for `background_jobs` in migration 0042 (split partial indexes); `review_jobs` never got the equivalent. Backport: `ix_review_jobs_ready_claim (priority DESC, run_after, created_at) WHERE state='ready'` + `ix_review_jobs_leased_expiry (leased_until) WHERE state='leased'`, and extend the claim ORDER BY with a deterministic `created_at, job_id` tie-break.
- **[L4] `core.review_jobs` has no retention/pruning** (`migrations/0036:35`) — terminal rows are never deleted; the all-states `ix_review_jobs_installation` and the heap grow unbounded. Add a retention janitor (mirror `run_id_retention`) + a `scheduled_jobs` cron.
- **[L5] `cache.cache_idempotency` grows unbounded** (`github_webhook_persistence.ts:567-574`, `migrations/0001_baseline.sql:652,4896`) — `expires_at` is set + indexed but never enforced or swept; no prune job exists. The webhook firehose inserts a row per delivery forever. Add a retention cron DELETE-ing `expires_at < now()` in bounded batches (delivery_ids never reuse).
- **[L6] Partitioned `webhook_events` relies on `pg_partman` but `partman.part_config` is unseeded** (`migrations/0001/0002`, `partition_maintenance.activity.ts`) — weekly partitions stop at 2026-06-24; after that everything lands in `webhook_events_default` (an unbounded catch-all that also blocks future range ATTACH). Seed `partman.part_config` (verify in a throwaway PG at localhost:5433 per memory) or have `partition_maintenance` create partitions itself.
- **[L7] `ck_posted_reviews_comment_ids_array` CHECK added directly (ACCESS EXCLUSIVE + full scan)** (`migrations/0037:27-28,40-44`) — deviates from the locked expand-contract migration discipline (`ADD CONSTRAINT ... NOT VALID` then separate `VALIDATE`). Low because posted_reviews is low-volume and rows already pass, but flag for consistency.
- **[L8] `BackgroundJobV1`/`ScheduledJobV1` declare `schema_version` with no backing DB column** (`background_job.v1.ts:31`, `scheduled_job.v1.ts:22` vs migrations 0039/0040) — Zod `.default(1)` synthesizes a constant; the field is never persisted/written. Nominal-only versioning; a future payload-shape change has no discriminator column. Either add a real `schema_version int NOT NULL DEFAULT 1` column (preferred, matches review_jobs) or remove the field and document handler-contract versioning.
- **[L9] Migration/scheduler docs say `dedup_key = schedule_id || ':' || bucket` but the code uses bare `schedule_id`** (`migrations/0039:47`, `0040:4` vs `scheduler.ts:141`) — no `bucket` concept exists; the code is correct (a `:bucket` suffix would break overlap=SKIP). Documentation-only; correct the comments.
- **[L10] BF-9 cross-installation guard bypassed on the webhook allocation path** (`_review_run_allocator.ts:62-89`, `_supersede.ts:59-62`) — `allocateRun` calls `supersedeRun`/`flipCurrentRun` without `expectedInstallationId`, so the tenancy fence is dormant (WARN-and-skip "Phase-B grace period"). Thread the resolved `internalIid` through to enforce the fence on the ingestion path.
- **[L11] Graceful shutdown disposes only the core-DSN pool** (`background_runner_main.ts:509` vs `partition_maintenance.activity.ts:89-125`) — a distinct `CODEMASTER_PG_MAINT_DSN` pool leaks across SIGTERM (`disposeAllPools()` exists but is unused). Can hang the pod past `terminationGracePeriodSeconds`. Call `disposeAllPools()` instead of single `disposePool(dsn)`.
- **[L12] No trace/span correlation in the de-Temporal runtime** (`review_job_runner.ts`, `review_job_shell.ts`, `outbox_dispatcher_loop.ts:108-122`) — logs/metrics carry no shared `trace_id`; the outbox-carried `trace_context` is read but not opened as a continuing span, breaking the webhook→outbox→review chain in Tempo. Open an OTel root span per `runOneJob` keyed on run_id/installation_id/head_sha; continue the outbox `trace_context`; inject trace_id into the structured logs (the C4 logger).
- **[L13] Heartbeat-loop / orphan-handler failures swallowed with bare catch + no error detail** (`review_job_runner.ts:91`, `background_runner.ts:98,136`) — counters fire but the underlying error is discarded, so a recurring fault is countable but un-diagnosable. Capture + WARN-log `error_class` before aborting.
- **[L14] Cost rounding floors cheap-model spend to 1 cent/call** (`client.ts:144-150,133-142`) — Haiku curator runs on every PR; sub-cent calls all record as 1 cent, biasing the cost cap conservative-low. Track cost in micro-cents (coordinate with the Python parity owner).
- **[L15] Several runner/retention/pool tunables are env-driven but absent from the chart** (covered in the Deployment wave): `CODEMASTER_BG_*` (lease/heartbeat/max-runtime/idle/scheduler-poll/outbox-idle), `CODEMASTER_PG_POOL_MAX` (hardcoded 8), `CODEMASTER_LLM_LEDGER_RETENTION_DAYS`/`_PRUNE_INTERVAL_S`, `CODEMASTER_PG_MAINT_DSN` (commented out → DDL runs on the core pool). Surface each as a `values.yaml` knob → ConfigMap with schema bounds. Chart self-description still says "Temporal review worker."
- **[L16] No DB-INVARIANT preflight** (`migrate-job.yaml`, `main.ts`) — the migrate Job runs `migrate:up` but nothing fails the deploy when the running image's expected schema revision ≠ the cluster DB head. The team's own memory records a 2-week alembic-drift incident + a DB-INVARIANT gate that the TS port did not carry forward. Add a boot-time revision+fingerprint check (fail-loud before binding HTTP).
- **[L17] HPA scales on CPU% only** (`hpa.yaml:15-31`) — review work is I/O-bound on Bedrock/GitHub/Postgres; a deep queue backlog produces little CPU, so the HPA never scales out. Add a queue-depth custom/external metric (pending `core.review_jobs`/`background_jobs`/`outbox` rows via Prometheus Adapter); consider splitting the runner into its own Deployment so review throughput scales independently of HTTP ingest.

---

## Self-Healing & Ingestion gaps (collected)

- **[H4]** out-of-order installation webhook → permanent silent review-coverage loss (repair not wired).
- **[H8]** dead-letter has no operator surface/replay.
- **[I1] Suspending/deleting an installation or removing a repo never cancels in-flight/pending reviews; new PRs for suspended installations still dispatch** (`github_webhook_persistence.ts:559-686`, `_supersede.ts:14-21`, `review_jobs_repo.ts:304`) — the cancel reasons `installation_suspended`/`repository_disabled` exist but have NO producer; the PR dispatch path never checks `suspended_at`/`enabled`. A PR racing a suspend allocates a full review against a revoked App; `installation.deleted` doesn't abort the pending review_jobs already enqueued. Add a suspended/enabled preflight in the dispatch path + wire a producer that supersedes/cancels active runs + pending jobs on suspend/delete/remove. **(Severity: High — recurring wasted spend + reviews posted on disconnected repos.)**

---

## Prioritized Implementation Order (waves)

### Wave 0 — BLOCK the cutover until these land (highest leverage, lowest effort)
The cutover is unsafe today. These are mostly small, surgical changes that prevent self-inflicted full outages.
1. **C6** — compose the review-jobs `RunnerLoop` into `buildBackgroundRunner` + boot-time guard refusing the review sink without a consumer.
2. **C7 + C9** — make `resolveBootTasks` mutually exclusive (drop Temporal tasks when the runner flag is on). Resolves both the double-register crash and the double-cron.
3. **C8** — add the `config.runtime` Helm block + schema rule coupling the two flags.
4. **C5** — wire real `/readyz` + `/healthz` checks + per-loop liveness heartbeat; re-point probes.
5. **H7** — trip `stopAll` on the first loop crash so a degraded pod restarts; alert on `loop_crashed`.

### Wave 1 — Resilience of the core review loop (fail-open / retry / fail-soft)
6. **C1** — wrap `staticAnalysis` in fail-open `stageOutcome`; make the curator fail-open on retryable + budget errors.
7. **C2** — make the chunk fan-out fail-soft (`raiseAfterLog:false` / failure-isolation slot).
8. **H1** — wire `runWithRetry` into the retryable idempotent ports.
9. **H3** — plumb GitHub/Bedrock `Retry-After`/`resetAt` into `run_after` without burning an attempt.
10. **M2** — wrap classify/dedup/aggregate in `stageOutcome`.
11. **H15 + M5** — bound subprocess output; emit the `oom` status. **M1** — cap argv file lists.

### Wave 2 — Observability (so Waves 1/3 are verifiable in prod)
12. **C3 + H10** — decouple `recordStage` + lifecycle + policy-invariant metrics from `inWorkflowContext`.
13. **C4** — replace the discard logger with a structured sink.
14. **H11 + H12** — structured failure logs + an outbox dispatch metrics module.
15. **L12** — OTel trace/span correlation across runner → shell → LLM → GitHub.

### Wave 3 — Scale & fairness
16. **H2** — per-tenant fairness in the review claim. **L1** — outbox per-tenant fairness + intra-batch concurrency.
17. **H9** — idempotent review enqueue (`ON CONFLICT`/delivery_id). **H8** — dead-letter surface + replay.
18. **H6 + M9** — bound/offload synchronous policy compute; rule-count + changed_paths caps.
19. **L3 / L4 / L5 / L6** — index + retention + partition fixes. **L17** — queue-depth HPA. **L16** — DB-INVARIANT preflight. **L15** — surface the runner/pool/retention tunables in the chart.

### Wave 4 — Self-healing & ingestion correctness
20. **H4** — wire `maybeEnqueueRepair` + raise reconcile attempts. **I1** — suspend/disable preflight + cancel producer.
21. **M10 / M11 / M12 / M13** — mutex-renew bounded fail-open; reaper backoff-coverage; cron vocabulary; per-schedule txn isolation.
22. **M14 / M15 / L14** — cost-correctness (telemetry double-count, reservation leak, sub-cent flooring).

### Wave 5 — Output quality (beat the SaaS tools)
23. **H13** — per-chunk continuation + truncation note + raise default maxTokens.
24. **H14** — wire cross-file/consumer/prior-findings producers.
25. **H5 + M8 + M7 + M16** — policy doc truncation, code-fence awareness, forced-rule ceiling, `tool_choice`.
26. **Q1-Q5** — confidence calibration/floor, proximity dedup, dedicated walkthrough prompt + change manifest, suggestion encouragement, knowledge top_k.

### Wave 6 — Temporal teardown (after the runner is wired + parity-gated)
See appendix. Removes the largest clean-code liability + the dual-orchestration drift hazard.

---

## Appendix — Temporal teardown (delete-list)

Per `docs/superpowers/plans/2026-06-10-de-temporal-full-removal-program.md` the owner directive is "Temporal is removed entirely." Every workflow already has a Postgres handler analogue calling the same shared `build_activities.ts` + `orchestrate()`. Carrying ~4,100 LOC of dead-on-cutover code keeps two parallel orchestration paths in hand-maintained lockstep (the shell already enumerates 7 "load-bearing differences from the Temporal body" — they WILL drift) and keeps the `@temporalio` dependency graph + V8-isolate constraints alive.

**Deletable NOW (zero callers, no cutover dependency):**
- `apps/backend/src/workflows/review_skeleton.workflow.ts` (52 LOC — verified: referenced only by itself, not even registered in `all_workflows.ts`).

**Delete after the review-jobs runner is wired (Wave 0) + each workflow's parity gate passes:**
- `apps/backend/src/workflows/*.workflow.ts` (14 files, ~2,300 LOC incl. `review_pull_request.workflow.ts` 1103 LOC).
- `apps/backend/src/worker/{main,outbox_dispatcher_main,ensure_schedule,temporal_config,data_converter,registry,outbox_dispatcher_singleton}.ts`.
- `apps/backend/src/adapters/{real_temporal_client,temporal_port}.ts` · `apps/backend/src/api/admin/_admin_temporal_port.ts`.
- `apps/backend/src/workflows/{all_workflows,activity_proxy}.ts`.
- The 17 `@temporalio` test files · the `@temporalio/*` + `@temporalio/testing` `package.json` deps · the `TEMPORAL_*` `.env.example` block · the `TEMPORAL_*` ConfigMap rendering + chart self-description.

**KEEP (shared by the Postgres runtime):** `build_activities.ts`, `orchestrate()`, `_supersede.ts`, the activity bodies, the contracts.

**Companion cleanup (M-class, do alongside):**
- **[T1] Two parallel job-runner stacks duplicate lease/fence/heartbeat/claim/settle/reap logic** (`review_job_runner.ts` + `review_jobs_repo.ts` vs `background_runner.ts` + `background_jobs_repo.ts`; `PayloadIntegrityError` defined twice) — extract the shared SQL discipline into one parameterized core (table name + columns injected) both repos compose; define `PayloadIntegrityError` once. Removes the lockstep-by-hand drift hazard the mutex-liveness redesign just fixed elsewhere.
- **[T2] Event handlers lost Temporal's per-fault non-retryable classification** (`event_handlers.ts:97-105`) — `GitHubAppUnauthorized`/`GitHubNotFoundError`/`WrongVectorDimensionError` now burn the full retry curve before dead-lettering. Wrap them in `PermanentJobError` at the throw sites (the already-planned W4a.1 follow-up) so they fail fast on attempt 1.

---

*End of audit. Findings are referenceable by ID (C#/H#/M#/L#/Q#/I#/T#).*
