# MASTER Hardening Plan — codemaster de-Temporal Postgres Runtime

**Date:** 2026-06-11
**Branch:** `feat/de-temporal-runner-phase1`
**Worktree:** `/Users/ascoe/Projects/.cmb-worktrees/de-temporal-runner-phase1`
**Author:** Principal engineer (synthesis of five parallel audits + owner-mandated items + six runtime-review findings)

> **OWNER STEER (2026-06-11): OTel/metrics deferred — "we don't need OTel right now."**
> Theme 2 splits in two. **DEFERRED (not now):** XC5 (register a `MeterProvider`/exporter) and the *metric-emission* halves of C3 / H10 / H11 / H12 / RM4 — the OTel pipeline is parked. **STILL TIER-0 (these are NOT OTel):** the **structured-logging** fixes (C4's discard-logger → real logs carrying `run_id`/`stage`/`outcome`, so a degraded review is visible *in logs*) and the **readiness/liveness probes** (C5 / H7 / XH11 / RT2 — Kubernetes health, the actual self-healing trigger). Net: observability-via-metrics is parked; observability-via-logs + K8s-probes remains a gating blocker. Do-this-first item #4 (XC5) is removed; item #5 keeps only its logging half.

## Source audits merged

| Doc | IDs | Raw count |
|-----|-----|-----------|
| `2026-06-11-codemaster-hardening-audit.md` (13-lens core) | C1–C9, H1–H15, M1–M16, Q1–Q5, L1–L17, I1, T1–T2 | 47 |
| `2026-06-11-other-workflows-resilience-audit.md` | OC1–OC4, OH1–OH9, OM1–OM11 | 24 |
| `2026-06-11-edge-subsystems-audit.md` | EC1–EC5, EH1–EH11, EM1–EM7, EL1–EL2 | 25 |
| `2026-06-11-audit-recovered-lenses.md` | RC1–RC8, RH1–RH15, RM1–RM14, RL1–RL5 | 42 |
| `2026-06-11-cross-cutting-characteristics-audit.md` (5-tier backbone) | XC1–XC9, XH1–XH13, XM1–XM14 | 35 |
| **Total raw** | | **173** |

Plus **4 owner-mandated workstreams** (backpressure, payload versioning, review-state SSOT, external-boundary idempotency) and **6 runtime-review findings** (`RT1`–`RT6`) — deduped against the audit IDs below.

After ruthless dedup the 173 raw findings collapse into **~110 unique root issues** organized into **6 tiers / 41 waves**. Every raw ID appears below — in a wave's "Closes" list or the explicit Deferred/Low register at the end. **Nothing is dropped.**

---

## 1. Executive Summary

### Is codemaster production-ready? No. The de-Temporal cutover is unshippable as written.

The port is *faithful* and the pipeline *composes*, but five independent audits converge on the same verdict: flipping the cutover flags today causes a **self-inflicted full outage or a silent review black-hole**, and even if it booted, the platform **cannot observe, measure, recover, or survive** itself. There are eight systemic themes, each with at least one critical root.

**Theme 1 — The cutover is a loaded gun (cluster of self-inflicted outages).**
The two boolean cutover flags (`CODEMASTER_RUN_BACKGROUND_RUNNER` + `CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS`) are *additive only*: they never remove Temporal. Flipping them today either **crash-loops the whole pod** (double sink-registration — C7/RC8), **black-holes every review** (the review-jobs `RunnerLoop` is composed nowhere — C6/OC4), or **double-runs every cron** (C9). There is no Helm knob (C8), no mutual exclusivity in code, and the readiness probes reflect nothing (C5/XH11). The real fix is an explicit runtime **MODE = `temporal|postgres|shadow`** (RT1) that makes the two worlds mutually exclusive by construction.

**Theme 2 — Observability is a no-op; XC5 gates everything.**
**No `MeterProvider`/exporter is ever registered** — all ~62 OTel instruments emit into a no-op Meter (XC5). On top of that, the de-Temporal pipeline gates per-stage/lifecycle/security metrics on `inWorkflowContext()`, which is always false in the plain-Node shell (C3/H10), threads a discard logger that drops every degradation warning (C4), and emits zero metrics from the outbox loop (RM4/H12). Even after the narrow gating fixes, **the metrics still go nowhere until XC5 lands.** No alert can fire on any crashed loop, dead-letter spike, cost-cap breach, or quality regression. The signal is hollow-green (XC2/XC3).

**Theme 3 — Knowledge retrieval is near-noise and silently drifts (RC4/EC2 cluster).**
The vector query is just `chunk.path + PR title` — the diff/code never drives the search (RC4); repo-knowledge retrieval ignores the active generation and the production reranker is a no-op (EC2/RH9); there is no similarity floor (RH10), specificity is hardcoded zero (RH8), staleness is never consumed (RH4), and the whole embedder re-embed lifecycle is decorative end-to-end (EC1/EC3). Separately the corpus **drifts from HEAD and never self-heals** (OC1/OH1/OH3/OH4/OH3). The single biggest quality lever is effectively disabled and invisible.

**Theme 4 — No DR for the single-Postgres SPOF (XC1).**
Postgres is the only persistent store, and the cutover moves *all* durable workflow/job/outbox/mutex state onto it — removing Temporal's history as a recovery aid — yet there is **no backup, no PITR, no replica, no failover, no DR runbook** (XC1). The team has already lost a dev DB with `archive_mode=off`. No RPO/RTO can even be reasoned about. There is also no boot-time DB-revision preflight (XH7/L16) and migrations are up-only with no rollback (XM14).

**Theme 5 — No eval/feedback loop; the SaaS differentiator gap is total (XC7/XC8).**
Review quality — the one dimension the product competes on — has **no measurement** (no eval/golden harness, no precision/recall/groundedness — XC8) and **no closed loop** (`feedback_events` is write-only, `learnings` is vestigial, suppression is a frozen YAML, `prior_findings` is hard-coded `[]` — XC7/XH9/XH10). Every prompt/model/chunker/retrieval change ships blind; a finding dismissed 50× re-posts at full weight on push 51.

**Theme 6 — Security / audit-integrity cluster (RC1/EC4/EC5/EH7/RH1).**
A detected secret is stored in **cleartext** in `audit.audit_events.before` (RC1); **CSRF verification is never wired** on the most privileged surface (EC4); **audit emission is dead on the production path** (EH7) and **the field-encryption key registry never loads on worker/runner pods**, so every self-healing audit-emit throws and re-wedges the ADR-0064 stuck-review class (EC5); the entire raw-SQL runner data plane is invisible to tenancy enforcement with only a WARN-mode gate (RH1/RH2); revoked roles still authenticate (EM4).

**Theme 7 — Cost-lock scale ceiling (XC4).**
Every paid LLM call takes a `SELECT ... FOR UPDATE` on **one global `cost_daily` row** shared across all 60 orgs; under fan-out a hot-row lock storm makes chunk reviews **fail closed** (`BedrockBudgetExceededError` is non-retryable) even when the budget is nowhere near exhausted (XC4). No prompt caching (XM1), unbounded per-chunk retrieval (XH13), and no backpressure (RT/owner-mandated) compound it.

**Theme 8 — Resilience curves silently narrowed; per-activity fault-tolerance was deleted in the port.**
Temporal's per-workflow retry budgets, per-activity timeouts, and permanent-vs-retryable classification were all collapsed to one-size-fits-all runner defaults (RC5/RC6/RC7/H1/H3). `runWithRetry` has **zero production callers** (verified); a single transient chunk blip forces a full re-clone + re-review + re-pay (H1); a first-error-wins fan-out discards all peers (C2); a Tier-1 budget hit fails the whole review (C1); rate-limit `Retry-After`/`resetAt` hints are computed and thrown away (H3/RC6/XH2). Self-healing reapers are unbooted or idle-gated (OC3/OC4); the workspace orphan sweep is dead (OH5); dead-letters have no operator surface (H8/XC6/EH8).

### Gating blockers

The cutover **must be blocked in code** until the Tier 0 "do-this-first" list (Section 3) lands. Tier 1 (quality differentiator) is what makes the product worth shipping; Tiers 2–5 harden it for 3000-repo scale and long-term operability.

---

## 2. Unified Tiered Backlog

Effort key: **S** ≈ ≤1 day · **M** ≈ 2–4 days · **L** ≈ ≥1 week. Each wave lists the **root approach** and every **finding ID it closes** (across all five docs + owner-mandated + RT runtime). IDs may be re-merged where the same root spans audits; the cross-references are intentional.

---

### TIER 0 — Stop-the-bleeding before the cutover can be flipped

*The cutover is unsafe today. These prevent silent data loss, full outages, and blind operation. Tier 0 is the hard gate on the de-Temporal flip.*

**W0.1 — Explicit runtime MODE (`temporal|postgres|shadow`); make the two worlds mutually exclusive.** **[M]**
Replace the additive boolean flags with one `CODEMASTER_RUNTIME_MODE`. In `postgres` mode, `resolveBootTasks` boots ONLY the background-runner + review-jobs runner and does NOT boot the Temporal worker or the Temporal outbox dispatcher; in `temporal` mode the inverse; `shadow` runs the Postgres runtime read-only/observe alongside Temporal for validation. Single sink-registration owner per mode. This is the root fix for the no-exclusivity criticals.
*Closes:* **RT1**, **C7**, **C9**, **RC8** (double sink-register crash), **C8** (Helm knob — render `runtime.mode` to ConfigMap + `values.schema.json`), **OC4-guard** (no Temporal/Postgres coexistence).

**W0.2 — Compose & boot the review-jobs RunnerLoop + the unified reaper; fail-loud if a sink has no consumer.** **[M]**
Construct the review-jobs `RunnerLoop` (bound to `runReviewJob`) and `ReviewJobsRepo.reapStuckRuns` in `buildBackgroundRunner` (or a dedicated Deployment). Add a boot-time guard in `wireOutboxSinks` that refuses to register the review-route sink when no review-jobs consumer is composed. Add a liveness alert on `review_jobs state='ready'` older than N minutes.
*Closes:* **C6**, **OC4**.

**W0.3 — Decouple the stuck-job reaper from idle; wall-clock cadence.** **[S]**
Run `reapStuckRuns()` on a throttled wall-clock timer inside the loop (mirror the review runner's monotonic prune throttle), independent of `claim()` outcome, so it fires under saturation — exactly when crashed-pod leases accumulate. A single exhausted-lease row must not wedge an entire interval cron via its dedup key.
*Closes:* **OC3**.

**W0.4 — Register a `MeterProvider`/exporter at boot; assert non-no-op in production.** **[M]**
Construct a `MeterProvider` with `PeriodicExportingMetricReader` → OTLP (or a Prometheus `/metrics` route + ServiceMonitor) before boot tasks; call `setGlobalMeterProvider()`. Boot assertion + test that a non-no-op provider is registered when `nodeEnv=production`. **This unblocks every downstream alert.**
*Closes:* **XC5**.

**W0.5 — Decouple stage/lifecycle/security metrics from `inWorkflowContext`; structured logging; outbox metrics.** **[M]**
Route `recordStage`, finding-lifecycle, and policy-invariant counters through the platform OTel meter with a non-workflow emit branch (keep replay-safety where a workflow context exists). Replace the discard `StageLogger` (`void msg`) with a structured pino sink carrying run_id/installation_id/head_sha/repo/trace_id. Add a `codemaster_outbox_dispatch_total{sink,outcome}` counter + structured WARN at the per-row catch + dead-letter backlog gauge.
*Closes:* **C3**, **C4**, **H10**, **H11**, **H12**, **RM4**, **L12** (trace correlation), **XM14**(structured-logs slice).

**W0.6 — Wire real readiness/liveness reflecting loop health; pair loop supervision with `/readyz`.** **[M]**
Wire `buildApp({ postgresCheck: SELECT 1, vaultCheck, loopLivenessCheck })`. Each supervised loop publishes a last-tick heartbeat; `/readyz` sheds traffic and `/healthz` 503s when a *required* loop is stale or DB/Vault is down (so a dead loop ⇒ pod unready, not isolate-and-continue-silently). Trip `stopAll` + fail-loud re-throw on the first required-loop crash so K8s restarts the pod; page on `loop_crashed`.
*Closes:* **C5**, **H7**, **XH11**, **RT2** (loop-health → readiness).

**W0.7 — Load the field-encryption key registry at worker/runner boot, fail-loud; CLEARTEXT-secret fix.** **[M]**
Call `loadFieldEncryptionKeyRegistry(VaultHttpPort.fromEnv()) + setAuditKeyRegistry(...)` unconditionally at `worker/main.ts` and `background_runner_main.ts` boot (decoupled from `CODEMASTER_AUTH_ROUTES_ENABLED`), with a startup self-check that crashes the pod if the registry is null. Stop storing the pre-redaction `original_text` in cleartext — encrypt the audit `before` payload with the AES-GCM-AAD codec (fail-closed) or drop `original_text` entirely.
*Closes:* **EC5**, **RC1**.

**W0.8 — Postgres HA/DR before cutover (or document SPOF + accept).** **[L]**
Streaming standby + automated failover (CloudNativePG/Patroni) + WAL archiving + continuous base backups (pgBackRest/wal-g → BlobStore) for PITR; document RPO/RTO + `docs/runbooks/postgres-disaster-recovery.md` with cutover-specific recovery (rebuild outbox/job/mutex after restore); quarterly restore drill. *Until a replica exists, the cutover decision must explicitly accept Postgres as a known SPOF.*
*Closes:* **XC1**.

**W0.9 — TS DB-revision boot preflight (fail-loud); migration 0042 cold-only guard.** **[S]**
Read the applied head from `pgmigrations`, assert it equals the image's compiled-in expected head (+ fingerprint); `process.exit(1)` on mismatch before binding HTTP and before runner loops. Add a preflight/cleanup guard (or explicit cold-only assertion that aborts if rows exist) to migration 0042, which `DROP`s a CHECK + index and `CREATE`s indexes non-concurrently on the assumption `core.background_jobs` is empty.
*Closes:* **XH7**, **L16**, **RT6** (0042 cold-table guard).

**W0.10 — Restore fail-OPEN core-loop resilience: Tier-1 fail-open, fan-out fail-soft, per-activity retry, rate-limit-aware backoff.** **[L]**
(a) Wrap `ports.staticAnalysis` in a fail-open `stageOutcome` substituting an empty-valid result + a degradation note; make the curator fail-open on retryable `LlmInvocationError` + never re-raise `BedrockBudgetExceededError` (C1). (b) Make the chunk fan-out fail-soft (`raiseAfterLog:false` / isolation slot) so one chunk's failure contributes zero findings + a note, not a whole-review abort (C2). (c) Wire `runWithRetry` (zero prod callers today) into the retryable idempotent ports parameterized from `RETRY_POLICIES` (H1). (d) Plumb GitHub/Bedrock `Retry-After`/`resetAt` into `run_after` without burning an attempt (H3/RC6/XH2). (e) Carry per-workflow-type retry budgets across the cutover map (RC5). (f) Honor `PermanentSinkError` vs `RetryableSinkError` in the outbox drain (RC7); wrap permanent event-handler faults in `PermanentJobError` (T2).
*Closes:* **C1**, **C2**, **H1**, **H3**, **RC5**, **RC6**, **RC7**, **XH2**, **T2**, **M2** (classify/dedup/aggregate `stageOutcome` wraps).

**W0.11 — `validate-fast` fail-loud when security tiers are unexercised; port the four bug-class gates.** **[M]**
Fail (not skip) under `CI=1` when the Python oracle or DSN is missing; remove `passWithNoTests:true` from the default lane; `git submodule update --init`; print a skipped-test census. Port the four load-bearing gates mapping to real shipped incidents: JSON-safe-activity-input, LLM-output-coercion, workflow-silent-degradation, migration-safety (expand-contract + archive-before-DELETE).
*Closes:* **XC2**, **XH1** (four bug-class gates; remaining ~31 gates → Tier 5 / deferred register).

---

### TIER 1 — Review-QUALITY differentiator (the product's reason to exist)

*Eval + feedback + the retrieval rewrite + security corpora. This is what makes codemaster worth shipping over a SaaS tool.*

**W1.1 — Eval / golden-review harness (precision/recall/groundedness).** **[L]**
Curate 50–200 labeled real PRs (`test/corpora/review_quality/`) with expected findings + false-positive bait; a runner executing the real pipeline (cassettes/held-out model) computing precision/recall/F1 + groundedness (every finding cites a real `evidence_ref`). Nightly delta report first → pre-merge gate on prompt/model/chunker/suppression changes.
*Closes:* **XC8**, and makes **H13/Q1** regressions catchable.

**W1.2 — Vendor secret/PII/prompt-injection corpora into TS with self-contained threshold gates.** **[M]**
Vendor the corpora into `test/corpora/{secrets,pii,prompt_injection}/`; self-contained TS recall/precision gates at the mandated floors (injection ≥95%, secret ≥99%, PII ≥95%) with no Python dependency; structural gate asserting the dirs exist with ≥N fixtures. Keep parity as an additional byte-equality check.
*Closes:* **XC3**.

**W1.3 — Retrieval query rewrite: code-bearing query + similarity floor + real reranker + specificity.** **[L]**
Build the query from (PR title + description + chunk body + changed symbol names) / embed the diff-hunk text, keyed on a content hash not the path (RC4). Add a minimum cosine-similarity floor so irrelevant repos return fewer/zero chunks (RH10). Replace the `IdentityRerankPort` no-op with the real reranker (default on) or a deterministic cosine fallback (RH9). Implement the label-overlap `match_specificity_score` (RH8). Adopt the Qwen query-vs-passage instruction asymmetry + a single consistent query `purpose` (RL appendix embed-mode). Add an integration test asserting a security-relevant diff retrieves the security chunk above noise.
*Closes:* **RC4**, **RH8**, **RH9**, **RH10**, **EC2** (drive query-embed model from active generation), **RL3** (pgvector float bind), **RL5** (real token budget into floors), and the embed-mode item folded into RC4.

**W1.4 — Repo-doc knowledge corpus self-healing (coalesce-to-latest + reconcile backstop + retry + kill-switch).** **[L]**
Coalesce-to-latest on dedup conflict (carry/refresh head_sha — OC1). Retry/re-enqueue on embed degradation instead of settling `done`; gate the orphan sweep on full embed (OH3). Scheduled reconcile cron + extend `mark_stale_chunks` to `core.knowledge_chunks` (OH4) and make retrieval consume `page_status='active'` / stale-deprioritize (RH4). Add the refresh FF kill-switch/ramp + correct the false `_push_emitters` claim (OH1). Propagate `docs_cap_hit` + real `chunks_skipped_oversize` (OM2). Debounce window via `run_after` (OM1).
*Closes:* **OC1**, **OH1**, **OH3**, **OH4**, **RH4**, **OM1**, **OM2**.

**W1.5 — Close the feedback loop: prior_findings, carry-forward, learned suppression, implicit signal.** **[L]**
Wire `prior_findings` + the carry-forward selector to actual prior-review findings so re-pushes don't re-nag (XH9 — deterministic first slice). Build a feedback→learning derivation pipeline on a separate task queue: aggregate `feedback_events` per (installation_id, repo_id, finding signature) → `learning_proposals`; derive a per-repo suppression overlay merged over the bundled default; make `arbitration_rejections` a read source (XC7). Ingest implicit feedback (reactions, resolved threads, accepted-fix commits) with a richer verb taxonomy (XH10). Start narrow: suppression-of-dismissed before generative house-rules.
*Closes:* **XC7**, **XH9**, **XH10**.

**W1.6 — Per-chunk recall: continuation turns + forced tool_choice + cross-file producer + governance-doc truncation.** **[L]**
On `stop_reason='max_tokens'` emit a truncation counter + walkthrough note and issue a continuation turn (or raise the 2048 default to 4096–8192) so dense chunks don't silently lose findings past ~3 (H13). Thread `tool_choice:{type:'tool',name:'report_finding'}` so the model can't answer in prose (M16). Wire the symbol-graph producer so `consumer_hits`/`removed_or_changed_symbols`/`prior_findings` are populated and `context_breaks_consumer` findings can fire (H14). Truncate-and-parse oversized CLAUDE.md/ADR instead of skipping (H5). Code-fence awareness in the rule extractor (M8). Forced-rule token ceiling (M7).
*Closes:* **H13**, **M16**, **H14**, **H5**, **M8**, **M7**.

**W1.7 — Retrieval-quality observability + relevance correctness.** **[M]**
Persist a retrieval trace + three counters (retrieved-vs-below-threshold, rerank-changed-top-k, knowledge-citation-used rate). Keep knowledge_chunk citation validation in SKIP/observe mode when retrieval is degraded so a transient embed blip doesn't drop valid findings (RH11). Render repo_knowledge at `trust="semi"` not `trusted` (PR-influenceable bodies — RM14; matches Confluence; apply the inner `<doc trust="untrusted">` strip-and-rewrap). Configurable `top_k` routed through the budget enforcer (Q5). HNSW `iterative_scan` + tuned `ef_search` for small-tenant recall (XM4).
*Closes:* **RH11**, **RM14**, **Q5**, **XM4**, and the retrieval-metrics item folded from the RL appendix (DETECTION_PIPELINE_VERSION / quality-loop).

**W1.8 — Output-quality polish: confidence calibration/floor, proximity dedup, walkthrough prompt, suggestions, re-anchor.** **[M]**
Add calibration anchors + a configurable confidence floor (Q1). Line-proximity-aware dedup collapsing same-file overlapping findings incl. linter↔LLM cross-source (Q2). Dedicated walkthrough system prompt + compact per-file change manifest (Q3). Encourage concrete `suggestion` blocks (Q4). Re-anchor out-of-hunk findings to the nearest valid line before dropping to the collapsed section (XM7).
*Closes:* **Q1**, **Q2**, **Q3**, **Q4**, **XM7**.

---

### TIER 2 — Scale & cost (unblock 3000-repo throughput)

**W2.1 — Remove the global cost_daily row lock from the hot path.** **[M]**
Lock-free conditional `UPDATE ... WHERE daily_total + :est <= cap RETURNING` (or shard the counter K-ways / per-pod token bucket with DB reconciliation). Alert on cost-cap `lock_timeout` rate (SQLSTATE 55P03).
*Closes:* **XC4**.

**W2.2 — Anthropic prompt caching on chunk calls.** **[M]**
Order messages so the stable prefix (system prompt + tool schema + PR-topology manifest) comes first; set `cache_control:{type:'ephemeral'}` at the prefix end on each chunk call; plumb through `invokeModel` → SDK adapter; emit cache-hit-rate telemetry. Hoist PR-constant block assembly out of the per-chunk loop; default-enable a real token budget over char caps.
*Closes:* **XM1**, **XM6**.

**W2.3 — BACKPRESSURE limits (owner-mandated).** **[L]**
Enforce, with bounded counters: max jobs claimed per pod; max LLM reviews in-flight; max GitHub calls in-flight (token-bucket/circuit-breaker per installation); max clone disk usage; max workspace age; max retry-storm rate; **max jobs per installation/repo (anti-starvation)**. Tunable Worker/loop concurrency sized to the pod's DB-connection share + Bedrock/Qwen budget. Per-installation fairness in the review claim (use the unused `installation_id` column: round-robin / per-installation in-flight cap) and in the outbox drain. Decouple outbox ordering from concurrency (partition by `installation_id`/hash bucket so N drainers run without cross-key reordering) + give the dispatcher its own right-sized pool + a backlog gauge so a single serial drainer over the shared max=8 pool can't bound throughput at 3000-repo event volume.
*Closes:* **OWNER-BACKPRESSURE**, **H2**, **L1**, **XM5**, **XM2** (tunable fan-out + wall-clock partial-post budget), **RH15** (outbox drainer throughput / dedicated pool).

**W2.4 — Retrieval short-circuit + memoization.** **[M]**
Skip `embedQuery`+`retrieveKnowledge` when knowledge is disabled AND no Confluence labels apply; memoize `retrieveKnowledge` per unique `chunk.path`; cheap cached `knowledge_chunks` count → short-circuit empty repos; consider one PR-level retrieval pass over the union of changed paths.
*Closes:* **XH13**.

**W2.5 — End-to-end + per-stage latency histograms.** **[M]**
Emit `codemaster_review_end_to_end_ms` (chunk-count-bucketed) + `codemaster_review_stage_duration_ms{stage}` via the `stageOutcome` seam; p50/p95/p99 panels; alert on p99 approaching `REVIEW_TIMEOUT_SECONDS`. (Depends on W0.4.)
*Closes:* **XM3**.

**W2.6 — Static-analysis scale guards.** **[M]**
Cap per-runner argv file lists / batch / use argfile so large PRs don't E2BIG-lose ALL Tier-1 incl. gitleaks (M1). Scope gitleaks to the changed file set not the whole tree (M3). Bound subprocess stdout/stderr; emit the `oom` status on SIGKILL/cap breach (H15/M5). Set the Tier-1 soft barrier strictly < per-tool timeout (M4).
*Closes:* **M1**, **M3**, **H15**, **M5**, **M4**.

**W2.7 — Admin-read pagination + backfill throughput at scale.** **[M]**
Convert in-memory pagination + OFFSET + `COUNT(*) OVER ()` to keyset pushdown (EH9/EH10). Batch the embedder dual-write (multi-row INSERT/COPY) + batch embed requests with bounded retry, on an isolated pool/queue (EH5). Confluence per-space candidate aggregation via SQL not per-page full-corpus scan (RM13). HPA on queue-depth not CPU; split runner into its own Deployment; surface runner/pool/retention tunables in the chart (L17/L15).
*Closes:* **EH9**, **EH10**, **EH5**, **RM13**, **L17**, **L15**.

---

### TIER 3 — Self-healing / operability

**W3.1 — Operator dead-letter replay surface (all classes).** **[M]**
A `super_admin`/`platform_operator`-gated, audit-emitting surface to list/inspect/replay/clear: dead `review_jobs`/`background_jobs`, dead/stuck `outbox` rows, stranded `pr_review_mutex`, and blocked installations (`repository_repair_state`) — atomic reset to `ready` with cleared fence columns, archive-before-mutate. Add a `dead` outcome label to runner metrics.
*Closes:* **XC6**, **H8**, **EH8**, **RM5**, **RH14** (admin clear-blocked endpoint + the deferred `repository.repair_blocked` audit emit + alert).

**W3.2 — Idempotent review enqueue + the F6 delivery_id fix + at-least-once outbox hardening.** **[M]**
Make `review_jobs` enqueue idempotent on the dispatch identity (`ON CONFLICT DO NOTHING RETURNING` + re-SELECT; unique on `delivery_id`/`run_id`) — H9. **Thread `delivery_id` through `#enqueueReviewJob` (it currently omits `deliveryId:`, so the column is always NULL and `assertPayloadIdentityMatchesEnvelope`'s delivery_id cross-check is silently skipped); assert it is present** — RT3 (NEW). Per-dispatch timeout + capped lease-heartbeat so a hung sink can't pin a row forever (RM1/RM3); destination-side idempotency keyed on outbox row id / fold `markDispatched` into the destination txn where it's in-DB (RM2/H9-CaseB); right-size batch leases (RL appendix).
*Closes:* **H9**, **RT3 (NEW: F6 delivery_id drop)**, **RM1**, **RM2**, **RM3**.

**W3.3 — ONE SOURCE OF TRUTH for review state (owner-mandated): state-machine doc + invariant tests.** **[M]**
Author `docs/runbooks/review-state-machine.md` defining the legal states/transitions and these invariants, each backed by an integration test: done ⇒ terminal run; dead/cancelled ⇒ no live mutex; live job ⇒ `current_run_id` match; posted review ⇒ recoverable by marker or DB row; no two live jobs per review/run. Fix the underlying reaper/mutex gaps: release the mutex in lockstep with a reaped run (OH9), make the reaper shield Temporal-driven-run-aware (OH8), resolve the audit `installation_id` from the run's own tenancy not the repositories LEFT JOIN (RM8/OM8), cover the long-backoff RUNNING run (M11).
*Closes:* **OWNER-STATE-SSOT**, **OH8**, **OH9**, **OM8**, **RM8**, **M11**.

**W3.4 — EXTERNAL-BOUNDARY idempotency (non-LLM, owner-mandated): document + test each posture.** **[M]**
Document and test the replay/no-op/repair posture (no duplicate artifacts) for: check-run create/update (paginate the existence scan — XM9), review posting (force-push head-moved guard — XM8), PR-description update, fix-prompt comment, lifecycle finalization, Langfuse export, blob-archive writes. Each gets an idempotency test asserting a redrive produces no duplicate artifact.
*Closes:* **OWNER-EXT-IDEMPOTENCY**, **XM9**, **XM8**.

**W3.5 — Self-healing reapers, sweeps, and worker-heartbeat fixes.** **[M]**
Port the `worker_heartbeats` producer (or a fallback liveness signal) so the workspace orphan sweep actually fires; WARN metric until then (OH5). Reap the clone-cache (OH2). Dead-letter gauge/alert for stuck `FAILED_CLEANUP`/aged `ORPHANED` leases (OH6). Add LIMIT/batching + per-batch commit to the unbounded reaper sweeps (OM7). Bound the mutex-renew fail-open window → fail-closed on the pre-post claim-check after N consecutive failures (M10/RM6). Register the partman parents + pre-create partitions + assert `tables_processed>0` (OC2). Event-delete watermark + `batches_capped` metric; let partition-drop own bulk expiry (OM5).
*Closes:* **OH5**, **OH2**, **OH6**, **OM7**, **M10**, **RM6**, **OC2**, **OM5**, **L6** (partman seed).

**W3.6 — Ingestion / install-lifecycle self-healing.** **[M]**
Wire `maybeEnqueueRepair` on `installation_created` + raise reconcile attempts so out-of-order webhooks self-heal (H4/RH13). Add a periodic drift-reconcile cron walking active installations via `GET /installation/repositories` (RH12). Suspend/disable preflight in the dispatch path + a producer that supersedes/cancels active runs + pending jobs on suspend/delete/remove (I1). Land the deferred `repository.repair_blocked` audit + alert (RH14 — shares W3.1). Classify `CloneSizeCapExceeded` non-retryable + cheap GitHub `size` pre-check (OM3). Decouple the three `run_id_retention` sweeps + guard `emitCloseAudit` (OH7); LIMIT + fairness on close-stale-PR (OM10).
*Closes:* **H4**, **RH12**, **RH13**, **I1**, **OM3**, **OH7**, **OM10**.

**W3.7 — Vault / key-rotation / token-provider resilience.** **[M]**
Port the 30-min field-encryption key-refresh loop (EH4). Classify Vault 401/403 as retryable with token-file re-read (EH11). Make `activate()` atomic across both generation tables + add a reconciler (EH1); strengthen activate preconditions (EM1). Unify the two installation-token providers to one bounded server-time-freshness path (EM2/EM3); bound the negative cache (EL2). Distinguish vault-unavailable from corruption on audit-decrypt (EM6); fix the audit-events cursor microsecond skew (EM7).
*Closes:* **EH4**, **EH11**, **EH1**, **EM1**, **EM2**, **EM3**, **EL2**, **EM6**, **EM7**.

**W3.8 — Scheduler robustness + per-schedule isolation.** **[M]**
Per-schedule txn/savepoint so one poisoned UPDATE doesn't cascade-retick the whole batch (M13/RT4 NEW-confirm). Extend `computeNextRun` to the common cron subset (`*/N`, lists, ranges) or validate `cron_spec` at insert (M12). Cadence-lateness gauge/alert over `scheduled_jobs` (OM11). Validate scheduled-row `input` against the target `job_type`'s contract at enqueue (RM7). Higher `max_attempts`/backoff for long-cadence crons (RM11). WARN on missed-window drift; size partman premake ≥2 (OM6).
*Closes:* **M13**, **RT4 (scheduler per-schedule isolation)**, **M12**, **OM11**, **RM7**, **RM11**, **OM6**.

**W3.9 — SLOs, alert rules, per-alert runbooks; complete the review-timeline trail.** **[M]**
Author an SLO doc + PrometheusRule set (after W0.4), each alert linked to a `docs/runbooks/` detect/diagnose/remediate runbook using the W3.1 operator endpoints. Complete the review-timeline trail so "why did PR X get no review" is answerable in one request.
*Closes:* **XH12**.

**W3.10 — Split the combined pod; enable HPA; isolate self-healing loops.** **[L]**
Split into a webhook/API deployment and a review-worker deployment; isolate the self-healing/scheduler/outbox loops from the memory-heavy review worker; enable the HPA in production. Dispose ALL pools on SIGTERM (L11).
*Closes:* **XH8**, **L11**.

---

### TIER 4 — Correctness / contracts / payload-versioning / edge-cases

**W4.1 — STRICT PAYLOAD VERSIONING (owner-mandated): the job payload as an API contract.** **[M]**
Give the job payload (the Temporal-args replacement) API-contract discipline: additive-within-version, explicit version bumps, a documented cross-deploy compat window, and tests proving an older stored payload still parses/runs (load a vN-1 fixture row, assert it claims+runs). Back `schema_version` with a real DB column on `background_jobs`/`scheduled_jobs` (L8). Abort is boundary-only today — thread `AbortSignal` INTO the HTTP/embed/git-subprocess/clone clients + provider timeouts (RT5 NEW — the Qwen embed consumer takes no signal; provider calls have no per-call timeout race).
*Closes:* **OWNER-PAYLOAD-VERSIONING**, **L8**, **RT5 (abort threaded into clients)**, **L9** (dedup_key doc fix).

**W4.2 — Tenancy enforcement on the runner data plane.** **[M]**
Flip `check_tenant_scoped_raw_sql` to ERROR-mode for `runner/**` + the review pipeline (the tracked `FOLLOW-UP-gf3-error-mode`); add a payload-vs-row tenancy cross-check to `background_jobs` (analogue of `assertPayloadIdentityMatchesJobRow`) — RH2; thread `expectedInstallationId` through the webhook allocation path (L10); treat platform sentinels as privileged + reject request-derived sentinel ids (RL1); scrub secrets from `last_error`/`dead_reason` before persist (RH3).
*Closes:* **RH1**, **RH2**, **L10**, **RL1**, **RH3**.

**W4.3 — PR/diff edge-case correctness.** **[M]**
Per-file chunk isolation (one giant file can't fail the whole PR — XH3) + per-file byte cap + token hard-truncate backstop (XH4). GHE host config threaded through token mint / api_client / cloner (XH5). Draft-PR skip policy, configurable (XH6). Large-PR coverage notice instead of silent first-500 slice (XM10).
*Closes:* **XH3**, **XH4**, **XH5**, **XH6**, **XM10**.

**W4.4 — Config / malformed-input correctness.** **[M]**
`.codemaster.yaml` malformed → fail-open to defaults + a user-visible NOTICE (config_status field + WARN/OTel) — M6. Bound synchronous policy compute (worker_threads/yield) + rule-count + changed_paths caps so a big monorepo can't pin the loop past the heartbeat (H6/M9). Embedder vector-count-mismatch + per-text skip counter (RM9). Repair cooldown retain-row-on-success (RL appendix); installation suspend cascades `enabled=false` (RL appendix); listInstallationRepositories page cap + abort (RL appendix); dedup_key per-delivery for distinct in-flight reconcile events (RL appendix).
*Closes:* **M6**, **H6**, **M9**, **RM9**, and the four lifecycle RL-appendix items (cooldown DELETE-on-success, suspend-disable-repos, unbounded list pagination, dedup_key coalescing).

**W4.5 — Confluence ingest correctness & resilience.** **[L]**
Chunk the `confluence_ingest` fan-out into per-space/per-batch jobs under `maxRuntimeS` with checkpoint/resume; decouple reconcile from full-loop completion (RC2). Empty-live-set guard in `reconcileDeletions` (RC3). Per-page poison ceiling + quarantine + counter (RH6). Confluence 429/Retry-After client rate limiter (RH7). Per-cursor heartbeat/resume in `fetchSpacePages` (RM10). Separate priority lane for `trigger_page_resync` vs bulk ingest (RM12). `chunk_embeddings` cascade-delete on reconcile/stale + GC sweep (RH5). Confluence dual-write provenance fix (EH2); model/dim guard at retrieval (EH3). Per-space failure counter / settle-failed-when-all-fail (RL2). Lazy embedder-cache fail-with-backoff (RL4).
*Closes:* **RC2**, **RC3**, **RH6**, **RH7**, **RM10**, **RM12**, **RH5**, **EH2**, **EH3**, **RL2**, **RL4**.

**W4.6 — Index / retention / cost-accounting correctness.** **[M]**
Backport the split partial claim indexes + tie-break to `review_jobs` (L3). Retention janitor for `review_jobs` (L4) and `cache.cache_idempotency` (L5). Expand-contract the `posted_reviews` CHECK (L7). Cost-accounting: skip/zero replay-path telemetry double-count (M14), crash-safe store→reconcile reservation (M15), micro-cent cost tracking (L14). Heartbeat/orphan-handler error detail (L13). Route the retire sweep through the shared ADR-0062 pool (OM4). Port the `core.flags` reader so `sync_code_owners` can be enabled (OM9).
*Closes:* **L3**, **L4**, **L5**, **L7**, **M14**, **M15**, **L14**, **L13**, **OM4**, **OM9**.

**W4.7 — Admin-auth security & correctness.** **[M]**
Wire CSRF verification + `sameSite:strict` (EC4 — *if not already pulled into Tier 0; see do-this-first*). Wire concrete audit emission into auth+admin routes (EH7, after W0.7). Global Fastify error handler — stop leaking schema text (EH6). Filter `revoked_at IS NULL` in the role resolver (EM4). Move the login rate limiter to Postgres with a trusted client IP (EM5). Re-read the written LLM-provider slot (EL1).
*Closes:* **EH7**, **EH6**, **EM4**, **EM5**, **EL1** (EC4 listed here for grouping but **scheduled in Tier 0 do-this-first**).

---

### TIER 5 — Clean-code + Temporal teardown

**W5.1 — Temporal teardown (after the runner is wired + each workflow's parity gate passes).** **[L]**
Delete `review_skeleton.workflow.ts` now (zero callers). After cutover + parity gates: delete the 14 `*.workflow.ts`, the `worker/*` Temporal entrypoints, the temporal adapters/admin port, `all_workflows`/`activity_proxy`, the 17 `@temporalio` test files + deps + `TEMPORAL_*` env/ConfigMap/chart self-description. KEEP `build_activities.ts`, `orchestrate()`, `_supersede.ts`, activity bodies, contracts.
*Closes:* **(Temporal appendix delete-list)**.

**W5.2 — Unify the two parallel job-runner stacks.** **[M]**
Extract the shared lease/fence/heartbeat/claim/settle/reap SQL discipline into one parameterized core both repos compose; define `PayloadIntegrityError` once. Removes the lockstep-by-hand drift hazard.
*Closes:* **T1**.

**W5.3 — Remaining ~31 CI gates + test hygiene + load/soak.** **[L]**
Port the remaining unported gates with explicit follow-up stories (worker-registry-complete, configure-calls-complete, biconditional-checks, etc.). Serialize DB tests in `validate-fast` (`--no-file-parallelism` / per-worker schema) + add `flaky_quarantine` (XM11). Stryker mutation testing on the six safety modules (XM12). `@load`/`@soak` suite at 3000-repo scale (XM13). Migration-rollback runbook + per-repo quality tuning + calibration + cassette-staleness gate (XM14 remaining slices).
*Closes:* **XH1** (remaining ~31 gates), **XM11**, **XM12**, **XM13**, **XM14** (remaining slices).

---

## 3. DO-THIS-FIRST — the ≤10 gating blockers before the cutover can be flipped

These MUST land (and be verified green) before `CODEMASTER_RUNTIME_MODE=postgres` is flipped in any environment carrying real traffic. They are the intersection of "flipping today causes an outage / silent black-hole / unrecoverable data loss" and "no signal exists to even detect it."

1. **RT1 / C7 / C9 / RC8 / C8 — Runtime MODE exclusivity (W0.1).** Replace the additive boolean flags with `MODE=temporal|postgres|shadow`; in postgres mode do NOT boot the Temporal worker/outbox dispatcher. Closes the double-register crash-loop, the double-cron, and the missing Helm knob. *Without this the documented cutover action instantly crash-loops the production pod.*
2. **C6 / OC4 — Boot the review-jobs RunnerLoop + unified reaper; fail-loud if a sink has no consumer (W0.2).** *Without this the cutover enqueues every review into a table nothing drains — a silent black-hole with a green webhook 200.*
3. **OC3 — Wall-clock reaper, not idle-gated (W0.3).** *Without this one exhausted-lease row wedges every interval cron forever under steady load.*
4. **XC5 — Register a MeterProvider/exporter (W0.4).** *Without this all ~62 metrics emit to a black hole; no alert can fire on any failure the rest of this list introduces detection for.*
5. **C3 / C4 / H10 / H11 / H12 / RM4 — De-Temporal observability + structured logging (W0.5).** *Without this every degraded review is invisible — no stage metric, no log, no diagnosis.*
6. **C5 / H7 / XH11 / RT2 — Real readiness/liveness + loop-health → /readyz (W0.6).** *Without this a degraded pod (dead scheduler/outbox/runner loop, dead DB/Vault) stays Ready+Live and is never self-healed.*
7. **EC5 / RC1 — Load the key registry on worker/runner fail-loud + stop storing cleartext secrets (W0.7).** *Without this every self-healing audit-emit throws and re-wedges the ADR-0064 stuck-review class; and detected secrets sit in cleartext at rest.*
8. **XC1 — Postgres HA/DR or an explicit accept-the-SPOF decision (W0.8).** *The cutover concentrates ALL durable state onto an undefended single Postgres with no backup/PITR/replica; a disk/AZ loss is unbounded-RTO total data loss for 60 orgs.*
9. **XH7 / L16 / RT6 — DB-revision boot preflight + migration-0042 cold-only guard (W0.9).** *Without this a pod serves traffic against a drifted/un-migrated schema — the exact 2-week silent-drift class — and 0042 corrupts a non-cold table.*
10. **C1 / C2 / H1 / H3 / RC5 / RC6 / RC7 / RT3 — Fail-open core loop + per-activity retry + rate-limit backoff + idempotent enqueue with delivery_id (W0.10 + the W3.2 delivery_id/idempotency slice).** *Without this routine Bedrock throttling / a single-chunk blip / a Tier-1 cost-cap hit dead-letters reviews a single retry would have saved, and the non-idempotent enqueue double-posts on redelivery.*

> Note: **EC4 (CSRF) + EH7 (audit emission) + EM4 (revoked-role)** are P0-security in the edge audit. If the admin/auth surface is exposed in the same cutover, fold W4.7's EC4/EH7/EM4 into this do-this-first list (they gate exposing the privileged surface, not the review cutover per se).

---

## 4. Dedup ledger & completeness register

**Final deduped total: ~110 unique root issues across 41 waves** (from 173 raw audit IDs + 4 owner workstreams + 6 runtime findings). The reduction is from merging the same root across audits — examples:

- **Double sink-register crash:** C7 = RC8 (one root, W0.1).
- **Review-runner never booted / unified reaper dead:** C6 = OC4 (W0.2).
- **Cutover flags additive, no exclusivity:** C9 + C7 + C8 → RT1 (W0.1).
- **Observability-dark metrics:** C3 + H10 are *symptoms*; XC5 is the *root* — fixed together (W0.4 + W0.5).
- **Rate-limit Retry-After discarded:** H3 = RC6 = XH2 (W0.10).
- **Per-activity retry deleted:** H1 + RC5 (W0.10).
- **`maybeEnqueueRepair` unwired:** H4 = RH13 (W3.6).
- **Dead-letter no operator surface:** H8 = XC6 = EH8 = RM5 (W3.1).
- **Readiness reflects nothing:** C5 = XH11 = RT2 (W0.6).
- **Knowledge corpus drift cluster:** OC1/OH1/OH3/OH4/RH4/OM1/OM2 (W1.4).
- **Retrieval near-noise cluster:** RC4/RH8/RH9/RH10/EC2 (W1.3).
- **Combined-pod blast radius:** XH8 triggered by H15 (W3.10 + W2.6).

### Per-tier counts (unique waves)

| Tier | Waves | Theme |
|------|-------|-------|
| Tier 0 | 11 (W0.1–W0.11) | Stop-the-bleeding before cutover |
| Tier 1 | 8 (W1.1–W1.8) | Review-quality differentiator |
| Tier 2 | 7 (W2.1–W2.7) | Scale & cost |
| Tier 3 | 10 (W3.1–W3.10) | Self-healing / operability |
| Tier 4 | 7 (W4.1–W4.7) | Correctness / contracts / payload-versioning / edge-cases |
| Tier 5 | 3 (W5.1–W5.3) | Clean-code + Temporal teardown |
| **Total** | **46 waves** | |

### Genuinely-NEW runtime findings (not in the five audits)

- **RT1** — runtime MODE enum replacing the additive booleans (the *real* fix for the no-exclusivity criticals C7/C9/RC8; the audits propose per-symptom fixes, this is the structural root). → W0.1.
- **RT2** — loop-health wired into `/readyz` (audits flagged dead loops C5/H7/XH11 and the *isolate-and-continue* anti-pattern separately; pairing supervision WITH readiness is the synthesis). → W0.6.
- **RT3 (NEW)** — F6 review enqueue drops `delivery_id` (`#enqueueReviewJob` omits `deliveryId:`; verified the column is then always NULL and `assertPayloadIdentityMatchesEnvelope`'s delivery_id cross-check at line 75 is silently skipped). Related to but distinct from H9/RC8's idempotency framing. → W3.2.
- **RT4** — scheduler per-schedule isolation is only partial (one txn for all due schedules; a DB UPDATE failure poisons it) — overlaps M13 but the runtime review confirms the savepoint-per-schedule requirement. → W3.8.
- **RT5 (NEW)** — abort is boundary-only; `AbortSignal` is not threaded INTO the embed (Qwen consumer takes no signal) / provider clients, and provider calls have no per-call timeout race. Adjacent to H6 (sync policy compute) but a distinct client-plumbing gap. → W4.1.
- **RT6** — migration 0042 assumes a cold table (drops CHECK/index directly, creates indexes non-concurrently); verified the comment asserts cold-only but there is no preflight/cleanup guard. → W0.9.

### Owner-mandated workstreams placement

- **BACKPRESSURE** → W2.3 (Tier 2).
- **STRICT PAYLOAD VERSIONING** → W4.1 (Tier 4).
- **ONE SOURCE OF TRUTH FOR REVIEW STATE** → W3.3 (Tier 3).
- **EXTERNAL-BOUNDARY IDEMPOTENCY** → W3.4 (Tier 3).

### Explicit Low / Deferred register (nothing dropped)

Every Low-severity ID is assigned to a wave above:

- **L1** outbox per-tenant fairness → W2.3.
- **L2** GitHub 5xx backoff jitter → *Deferred-Low* (fold into W0.10 rate-limit work; tracked here so it isn't lost).
- **L3** review_jobs claim indexes → W4.6. **L4** review_jobs retention → W4.6. **L5** cache_idempotency prune → W4.6. **L6** partman seed → W3.5. **L7** posted_reviews CHECK expand-contract → W4.6. **L8** schema_version column → W4.1. **L9** dedup_key doc fix → W4.1. **L10** BF-9 allocation guard → W4.2. **L11** dispose all pools on SIGTERM → W3.10. **L12** trace correlation → W0.5. **L13** heartbeat error detail → W4.6. **L14** micro-cent cost → W4.6. **L15** runner/pool tunables in chart → W2.7. **L16** DB-INVARIANT preflight → W0.9. **L17** queue-depth HPA → W2.7.
- **EL1** LLM-provider slot re-read → W4.7. **EL2** negative-cache bound → W3.7.
- **RL1** sentinel UUIDs → W4.2. **RL2** Confluence per-space failure metric → W4.5. **RL3** pgvector float bind → W1.3. **RL4** lazy embedder-cache backoff → W4.5. **RL5** floor token budget → W1.3. RL-appendix lifecycle items (cooldown-DELETE-on-success, suspend-disable-repos, unbounded list pagination, dedup_key coalescing) → W4.4. RL-appendix embed-mode item → W1.3 (folded into RC4). RL-appendix retrieval-quality-loop item → W1.7.

*Every ID from all five audits — C/H/M/Q/L/I/T, OC/OH/OM, EC/EH/EM/EL, RC/RH/RM/RL, XC/XH/XM — now appears in a wave's Closes list or this register.*

---

*End of master plan. Waves are referenceable by ID (W<tier>.<n>); findings remain referenceable by their original audit ID.*
