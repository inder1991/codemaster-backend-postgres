# Cross-Cutting Characteristics Audit — codemaster (TS/Node backend)

**Date:** 2026-06-11
**Worktree:** `/Users/ascoe/Projects/.cmb-worktrees/de-temporal-runner-phase1`
**Branch:** `feat/de-temporal-runner-phase1`
**Reference:** `vendor/codemaster-py` (frozen Python source-of-truth)
**Scope:** Cross-cutting characteristics + edge-case classes NOT covered by the code-area audits:
testing/QA discipline, performance/scalability, PR/diff + GitHub edge cases, DR/HA/deploy safety,
operational readiness/observability, and the learning/eval/continuous-quality loop.

Companion audits: `2026-06-11-codemaster-hardening-audit.md`, `2026-06-11-edge-subsystems-audit.md`,
`2026-06-11-other-workflows-resilience-audit.md`. Where those audits flag a narrow symptom (e.g. H13
token-cap finding-drop, H15 subprocess OOM, C3 in-workflow metric gating), this audit identifies the
cross-cutting *root* that makes the narrow fix insufficient (e.g. no MeterProvider, no eval oracle).

---

## Executive Summary

The owner's bar is **resilient, scalable, highly-available, self-healing, and producing the
highest-quality PR reviews that beat market SaaS tools.** This audit finds that bar is currently
unmet along three structural axes, each of which has at least one critical, *systemic* gap:

1. **The platform cannot prove its own quality or improve over time.** The single dimension the
   product competes on — review quality — has **no measurement** (no eval/golden-review harness;
   precision/recall/groundedness never computed) and **no closed feedback loop** (`core.feedback_events`
   is write-only; `learnings` schema is vestigial; suppression is a frozen hand-edited YAML;
   `prior_findings` is hard-coded `[]`). Every prompt/model/chunker/retrieval change ships blind, and
   a finding a team dismisses 50 times is re-posted at full weight on push 51. **This is the
   SaaS-differentiator gap, and it is total.** (XC8, XC9, XH9, XH10)

2. **The platform runs blind and cannot self-heal what it cannot see.** **No `MeterProvider` /
   exporter is ever registered** — all ~62 OpenTelemetry instruments emit into a no-op Meter, so no
   alert can fire on any crashed loop, dead-letter spike, cost-cap breach, or quality regression
   (verified: zero `setGlobalMeterProvider`/`MeterProvider`/`PeriodicExportingMetricReader` call
   sites). There is **no operator escape hatch** to replay/clear any dead-letter class (dead jobs,
   dead outbox, stranded mutexes, blocked installations all require hand-edited SQL). Health probes
   are shallow (process-up only) and never reflect runner/scheduler/outbox loop liveness, so a
   degraded pod stays `Ready` and is never restarted. No SLOs, no alert rules, no incident runbooks.
   (XC5, XC6, XH11, XH12)

3. **The stateful core is an undefended single point of failure on the eve of its own
   de-risking removal.** Postgres is the *only* persistent store and the de-Temporal cutover moves
   *all* durable workflow/job/outbox/mutex state onto it — yet there is **no backup, no PITR, no
   replica, no failover, and no DR runbook** anywhere in the repo (the team has already lost a dev DB
   with `archive_mode=off`). There is **no boot-time DB-revision preflight** in the TS backend (the
   exact 2-week silent-drift class the owner directed be eliminated on the Python side), migrations
   are **up-only with no rollback**, and the combined single-pod design couples API + worker +
   outbox + every self-healing loop into one correlated failure domain. (XC1, XC7, XH7, XH8)

Two more cross-cutting gates compound the above:

- **`validate-fast` is green-by-default-while-blind.** With `passWithNoTests: true`, the
  un-checked-out `vendor/codemaster-py` submodule, and `describeDb`-gated integration tests, a
  `validate-fast` run in any environment lacking BOTH a Postgres DSN AND a working Python venv passes
  GREEN having exercised **only the unit tier** — silently skipping every DB-backed test, every
  security-corpus (redaction/secret/PII/output-safety/trust-tier) test, and the new runner
  self-healing tests. The "one rule that compounds" is structurally satisfiable while skipping the
  things it exists to protect. (XC2)

- **The primary trust boundary has no self-contained TS coverage, and ~35 of ~39 CI gates are
  unported.** The PR-diff prompt-injection / secret / PII corpora live only in the absent submodule;
  the migration-safety, JSON-safe-activity-input, LLM-output-coercion, and silent-degradation gates —
  each mapping to a *real shipped Python incident* — are entirely absent from `run_all.ts` (verified:
  4 gates wired). (XC3, XH1)

**Bottom line:** The pipeline *composes* and the port is *faithful* (excellent parity coverage), but
the system cannot (a) measure or improve its own review quality, (b) observe or alert on its own
health, or (c) survive or recover from the loss of its single stateful store. Those three must be
treated as first-class deliverables **before** the de-Temporal cutover concentrates even more risk
onto Postgres.

---

## Counts

| Severity | Count |
|----------|-------|
| Critical | 8 |
| High     | 13 |
| Medium   | 14 |
| **Total**| **35** (deduped from 56 raw findings) |

Dedup notes: the review-quality-eval gap appeared 3× across the testing and learning dimensions
(merged into **XC9**); the Postgres-DR gap appeared 2× (merged into **XC1**); the shallow-readiness
gap appeared 2× (merged into **XH11**); the no-eval-harness framing in the testing dimension is
folded into **XC9**.

---

## CRITICAL

### [XC1] No Postgres disaster-recovery story — the sole stateful store is an undefended SPOF
- **Dimension:** Disaster Recovery / High Availability
- **Location/Absence:** `deploy/` (no production Postgres chart); `deploy/local-kind/00-infra.yaml`
  (StatefulSet `replicas:1`, ephemeral); `docs/runbooks/` (no DR/backup/restore/RPO/RTO doc); repo-wide
  scan for `pitr|wal_level|archive_mode|pg_basebackup|standby|patroni|barman|backup` → only false
  positives. Prior incident: dev DB dropped with `archive_mode=off`, "data unrecoverable, no backup."
- **Problem + scenario:** Postgres is the only persistent store (reviews, configs, repos, findings,
  outbox, jobs, mutex, audit, LLM ledger) and the de-Temporal cutover moves *all* durable
  workflow/job/outbox/mutex state onto it, removing Temporal's durable history as a recovery aid. A
  node/AZ loss, disk failure, bad operator command, or corrupt migration on the Postgres host loses
  **all** platform state for 60+ orgs / ~3000 repos with no recovery point and unbounded RTO.
- **Impact:** Single largest data-loss + availability risk in the system; directly contradicts the
  "highly available / self-healing" goal. No RPO/RTO can even be reasoned about.
- **Fix:** Treat Postgres HA/DR as a deliverable **before** cutover: (1) streaming standby + automated
  failover (CloudNativePG or Patroni on OpenShift); (2) WAL archiving + continuous base backups
  (pgBackRest/wal-g to BlobStore) for PITR; (3) documented RPO/RTO + `docs/runbooks/postgres-disaster-recovery.md`
  with a restore procedure + cutover-specific recovery (rebuild outbox/job/mutex after restore);
  (4) quarterly restore drill. Until a replica exists, document Postgres as a known SPOF.

### [XC2] `validate-fast` passes GREEN with the entire integration + parity + security-corpus tiers silently skipped
- **Dimension:** Testing & QA Discipline
- **Location/Absence:** `vitest.config.ts:9` (`passWithNoTests: true`, verified); `test/integration/_db.ts:15`
  (`describeDb = INTEGRATION_DSN ? describe : describe.skip`); `package.json` (`validate-fast` = bare
  `vitest run`); `git submodule status` shows `vendor/codemaster-py` un-checked-out (dir empty).
- **Problem + scenario:** 135 of 144 integration files are `describeDb`-gated and skip when
  `CODEMASTER_PG_CORE_DSN` is unset. All 49 parity tests spawn `vendor/codemaster-py/.venv/bin/python`
  — absent in this worktree. Combined with `passWithNoTests: true`, a developer/CI lane lacking BOTH a
  disposable Postgres AND a Python venv gets a GREEN run that exercised **only the unit tier**. The
  skips are silent (no census printed). The CLAUDE.md "one rule that compounds" is satisfiable while
  skipping every DB-backed and security-redaction test.
- **Impact:** A regression in tenancy filtering, cost-cap, secret/PII redaction, output-safety, the
  de-Temporal runner loop, or any repo SQL ships undetected if the gating run lacked the DB or venv —
  and no human notices the coverage collapsed.
- **Fix:** (1) Fail-loud when security-critical tiers are unexercised under `CI=1` (assert Python
  oracle reachable + DSN set, *fail* not skip). (2) Remove `passWithNoTests: true` from the default
  config (scope only to an explicit no-DB lane). (3) Add `git submodule update --init` to bootstrap
  and a preflight that errors if `vendor/codemaster-py/.venv/bin/python` is missing. (4) Print a
  skipped-test census at the end of every run.

### [XC3] The PR-diff prompt-injection / secret / PII trust boundary has no self-contained TS coverage
- **Dimension:** Testing & QA Discipline (trust-boundary security)
- **Location/Absence:** `test/corpora/` (only `confluence_injection/` present, 30 fixtures);
  `test/parity/{redact_secret,redact_pii,output_safety,trust_tier_wrapping}.parity.test.ts` all consume
  `vendor/codemaster-py/tests/corpora/*` via a live Python subprocess (`run_redact_ref.py`).
- **Problem + scenario:** CLAUDE.md mandates corpora at `tests/corpora/{prompt_injection,secrets,pii}/`
  with CI floors (injection ≥95%, secret ≥99%, PII ≥95%). In the TS repo the only present corpus is
  `confluence_injection/`; the secret/PII/prompt-injection corpora are read from the *absent submodule*
  through oracle-only parity tests. With the submodule gone, `secret_detector.ts`, `pii_redactor.ts`,
  the output-safety validator, and the trust-tier wrapper have **zero executable adversarial coverage**.
  The PR-diff injection boundary — the system's primary `<diff trust="untrusted">` surface — has no
  corpus at all in TS.
- **Impact:** The 99%/95%/95% floors CLAUDE.md treats as CI gates are unenforceable. A regression that
  drops a secret/PII pattern or lets a PR-diff injection string into the LLM prompt ships undetected.
  Highest-leverage blind spot for a platform whose value is safe review of untrusted code.
- **Fix:** Vendor the secret/PII/prompt-injection corpora into `test/corpora/{secrets,pii,prompt_injection}/`
  (as was done for `confluence_injection`) and write self-contained TS recall/precision gates at the
  mandated thresholds with NO Python dependency. Keep parity as an *additional* byte-equality check.
  Add a structural gate asserting all three dirs exist with ≥N fixtures per class.

### [XC4] Fleet-wide cost-cap serialization: every paid LLM call takes `SELECT ... FOR UPDATE` on one global row
- **Dimension:** Performance / Scalability
- **Location:** `apps/backend/src/cost/postgres_enforcer.ts:255-263` (global `FOR UPDATE`), `:342+`
  (re-lock in `recordCallCost`), `:95` (`LOCK_TIMEOUT='2s'`); invoked from
  `integrations/llm/client.ts:540-568`.
- **Problem + scenario:** Every paid LLM invocation (each per-chunk Sonnet review, each Haiku rerank,
  the Opus walkthrough, the fix-prompt) locks the single `(today,'global')` row of
  `telemetry.cost_daily` twice (reserve + reconcile). That row is shared across the **entire platform**
  (60+ orgs / 3000 repos). Under fleet-scale fan-out (a monorepo push triggering 100-chunk fan-outs
  across several repos at once) every LLM call contends on ONE row lock. `lock_timeout=2s`; on
  contention the call gets one retry then fails **CLOSED** with `BedrockBudgetExceededError`, which is
  **non-retryable** for `reviewChunk` (`activity_ports.ts:262`) — so a hot-row lock storm doesn't just
  slow reviews, it makes chunk reviews permanently fail → degraded/empty reviews fleet-wide even when
  the daily budget is nowhere near exhausted.
- **Impact:** The single largest scalability ceiling. p99 LLM latency is gated by global-row lock-wait,
  not Bedrock. Useful LLM concurrency is capped at ~(lock-hold-time)⁻¹ calls/sec regardless of pod count.
- **Fix:** Remove the synchronous global lock from the hot path. In order of preference: (1) lock-free
  conditional `UPDATE ... SET daily_total = daily_total + :est WHERE daily_total + :est <= cap RETURNING`;
  (2) shard the counter into K sub-rows (`scope_id = hash % K`), sum on read; (3) in-memory per-pod
  token bucket with periodic DB reconciliation (bounded over-spend); (4) at minimum batch reserve+reconcile
  into one round-trip. Add a Grafana panel + alert on cost-cap `lock_timeout` rate (SQLSTATE 55P03).

### [XC5] No `MeterProvider`/exporter is ever registered — all ~62 metric instruments emit to a no-op Meter
- **Dimension:** Operational Readiness / Observability
- **Location/Absence:** `libs/platform/src/observability/metrics.ts:33` (`getMeter` returns no-op Meter
  with no provider); `apps/backend/src/main.ts` (boot wires no SDK/MeterProvider); `package.json:30-31`
  (`@opentelemetry/sdk-node` present but never imported in `src`); Helm chart (no `/metrics` route, no
  ServiceMonitor/PodMonitor). **Verified:** zero `setGlobalMeterProvider` / `MeterProvider` /
  `PeriodicExportingMetricReader` / `OTLPMetricExporter` call sites in `apps/backend/src` or `libs/`.
- **Problem + scenario:** ~62 instruments (`codemaster_runner_loop_crashed_total`,
  `*_crash_loop_reaped_total`, `*_background_no_handler_total`, cost-cap, finding-lifecycle, reconcile,
  …) emit through `getMeter`, which is documented as no-op until a provider is installed. No provider is
  ever constructed. Metrics are write-only into a black hole.
- **Impact:** Every self-healing and quality counter is silently discarded. On-call has zero
  metric-driven signal (crashed loop, wedged reaper, dead-letter spike, cost-cap breach, quality
  regression). No alert rule can fire — Prometheus has nothing to scrape. **This is the root cause that
  makes the other audits' "observability-dark" findings (e.g. C3 in-workflow gating) unfixable by their
  narrow fixes alone:** even with gating removed, the metrics still go nowhere.
- **Fix:** Construct a `MeterProvider` at boot (before `runServer`/boot tasks) with a
  `PeriodicExportingMetricReader` → `OTLPMetricExporter` (Grafana OTEL collector) or
  `@opentelemetry/exporter-prometheus` `/metrics` route; call `metrics.setGlobalMeterProvider()`. Add a
  ServiceMonitor to the chart. Add a boot assertion (and test) that a non-no-op provider is registered
  when `nodeEnv=production` so this cannot silently regress.

### [XC6] No operator surface to inspect/replay/clear ANY dead-letter class — recovery is hand-edited SQL
- **Dimension:** Self-Healing / Operator Escape Hatch
- **Location/Absence:** `apps/backend/src/api/admin/admin_routes.ts` (no `/jobs`, `/outbox`, `/mutex`,
  `/replay`, `/requeue`, `/retry`, `/cancel`, `/clear` routes — verified by grep);
  `runner/background_jobs_repo.ts:240-267` (`terminalSettle`/`reapStuckRuns` flip `state='dead'` with no
  read/replay API); `ingest/_repair_state.ts:11` (`markBlocked` sets `blocked_reason`; no clear endpoint).
- **Problem + scenario:** Once work dead-letters there is no human escape hatch. Dead
  `core.background_jobs`/`core.review_jobs` rows (no-handler, poison payload, attempts exhausted) have no
  list/inspect/replay endpoint; over-attempt `core.outbox` rows have no admin read/replay; stranded
  `core.pr_review_mutex` rows are only swept by the auto-janitor (no operator "release now");
  `cache.repository_repair_state.blocked_reason` (a terminally-blocked installation that has *permanently
  lost review coverage*) has no clear/unblock endpoint despite the code comment referencing one.
- **Impact:** When a review dead-letters at 3am or an installation is permanently blocked (every repo
  under it silently stops getting reviews), the operator's only recovery is `exec` into a pod and
  hand-edit Postgres — error-prone, unaudited, slow, and most on-call won't know the fence columns
  (`attempt_token`, `lease_owner`, `leased_until`). The system can auto-*detect* these failures but
  cannot let a human safely *fix* them — the opposite of self-healing.
- **Fix:** Add a `super_admin`/`platform_operator`-gated, audit-emitting operator surface: `GET` dead
  jobs/outbox rows with `dead_reason` + `last_error`; `POST .../replay` to atomically reset to `ready`
  with `attempts=0` + cleared fence columns; `POST .../mutex/:pr/release`; clear-blocked for
  `repository_repair_state` (port the Python `clear-repair-blocked-installation` runbook). At minimum,
  ship vetted operator scripts under `scripts/` per class so recovery is never raw SQL.

### [XC7] No closed feedback loop — reviews are stateless; feedback is captured but NEVER consumed
- **Dimension:** Learning / Continuous Quality (the SaaS differentiator)
- **Location/Absence:** `api/admin/finding_feedback_write.ts` (write-only). **Verified:** zero SELECT of
  `core.feedback_events` outside tests; zero `learning` references in `review/`, `retrieval/`, `llm/`.
  `learnings`/`learning_proposals`/`learnings_revisions` schema exists (`migrations/0001_baseline.sql:1454-1510`)
  with admin CRUD but no derivation job; `fired_count`/`accepted_count`/`feedback_count`/`last_fired_at`
  are never incremented.
- **Problem + scenario:** `submitFindingFeedback` INSERTs into `core.feedback_events` and that is the
  end of the data's life. No production code reads it; nothing derives `learning_proposals`; learnings
  are never injected into the review prompt or retrieval context; the lifecycle counters are read-only
  for an admin dashboard. The learnings loop is vestigial scaffolding. Reviews are computed from
  (current diff + static suppression + retrieved knowledge) with **zero memory** of accepted/rejected/wrong
  past findings.
- **Impact:** A finding dismissed 50 times is re-posted at full confidence on push 51, training 5000
  engineers to ignore the bot (alert fatigue → advisory noise). Market tools (CodeRabbit, Greptile,
  Graphite) get measurably better per-repo as teams react; codemaster structurally cannot. A massive
  proprietary feedback corpus accumulates as pure dead weight. The owner's "get better over time + beat
  SaaS" goal is **structurally unreachable** with the current architecture.
- **Fix:** Build a feedback→learning derivation pipeline on a separate task queue (invariant 1):
  (1) scheduled `DeriveLearningsWorkflow` aggregating `feedback_events` per (installation_id, repo_id,
  finding signature) → `learning_proposals` for repeatedly-dismissed classes (suppression candidates)
  and repeatedly-accepted patterns; (2) increment the lifecycle counters on every review + feedback
  event so accept-rate is a live signal; (3) inject active high-accept-rate learnings into review
  context (add a learnings source to `HybridRetriever`). **Start narrow: suppression-of-dismissed
  (deterministic, high-value, low-risk) before generative house-rules.**

### [XC8] No eval harness — review quality (precision/recall/groundedness) is never measured against a labeled corpus
- **Dimension:** Learning / Continuous Quality (quality measurement)
- **Location/Absence:** Absent capability. No files match `*eval*` (review-quality sense),
  `*precision*`, `*recall*`, `*groundedness*`, `*golden*`, `*ground-truth*` under `apps/backend/src`,
  `scripts/`, or `test/`. `test/corpora/` holds only injection adversarial cases. `test/gates/` has
  clock/random/tenancy/exempt gates only — none quality-related.
- **Problem + scenario:** There is no mechanism to *measure* whether a change improves or degrades
  review output. No labeled PRs-with-expected-findings corpus, no precision/recall/F1, no groundedness
  check, no quality CI gate. Every change to the system prompt (`llm/review_prompt.ts`), chunker,
  reranker, model selection (ADR-0060), or suppression policy ships on faith. The smoke proves the
  pipeline *composes*, not that the output is *good*. The hardening audit independently flags the
  2048-token cap silently drops findings (H13) and there's no confidence floor/calibration (Q1) — and
  **nothing would catch these as quality regressions because no quality oracle exists.**
- **Impact:** The "beats competitors" claim is unfalsifiable and unmonitorable. A prompt tweak or model
  swap that quietly halves recall passes every gate, every smoke, and ships. At 3000 repos a silent
  precision regression floods 5000 engineers with false positives before anyone notices anecdotally.
  No way to A/B a prompt, safely adopt a cheaper model, or fence the product's single most important
  output. **The #1 missing piece for a quality-differentiated product.**
- **Fix:** Build an offline eval harness: (1) curate a labeled golden corpus — 50–200 real PRs
  (languages/sizes/orgs) with human-labeled expected findings + known false-positive bait, in
  `test/corpora/review_quality/`; (2) a runner that executes the real pipeline against each PR
  (recorded cassettes or held-out model) and computes precision/recall/F1 + groundedness (every finding
  must cite a real `evidence_ref` — the invariant-15 machinery is the substrate); (3) wire it as a
  non-blocking nightly delta report first, then promote to a pre-merge gate on prompt/model/chunker/
  suppression changes with a regression threshold.

---

## HIGH

### [XH1] ~35 of ~39 CI gates unported; the migration-safety, JSON-safe-input, LLM-coercion, and silent-degradation gates are absent
- **Dimension:** Testing & QA Discipline
- **Location:** `scripts/gates/run_all.ts` (verified: runs only `tenantScopedRawSql`,
  `exemptedListsPointed`, `exemptedRotationAge`, `clockRandom`; comment: "remaining ~35 Python gates
  deferred").
- **Problem + scenario:** The structurally load-bearing gates are NOT among the four: `check_unsafe_migration_pattern`
  (expand-contract + archive-before-DELETE), `check_temporal_activity_input_json_safe` (the
  `dict[UUID,UUID]` crash class), `check_llm_output_parsers_use_coercion` (LLM-drift parser crash),
  `check_workflow_silent_degradation`, `check_migrations_use_biconditional_checks`,
  `check_worker_registry_complete`, `check_configure_calls_complete`. The de-Temporal phase introduces
  NEW dispatch surfaces (`workflow_job_map.ts`, background_jobs) exactly where the registry/configure/
  silent-degradation gates would catch wiring drift — and they're off.
- **Impact:** Each unported gate maps to a real shipped Python incident (smoke #10 UUID-key crash,
  smoke #7 LLM-drift parser crash, the `apply_arbitration` silent-swallow class). In TS those bug
  classes are ungated; a non-JSON-safe activity input, an uncoerced LLM parser, a swallowing `catch`,
  or a NOT-NULL migration on a hot table can merge with no gate firing.
- **Fix:** Prioritize the four bug-class gates mapping to known incidents (JSON-safe-input,
  LLM-coercion, silent-degradation, migration-safety). Track the remaining ~31 with explicit follow-up
  stories so deferral is visible, not silent.

### [XH2] GitHub rate-limit `Retry-After`/`reset_at` is parsed but never honored — tight retries deepen secondary-limit penalties
- **Dimension:** GitHub integration / rate limits
- **Location:** `integrations/github/api_client.ts:449-507` (`GitHubRateLimitExceeded` carries `resetAt`
  + `retryAfterSeconds`); `workflows/review_pull_request.workflow.ts:140-300` (GitHub-touching activity
  proxies use `{initialInterval:'2 seconds', maximumAttempts:2..5}`, no `maximumInterval`/
  `backoffCoefficient`, `GitHubRateLimitExceeded` absent from non-retryable types). Contrast
  `reconcile.workflow.ts:130-131` which *does* set `backoffCoefficient:2.0 + maximumInterval:300s`.
- **Problem + scenario:** The client correctly detects both rate-limit classes and carries the reset
  hints — but nothing consumes them. A primary reset can be up to an hour away; a secondary Retry-After
  is commonly 60+ s. The activity burns its 2–5 attempt budget in ~10s against a still-limited GitHub,
  then fails the review. Retrying into a *secondary* window (which GitHub imposes specifically to punish
  rapid retries) deepens the penalty for the whole installation.
- **Impact:** At 60+ orgs busy installations routinely hit limits; every PR touching a limited window
  fails its review within seconds, and tight retries amplify secondary-limit penalties platform-wide —
  a self-inflicted availability degradation that scales WITH load.
- **Fix:** Map `GitHubRateLimitExceeded` onto an `ApplicationFailure` with `nextRetryDelay =
  max(retryAfterSeconds, resetAt - now)`, OR add `backoffCoefficient:2.0 + maximumInterval` tuned to the
  reset window, OR gate the installation's GitHub calls behind a token-bucket/circuit-breaker keyed on
  `installation_id`. Raise `maximumAttempts` for reads so a long reset can be waited out. Never retry a
  secondary limit faster than its `Retry-After`.

### [XH3] One oversized file (>50k lines) throws `DiffTooLargeError` and fails the ENTIRE review — no per-file isolation in chunk_and_redact
- **Dimension:** PR/diff edge cases / huge files
- **Location:** `activities/chunk_and_redact.activity.ts:162-191` (loop, no try/catch around
  `chunker.chunk`); `chunking/treesitter_tsjs.ts:90-106` + `treesitter_python.ts:26` (`assertDiffSize`
  throws at `MAX_DIFF_LINES=50_000`). Contrast `classify_files.activity.ts` ("one bad file never poisons
  the rest").
- **Problem + scenario:** `classify_files` isolates per-file failures; the very next stage does NOT.
  A real PR adding one 60k-line generated SQL dump, large fixture, vendored bundle that slipped
  `is_generated`, or checked-in minified asset throws out of the whole activity — killing chunking for
  ALL files, so the entire review fails/degrades rather than skipping the one giant file. `is_generated`
  is best-effort and WILL miss novel shapes.
- **Impact:** One pathological file silently destroys review quality for the entire PR including all the
  normal reviewable files. A common real-world shape (data migrations, generated clients, snapshots).
- **Fix:** Wrap the per-file `chunker.chunk(...)` in a try/catch that, on `DiffTooLargeError` (and any
  throw), logs + skips THAT file and continues — mirroring `classify_files`' isolation contract.
  Optionally surface skipped-too-large files in the walkthrough.

### [XH4] No byte-size cap on a single file — a 10MB single-line minified/generated file produces an unsplittable, context-busting chunk
- **Dimension:** PR/diff edge cases / very long lines, generated files
- **Location:** `chunking/treesitter_tsjs.ts:90-106` (`assertDiffSize` counts NEWLINE BYTES only — no
  byte cap); `chunking/token_budget.ts:183-199` (`enforceTokenBudget` emits a single-line oversized
  chunk as-is: "Couldn't split further … emit as-is").
- **Problem + scenario:** The only large-file guard rejects at 50k *lines*. A minified JS/CSS bundle,
  generated single-line JSON/protobuf, or base64 blob is one enormous line of many MB with ~0 newlines —
  it sails past the line check, reaches `enforceTokenBudget`, which cannot split a single-line chunk, and
  emits the multi-MB chunk AS-IS far above `MAX_CHUNK_TOKENS=6000`. The LLM then rejects it
  (context-length error → failed review) or truncates it (garbage review). The only byte cap
  (`MAX_WORKSPACE_BYTES=200MiB`) is whole-workspace, not per-file.
- **Impact:** A single large minified/generated file escaping `is_generated` blows the context window,
  failing/corrupting the review; combined with XH3 it can take down the whole PR. Extremely common in
  frontend/monorepo PRs.
- **Fix:** Add a per-file BYTE cap in `assertDiffSize` (or before chunking) — skip/route any body over a
  few hundred KB — AND make `enforceTokenBudget` hard-truncate (with a marker) any chunk it cannot split
  below `MAX_CHUNK_TOKENS`. Both are needed: byte cap for worst case, token hard-truncate as backstop.

### [XH5] GitHub Enterprise is structurally unsupported — base URL, token mint, and clone URL hardcoded to github.com
- **Dimension:** GitHub integration / GHE vs github.com
- **Location:** `integrations/github/api_client.ts:51` (`DEFAULT_BASE_URL='https://api.github.com'`),
  `:386-390` (per-review wirings pass NO `baseUrl`); `integrations/github/token_provider.ts:66` +
  `fromEnv:249-272` (reads no base-url env); `integrations/git/cloner.ts:43` (`REPO_URL_RE` only matches
  `^https://github\.com/...`); `workflows/review_pull_request.workflow.ts:709` (builds
  `https://github.com/${owner}/${repo}.git`).
- **Problem + scenario:** CLAUDE.md invariant 4 says "both registrations supported." But github.com is
  hardcoded across four files: production review wirings never pass `baseUrl`, `fromEnv` reads no
  base-url env, the cloner regex hard-rejects non-github.com URLs, and the workflow literally constructs
  a github.com clone URL. No `CODEMASTER_GITHUB_API_BASE`/GHE-host env exists.
- **Impact:** Deploying against a GitHub Enterprise Server host — the realistic on-prem target behind
  Direct Connect — is impossible without changes across four files: every call hits public github.com,
  the clone is regex-rejected, and the token mint fails. The invariant claims GHE support; the code only
  supports github.com.
- **Fix:** Thread a single GitHub host config (`CODEMASTER_GITHUB_API_BASE` + GHE web host for clone
  URLs) from env → `token_provider.fromEnv`, every `api_client` wiring, and the cloner construction +
  host-parametrized regex. Known on-prem requirement, not speculative.

### [XH6] Draft PRs are fully reviewed on every push — only the prompt "tone" is softened
- **Dimension:** GitHub integration / draft PRs + re-review cost
- **Location:** `ingest/github_webhook_persistence.ts:95-101` (`OUTBOX_TRIGGER_ACTIONS` includes
  `opened`/`synchronize`, no draft filter); `review/walkthrough_activity.ts:123-124` (only draft
  handling: appends a "tone-down" line); `workflows/review_pull_request.workflow.ts:1088` (draft plumbed
  but never gates the pipeline).
- **Problem + scenario:** A draft opened then pushed 10× then marked ready runs ~12 full reviews
  (clone+classify+static+Tier-1+Tier-2 LLM+post) when 1 (at `ready_for_review`, already a trigger) would
  suffice. The only behavioral effect of the draft flag is one extra prompt line.
- **Impact:** Drafts are the highest-churn phase; reviewing every draft push burns Bedrock + GitHub
  quota for near-zero value, posts noise on incomplete work (training engineers to distrust the bot),
  and pressures the XH2 rate limits. A large fraction of total review spend. SaaS competitors let teams
  skip drafts.
- **Fix:** Make draft policy configurable (per-repo `.codemaster.yaml` / platform default); default to
  SKIP draft `synchronize` and review on `ready_for_review` (already a trigger). The draft flag is
  available at the ingest boundary so the filter is cheap.

### [XH7] No DB-revision preflight in the TS backend — the pod boots happily against a drifted/un-migrated schema
- **Dimension:** Deploy Safety
- **Location/Absence:** `libs/platform/src/db/database.ts` (no revision check); `apps/backend/src/main.ts:26-43`;
  `deploy/helm/codemaster-backend/templates/migrate-job.yaml` (Helm pre-upgrade hook only). Grep for
  `pgmigrations|verifySchema|assertSchema|expected.*head` → nothing.
- **Problem + scenario:** MEMORY records the DB-INVARIANT preflight (boot-time migration-revision +
  fingerprint, fail-loud) is live on the Python deploy after `alembic_version` drifted for ~2 weeks. It
  does NOT exist in TS. Migration safety relies solely on the Helm hook, which breaks on any bypass:
  `kubectl rollout restart`, pod reschedule after a manual DB alter, a hook-skipping install, an image
  rolled back to an older head, or the combined pod running an older image than the migrations applied.
- **Impact:** A pod serves traffic and runs the runner/outbox loops against a schema it wasn't built for
  — the exact 2-week silent-drift class the owner directed be eliminated. Symptoms are runtime SQL
  errors deep in the review path, not a loud fail-at-boot.
- **Fix:** Port the preflight to TS boot (before binding HTTP and before runner loops): read the applied
  head from `pgmigrations`, assert it equals the image's compiled-in expected head (+ optional
  fingerprint); `process.exit(1)` on mismatch so Kubernetes crash-loops a drifted pod. Pairs with the
  fail-loud philosophy already in `main.ts`.

### [XH8] Single combined pod is a correlated failure domain — one OOM/crash takes down API + worker + outbox + ALL self-healing loops
- **Dimension:** High Availability / Blast Radius
- **Location:** `apps/backend/src/main.ts:26-48` (one process: API + 2 workers, `Promise.all`);
  `deploy/helm/codemaster-backend/values.yaml:90-96` (2Gi limit); `boot_tasks.ts:70-78` (runner loops
  join the SAME process post-cutover).
- **Problem + scenario:** API + review worker + outbox-dispatcher run in ONE process, and the cutover
  ADDS the runner + scheduler + outbox-drain loops to it. `main.ts` is fail-loud: ANY task rejection
  exits the whole process. The review worker does heavy in-process work (tree-sitter WASM, LLM buffers,
  subprocess linter output) under 2Gi. A V8 OOM or one uncaught rejection kills EVERYTHING co-located:
  in-flight reviews, ingestion, the outbox drainer, the scheduler, and the reaper/janitor loops. The
  hardening audit's H15 (unbounded subprocess stdout OOMs the worker) is a concrete trigger.
- **Impact:** At `replicaCount:2` a single noisy PR can OOM-kill a pod, halving capacity AND silently
  stopping that pod's self-healing loops until restart. HPA disabled by default → no automatic capacity
  recovery. Couples failures that invariant 1 wants isolated.
- **Fix:** Split into at least a webhook/API deployment and a review-worker deployment (the split the
  Python intentionally collapsed); at minimum isolate the self-healing/scheduler/outbox loops from the
  memory-heavy review worker. Bound subprocess output (H15), enforce per-review memory ceilings, enable
  the HPA in production.

### [XH9] Suppression is a static hand-maintained YAML, not learned from dismissals — the platform re-flags rejected findings forever
- **Dimension:** Learning / Continuous Quality
- **Location:** `review/arbitration/suppression_policy.ts:100-138` (`BUNDLED_SUPPRESSION_POLICY` literal;
  comment: "Per-tenant overrides are NOT supported by design"); `core.arbitration_rejections` write-only
  (zero SELECT in production); `select_carry_forward.activity.ts:40-42` (historical consultation
  DEFERRED); `orchestrator.ts:1087` (`prior_findings: []` hard-coded → the prompt's "do not repeat"
  block, `prompt_builder.ts:838-844`, is dead code fed an empty list).
- **Problem + scenario:** The only suppression is a frozen global per-tool/rule confidence table,
  identical for every repo/org, with no path from a dismissed finding to future suppression. `prior_findings: []`
  means a re-push re-reviews from scratch with no de-duplication, producing duplicate inline comments
  across pushes.
- **Impact:** A team that dismisses a finding sees it re-posted on every push forever at full weight —
  the exact alert-fatigue failure that makes engineers mute the bot. Competitors' headline feature
  ("learns your codebase / stops nagging") is structurally impossible here. Compounds the H13/H14
  recall+noise findings.
- **Fix (highest-leverage, lowest-risk first slice of XC7):** (1) deterministic short-term — wire the
  carry-forward selector and `prior_findings` to actual prior-review findings (schema + prompt block
  already exist) so re-pushes don't re-nag; (2) learned long-term — derive a per-repo suppression
  overlay from `feedback_events` (dismissed N times → repo-scoped suppression) merged over the bundled
  default; (3) make `arbitration_rejections` a read source for tuning the global policy.

### [XH10] Feedback signal is admin-console-only thumbs — the platform ignores the implicit signal that actually scales to 5000 engineers
- **Dimension:** Learning / Continuous Quality
- **Location:** `api/admin/finding_feedback_write.ts:46` (verb ∈ helpful/not_helpful/wrong, admin route
  only); ingest handlers — grep `reaction` across `apps/backend/src` → empty; no
  `pull_request_review_comment` / reaction event handling.
- **Problem + scenario:** The sole capture requires a human to leave GitHub, open the admin UI, find the
  finding, and rate it — virtually no developer does this at 3000-repo scale. Meanwhile GitHub's
  free high-volume implicit signals are uncaptured: 👍/👎 reactions on the bot's comments, resolved/
  minimized threads, "false positive" replies, and follow-up commits that fix the flagged line.
  Even explicit feedback is coarse: "wrong" collapses into the same `thumbs_down` kind as "not_helpful".
- **Impact:** The collectable corpus is a thin, operator-biased trickle, not the broad signal from 5000
  engineers. Any future learning loop built on `feedback_events` alone is data-starved and skewed. The
  single most reliable ground truth — "did the developer fix the line we flagged" — is invisible.
- **Fix:** Ingest implicit feedback as first-class events: subscribe to `pull_request_review_comment`
  (edited/deleted/resolved), reaction webhooks on the bot's comments, and correlate subsequent commits
  touching the flagged line range (accepted-fix signal); write into `feedback_events` with a richer
  verb taxonomy (accepted-fix / dismissed / reacted-negative / edited), tagging implicit confidence
  lower than explicit.

### [XH11] readyz/healthz are shallow and never reflect runner/scheduler/outbox/worker loop liveness — a degraded pod stays Ready
- **Dimension:** Health / Readiness Probes / Zero-Downtime Deploy
- **Location:** `api/app.ts:54-91` (readyz returns `ready:true` when no deps declared; healthz returns
  postgres+vault snapshot but HTTP 200 regardless of status); `api/server.ts:25-104` (`buildApp()` called
  with NO `postgresCheck`/`dependencyChecks`); `values.yaml:120-144` + `deployment.yaml:147-174`
  (liveness+startup=/healthz, readiness=/readyz, `maxUnavailable:0`, `minReadySeconds:20`,
  PDB `minAvailable:1`).
- **Problem + scenario:** `/readyz` is pure process-up; `/healthz` never sets non-200 on "down". The
  combined pod runs API + workers + (post-cutover) runner/scheduler/outbox-drain loops, but NO probe
  observes any loop. The supervisor logs a crashed loop leaves the pod "DEGRADED until restarted"
  (`background_runner_main.ts:411`) — yet nothing restarts it because liveness stays green. The
  `maxUnavailable:0`/`minReadySeconds:20`/PDB design promises invisible rolling deploys, but the
  readiness gate proves nothing about Postgres/Vault/worker-connected, so the guarantee is hollow.
- **Impact:** A pod whose scheduler/outbox/worker loop crashed (or whose Postgres pool is exhausted)
  keeps passing liveness+readiness, keeps receiving webhook traffic, advances the rollout under
  `maxUnavailable:0`, and is never self-healed — crons stop, outbox stops draining, reviews silently
  stop being enqueued while everything shows healthy.
- **Fix:** Pass a `postgresCheck` (SELECT 1 on the pool), a Vault check, and a loop-liveness check
  (per-loop last-tick heartbeat) into `buildApp` from `server.ts`. Make liveness fail when a critical
  loop stops ticking so the kubelet restarts the pod. Flip a shared "degraded" flag the supervisor sets
  so `/readyz` sheds traffic. Set `/healthz` non-200 when postgres/vault are down.

### [XH12] No SLO definitions, no alerting rules, no per-alert runbooks — nothing pages on-call and nothing to follow when paged
- **Dimension:** Alerting / SLO / On-call
- **Location/Absence:** `docs/` (no SLO/alerting/PrometheusRule docs); `docs/runbooks/` contains only 2
  cutover-procedural files; Helm chart (no PrometheusRule/Alertmanager resources). The
  `/api/admin/review-timeline` trail hard-codes workflow status + GitHub postings as Day-1 shims
  (`admin_routes.ts:2834-2838`), so the run_id→webhook→outbox→bedrock→github chain is structurally
  incomplete.
- **Problem + scenario:** No SLOs (review-latency p95, success rate, webhook-to-enqueue, queue-depth
  ceilings), no PrometheusRule/Alertmanager config, no alert→runbook mapping. CLAUDE.md's "pre-defined,
  monitored, action-codified scale triggers" have no operational alerting authored for TS. When the
  system breaks at 3am nothing pages, and even if noticed, no runbook says how to diagnose/remediate.
- **Impact:** Combined with XC5 (no-op metrics), the platform has no functioning detection layer at all.
  The incomplete review-timeline means the canonical "why did PR X get no review" question can't be
  answered end-to-end from the product — operators fall back to ad-hoc SQL across several tables.
- **Fix:** Author an SLO doc + a PrometheusRule set (after XC5), each alert linked to a per-alert runbook
  under `docs/runbooks/` with detect/diagnose/remediate steps using the XC6 operator endpoints. Complete
  the review-timeline trail so "why did PR X get no review" is answerable in one operator request.

### [XH13] Per-chunk knowledge retrieval (embed + BM25 + ANN + Confluence + RRF) runs unconditionally — no early-out for repos with no indexed knowledge
- **Dimension:** Performance / Scalability
- **Location:** `review/pipeline/orchestrator.ts:929-1045` (`buildChunkContext` fires `embedQuery` +
  `retrieveKnowledge` per chunk), `:603-633` (fan-out over up to 100 chunks); `activities/retrieve_knowledge.activity.ts:96`
  (`enabled` gates only the LLM rerank, not the retrieve).
- **Problem + scenario:** `buildChunkContext` dispatches a full hybrid retrieval (BM25 + ANN + optional
  Confluence + RRF) for EVERY chunk. `embedQuery` is cached per path but `retrieveKnowledge` is NOT
  deduped per path, so two chunks of the same file each issue a full retrieval. There is no gate to skip
  retrieval when `repo_config.knowledge.enabled` is false or the corpus is empty — a brand-new repo with
  zero indexed chunks still pays N embed RPCs to Qwen + N hybrid retrievals (each 3+ DB queries).
- **Impact:** A 30–50 chunk PR issues 30–50 redundant retrieval activities. At 3000 repos — most with
  little/no indexed knowledge — the overwhelming majority of retrieval work returns empty yet consumes
  embedder quota, scarce DB connections (per the kind pg-budget memory), and critical-path latency.
- **Fix:** (1) Skip `embedQuery` + `retrieveKnowledge` when knowledge is disabled AND no Confluence
  labels apply; (2) memoize `retrieveKnowledge` per unique `chunk.path`; (3) cheap cached count of
  `knowledge_chunks` for the repo → short-circuit empty; (4) consider one PR-level retrieval pass keyed
  on the union of changed paths.

---

## MEDIUM

### [XM1] No prompt caching on any LLM call — the large identical system prompt + tool schema + PR-topology manifest is re-sent and re-billed per chunk
- **Dimension:** Performance / Cost
- **Location:** `integrations/llm/client.ts:593-605` (no `cache_control`); `bedrock_sdk_adapter.ts:304-305`
  (system/tools passed plain); system prompt `llm/review_prompt.ts:86-148`; tool schema
  `review/tool_schema.ts`. **Verified:** zero `cache_control`/`ephemeral` in `integrations/llm`.
- **Problem + scenario:** For an N-chunk PR the per-chunk Sonnet call re-sends, fully un-cached, the
  ~150-line `REVIEW_SYSTEM_PROMPT`, the full tool schema, AND the PR-topology manifest (≤3000 tokens) —
  all byte-identical across every chunk. Only the chunk body + per-chunk knowledge differ. Bedrock
  supports Anthropic prompt caching; this is the textbook caching shape.
- **Impact:** The stable prefix (2k–5k tokens) is billed N times at full price instead of once +
  (N-1) cache reads (~10%). On a 40-chunk PR roughly 1.5–3× input-token inflation; input dominates
  review cost (completions capped at 2048). Across 3000 repos a large continuous avoidable Bedrock bill,
  plus first-token latency.
- **Fix:** Order the message so the stable prefix comes first; set `cache_control:{type:'ephemeral'}` at
  the end of that prefix on each chunk call. Plumb the option through `LlmClient.invokeModel` → the SDK
  adapter. Emit cache-hit-rate telemetry. Expect 50–70% input-token reduction on multi-chunk PRs.

### [XM2] Chunk-review fan-out concurrency hardcoded to 4 — large PRs serialize into ~25 LLM rounds against a 30-minute hard deadline
- **Dimension:** Performance / Latency
- **Location:** `workflows/review_pull_request.workflow.ts:734` (`chunkConcurrency: CHUNK_CONCURRENCY_DEFAULT`);
  `review/pipeline/parallelism.ts:45` (`=4`); `orchestrator.ts:320` (`MAX_CHUNKS_PER_REVIEW=100`);
  `ingest/github_webhook_persistence.ts:93` (`REVIEW_TIMEOUT_SECONDS=1800`).
- **Problem + scenario:** `fanOutReview` runs at most 4 concurrently; no per-installation override is
  wired despite the comment claiming one. 100 chunks / 4 lanes = 25 sequential rounds; each round is a
  `reviewChunk` (90s) preceded by `embedQuery` (15s) + `retrieveKnowledge` (20s). 25 rounds can approach
  or exceed the 1800s execution timeout.
- **Impact:** Large PRs (where quality matters most) are slowest and most likely to time out; hitting
  1800s kills the workflow and loses the review entirely rather than degrading. Fixed concurrency means
  no per-org latency/throughput trade-off.
- **Fix:** Make `chunkConcurrency` configurable and raise the default (8–12 is safe for an I/O-bound LLM
  fan-out). Add a global wall-clock budget inside the orchestrator: stop dispatching new rounds and post
  a partial "reviewed X of Y chunks" review near ~1500s. Tie the knob to the XC4 cost-cap fix.

### [XM3] No end-to-end review-latency or per-stage duration metric — performance is structurally unobservable
- **Dimension:** Performance / Observability
- **Location/Absence:** `apps/backend/src/observability/` (no review-timing metric); histograms exist only
  at `runner/runner_metrics.ts:84` (handler_duration, the in-process runner path) and `api/auth/metrics.ts`.
- **Problem + scenario:** No histogram for "webhook received → review posted" and no per-stage duration
  (clone, classify, static-analysis, fan-out, aggregate, walkthrough, post). The stage-outcome contract
  records outcome but not duration. You cannot answer "p99 time-to-first-review?", "which stage
  dominates?", or "did retrieve regress?" from metrics.
- **Impact:** For a product whose bar is "fast review on every PR", the core SLO is unmeasured.
  Regressions in any stage are invisible until users complain; the scale-trigger discipline can't apply
  to latency. (Note: blocked by XC5 — even if emitted, metrics go nowhere until a MeterProvider exists.)
- **Fix:** Emit `codemaster_review_end_to_end_ms` (keyed by chunk-count bucket) and
  `codemaster_review_stage_duration_ms{stage}` (the `stageOutcome` helper is the natural seam). Add
  p50/p95/p99 panels + a chunk-count-vs-latency view; alert on p99 approaching `REVIEW_TIMEOUT_SECONDS`.

### [XM4] pgvector ANN/Confluence searches post-filter on tenant with default ef_search and no iterative-scan — recall degrades for small tenants in a large shared corpus
- **Dimension:** Performance / Retrieval Quality
- **Location:** `retrieval/ann_port.ts:159-167` (WHERE installation_id+repository_id ORDER BY vector
  LIMIT); HNSW indexes `migrations/0001_baseline.sql:5141`,`:4917` (m=16, ef_construction=64); no
  `SET hnsw.ef_search` / `hnsw.iterative_scan` anywhere.
- **Problem + scenario:** Classic filtered-vector-search: the HNSW traversal isn't tenant-aware, walks
  the global graph collecting `ef_search=40` (never tuned) candidates, then applies the tenant filter.
  For a small/new tenant in a large shared corpus the top neighbors contain few/zero of its rows, so the
  LIMIT under-fills (recall loss) and/or the executor over-scans. pgvector's `iterative_scan` (0.8+) is
  the supported mitigation and is off.
- **Impact:** Retrieval quality silently drops for small/new repos (weaker reviews — opposite of the
  goal) AND latency rises as the executor over-scans, once per chunk (compounds XH13).
- **Fix:** `SET LOCAL hnsw.iterative_scan = 'relaxed_order'` + per-query `hnsw.ef_search` ~2–4×
  `PRE_FUSION_TOP_K` inside the retrieval transaction. Validate recall on a small-tenant corpus.
  Consider partial HNSW indexes or partitioning by `installation_id`. Add a rows-returned-vs-requested
  metric so under-fill is observable.

### [XM5] Temporal worker created with no concurrency/rate-limit tuning — SDK defaults govern how many LLM/DB activities one pod runs
- **Dimension:** Performance / Back-pressure
- **Location:** `worker/main.ts:79-93` (`Worker.create` with no `maxConcurrentActivityTaskExecutions`,
  `maxConcurrentWorkflowTaskExecutions`, `maxActivitiesPerSecond`, or `maxTaskQueueActivitiesPerSecond`).
- **Problem + scenario:** SDK default activity concurrency is high (100s), so one pod can run a very
  large number of `reviewChunk` LLM, `retrieveKnowledge` DB, and `embedQuery` activities at once. No
  per-pod ceiling ties activity concurrency to the real downstream caps (Bedrock TPM/RPM, Qwen capacity,
  Postgres connection budget already at ~89/100). The per-PR fan-out is capped at 4 but nothing caps the
  SUM across the many PRs a pod processes concurrently.
- **Impact:** Under load a pod oversubscribes Bedrock (429 → retries with 5s→60s backoff → spikes/
  timeouts), Postgres (`TooManyConnectionsError` crashloop), and the embedder. No back-pressure aligned
  to actual bottlenecks — failures manifest as retries/timeouts/crashloops, not smooth queueing.
- **Fix:** Set explicit Worker options sized to the pod's DB-connection share + embedder/Bedrock budget
  (`maxConcurrentActivityTaskExecutions`, `maxTaskQueueActivitiesPerSecond`/`maxActivitiesPerSecond`,
  `maxConcurrentWorkflowTaskExecutions`), driven from env per environment.

### [XM6] Per-chunk user-message context budgets sum to a large, mostly PR-constant prompt rebuilt and re-billed per chunk (~30k+ char ceiling)
- **Dimension:** Performance / Cost
- **Location:** `review/prompt_builder.ts:86-95` (MAX_PATH_INSTRUCTIONS_CHARS=5000,
  MAX_KNOWLEDGE_CHARS=12000, MAX_CONSUMERS_CHARS=12000), `:95` (MAX_EVIDENCE_MANIFEST_TOKENS=1500),
  `:419` (MAX_MANIFEST_BLOCK_TOKENS=3000); `buildUserMessage:817-879` assembles all blocks per chunk.
- **Problem + scenario:** `buildUserMessage` recomputes PR-level constants (title/description, topology
  manifest, path instructions, policy blocks) for every chunk. With the un-cached system prompt (XM1) a
  single chunk request approaches ~30k+ chars, mostly repeated across N calls. The token-budget
  subsystem is opt-in (`CODEMASTER_PROMPT_BUDGET_ENFORCEMENT`), so by default these are char-cap
  truncations, not a managed token budget.
- **Impact:** Directly inflates input-token cost ×N and prompt-build CPU. Noisy retrieval (XH13) fills
  the 12000-char knowledge block with marginal chunks that cost tokens AND dilute attention (hurting
  quality).
- **Fix:** Place PR-constant blocks in the cached prefix (XM1); hoist PR-level assembly out of the
  per-chunk loop; default-enable a real token budget over independent char caps; emit per-block token
  telemetry; tighten MAX_KNOWLEDGE_CHARS/top_k once relevance improves (XM4).

### [XM7] Out-of-hunk inline findings are dropped rather than re-anchored — correct findings on context lines silently disappear
- **Dimension:** GitHub integration / inline-comment positioning + review quality
- **Location:** `activities/post_review_results.activity.ts:282-365` (`classifyFindingsAgainstDiff`
  STRICT_CONTAINMENT — kept only if a hunk satisfies `lo<=start && end<=hi`, else dropped), `:1100-1111`
  (dropped findings → collapsed "Additional findings detected" walkthrough section).
- **Problem + scenario:** The 422 out-of-window problem IS handled (pre-drop avoids GitHub 422s, good),
  but the remedy DROPS the finding to a collapsed list with no attempt to RE-ANCHOR to the nearest
  in-hunk line (which GitHub would accept). A bug whose root cause is one context line outside the edit,
  or a multi-hunk span, is demoted from a visible inline comment to a hidden bullet.
- **Impact:** The most valuable findings (correctness/security just outside the literal hunk) are
  systematically demoted to where reviewers rarely look, capping perceived value and handing an
  advantage to SaaS tools that re-anchor. The drop is invisible (WARN + metric only), so the quality
  loss is unmeasured (compounds XC8).
- **Fix:** Before dropping, attempt to re-anchor to the nearest valid in-hunk line in the same file
  (clamp `end_line` into the closest hunk; note the original line in the body); fall back to the
  collapsed section only when no plausible anchor exists. Track re-anchor-vs-drop rates in the eval.

### [XM8] No force-push / head-moved guard before posting — a review against a superseded head_sha can post against the wrong diff window
- **Dimension:** GitHub integration / force-push mid-review
- **Location:** `workflows/review_pull_request.workflow.ts` (head_sha fixed at workflow start, threaded
  unchanged); `integrations/github/review_client.ts:265-312` (`createReview` posts `commit_id=headSha`
  without verifying it's still the PR head); `post_review_results.activity.ts` (atomic claim keyed on
  pr_id, not head_sha).
- **Problem + scenario:** If the author force-pushes mid-review, the new `synchronize` supersedes via the
  SERIAL+SUPERSEDE allocator but the in-flight run isn't guaranteed to be cancelled before it posts. On
  post, `createReview` uses the stale `commit_id`; inline comments may 422 (handled → body-only), but
  walkthrough/findings reflect a diff window that no longer matches the current head. No "is head_sha
  still the PR head?" check exists at the post boundary.
- **Impact:** After a force-push the posted review can describe lines that no longer exist or miss new
  changes, and inline comments degrade to body-only. The per-PR claim prevents double-post but CAN post a
  stale review. Force-push-during-review is routine for active PRs.
- **Fix:** At the post boundary, re-fetch the PR's current head_sha and compare to the run's; if moved,
  abort the post as superseded (let the newer run own it). Wire the stale-head check into the existing
  SERIAL+SUPERSEDE publication gate. Lower-effort: surface a "reviewed at <sha>, head is now <sha>" note.

### [XM9] check-run existence scan reads only the first page (per_page=30) — an idempotent re-run can create a DUPLICATE check-run
- **Dimension:** GitHub integration / check-run create-vs-update
- **Location:** `integrations/github/check_run_client.ts:18-24,126-149` (`findExistingCheckRun` reads
  only page 1, unlike `findExistingReviewByMarker` which was upgraded to paginate in W3.2).
- **Problem + scenario:** On a commit in a CI-heavy repo (many providers / matrix builds) the codemaster
  check-run can be pushed past page 1; the existence scan misses it and `createCheckRun` makes a SECOND
  `codemaster/review` check-run. The code comment acknowledges this is unhandled.
- **Impact:** Duplicate `codemaster/review` check-runs — confusing UI, and on retry/replay the activity
  keeps creating new ones instead of updating. Lower blast radius than the (fixed) review-comment
  duplicate, same bug class on a surface left un-paginated.
- **Fix:** Use GitHub's server-side `?check_name=codemaster/review` filter, OR paginate the check-runs
  scan the way `findExistingReviewByMarker` now does.

### [XM10] PR-files fetch capped at 3000/500 with no diff-stats pre-check — huge PRs reviewed against a truncated, arbitrary file set
- **Dimension:** PR/diff edge cases / huge PRs (1000+ files)
- **Location:** `integrations/github/api_client.ts:570-599` (`getPullRequestFiles` maxFiles 3000);
  `activities/enrich_pr_files.activity.ts:80` (`MAX_FILES_PER_ENRICHMENT=500`), `:171-179` (silently
  slices to first 500, sets `truncated_at`); workflow only emits a WARN log.
- **Problem + scenario:** A 1000+-file PR is handled by stacked caps: fetch ≤3000, keep only the FIRST
  500 (GitHub's order, not relevance-ranked), mark `truncated_at`. The entire downstream review is
  computed over an arbitrary first-500 slice. The only signal is a server-side WARN — nothing in the
  posted review/check-run tells the author 60% of their PR was not looked at.
- **Impact:** On large refactors/migrations the bot silently reviews an unrepresentative subset and posts
  findings as if complete — a correctness-of-coverage lie. Reviewers may trust a "looks clean" outcome
  that only examined the first 500 files.
- **Fix:** Read `changed_files`/`additions`/`deletions` from `getPullRequest` up front; over a threshold,
  post an explicit user-visible "reviewed first M of N files — large-PR mode" notice instead of only a
  WARN. Rank kept files by review value (code over generated, security-relevant first) before truncating.

### [XM11] Integration tests share one :5434 DB and `validate-fast` runs them WITH file-parallelism — cross-test row pollution
- **Dimension:** Testing & QA Discipline
- **Location:** `package.json` (`validate-fast` = `vitest run`, default parallel; only `test:integration`
  adds `--no-file-parallelism`); `test/integration/auth/local_user_repo.integration.test.ts:46`
  (`DELETE FROM core.local_users`); shared-table census: `core.installations` deleted by ~61 sites,
  `repositories` ~43, `review_runs` ~34, `pull_request_reviews` ~32.
- **Problem + scenario:** All DB tests target one :5434 Postgres with per-file `DELETE FROM`/`beforeEach`
  isolation — no per-test schema, no transactional rollback, no advisory-lock serialization. The gating
  path doesn't pass `--no-file-parallelism`, so with a DSN present these run across worker threads in
  parallel; a `DELETE FROM core.installations` in file A can wipe rows file B just inserted (FK cascades
  widen the blast radius). `sequence.shuffle:true` amplifies nondeterminism.
- **Impact:** Flaky failures and — worse — flaky PASSES (a real regression masked by another file's
  INSERT). The textbook flaky class CLAUDE.md's quarantine rule exists to prevent; there's no
  `flaky_quarantine` file in the TS repo at all.
- **Fix:** Route integration through `--no-file-parallelism` in `validate-fast`, or give each worker its
  own schema/database. Prefer transaction-per-test rollback over `DELETE FROM`. Add a `flaky_quarantine`
  mechanism (linked issue, never silent-retry).

### [XM12] No mutation testing on any critical module — CLAUDE.md mandates nightly mutation on tenancy/redaction/output-safety/authz/model-router/cost-cap
- **Dimension:** Testing & QA Discipline
- **Location/Absence:** `package.json` (no Stryker/mutation dep or script); repo-wide search → nothing.
- **Problem + scenario:** The six safety-critical modules are guarded only by example-based tests (and
  for redaction/output-safety/trust-tier, only by oracle-dependent parity tests that can't run without
  the submodule). Example tests prove assertions pass; they don't prove they'd FAIL if the logic were
  subtly broken — a weakened redaction regex, a no-op tenancy filter on a path, or a cost-cap off-by-one
  can pass while a mutant survives.
- **Impact:** Mutation score is the only signal that these modules' tests actually constrain behavior,
  and it's absent. For a system whose security posture rests on redaction/tenancy/output-safety, a real
  gap.
- **Fix:** Add Stryker scoped to the six modules, nightly with a mutation-score floor (start at measured,
  ratchet up). Surface surviving mutants in the nightly report.

### [XM13] No load/soak/capacity testing at 3000-repo scale — the only end-to-end proof is a single-PR smoke
- **Dimension:** Scalability / Capacity
- **Location/Absence:** `scripts/live_cluster_smoke.sh:170-180` (one `gh pr create`, busy-wait);
  `test/smoke/` (one registry smoke); `test/` (no `@load`/`@soak`/`@stress`/`@chaos` suites); `values.yaml`
  (HPA disabled, default pool max 8/DSN/pod).
- **Problem + scenario:** No test drives N concurrent reviews; no measurement of per-review pool-connection
  demand against the ~100-connection budget (already ~89/100 steady-state, no rolling-deploy headroom);
  no Bedrock/GitHub rate-limit-at-scale test; no soak for the lease/heartbeat/reaper loops under sustained
  queue depth. Behavior at the stated scale (60+ orgs, 3000 repos, 5000 engineers) is unknown.
- **Impact:** Connection-pool exhaustion (the ADR-0062 class already hit), claim head-of-line blocking,
  rate-limit storms, and reaper/heartbeat contention could all surface first in production. "Beats SaaS"
  is unprovable without a capacity baseline.
- **Fix:** Add a `@load` suite driving K concurrent reviews against a seeded multi-org dataset, measuring
  p50/p99 latency, peak DB connections/pod, claim-to-start latency, Bedrock throttle rate; a `@soak` for
  the runner/scheduler/outbox/reaper loops over hours; codify quantified scale triggers into alerts;
  validate HPA + pool-max against measured per-review demand. (Blocked on XC5 for metric-driven gating.)

### [XM14] No review-quality calibration / migration-rollback / DR-adjacent operational gaps (grouped tail)
- **Dimension:** Cross-cutting tail (calibration, deploy rollback, per-repo tuning, structured logs)
- **This entry bundles five lower-severity-but-real gaps surfaced across dimensions:**
  - **Finding-quality calibration absent** (`llm/review_prompt.ts` confidence; hardening Q1): confidence
    is an uncalibrated LLM output consumed only for ranking/dedup, never validated against accept-rates,
    never a precision gate. *Fix (after XC7/XC8):* per-confidence-bucket and per-severity accept-rates →
    reliability diagram + ECE; add calibration anchors to the prompt; add an eval-validated confidence
    floor via `.codemaster.yaml`.
  - **Migrations up-only, no rollback** (`package.json` `migrate:down` disabled; `migrate-job.yaml`
    backoffLimit:3): a bad/partial migration or an image rollback has no automated recovery; "recreate a
    throwaway DB" is impossible for production. *Fix:* expand-contract + archive-before-DELETE discipline,
    a `migration-rollback.md` forward-fix runbook (+ PITR fallback once XC1 lands), require every migration
    backward-compatible with the previously-deployed image, consider Argo Rollouts canary.
  - **No per-org/per-repo quality tuning from history** (`learnings.repo_id` never populated): every repo
    runs generic defaults; manual YAML doesn't scale to 3000 repos. *Fix (after XC7):* derive a repo-scoped
    accept-rate to scale the suppression overlay + confidence floor, merged UNDER explicit `.codemaster.yaml`.
  - **Unstructured `console.*` logs, Fastify logger disabled, discard StageLogger** (`api/app.ts:51`
    `logger:false`; `review_job_shell.ts:291` `StageLogger.warning` = `void msg`): no run_id/trace
    correlation; per-stage degradation warnings discarded at the source. *Fix:* pino with
    run_id/delivery_id/installation_id/trace_id bound per review + request; enable Fastify request logging;
    replace the discard StageLogger with one that emits structured WARN + the stage-outcome metric.
  - **Cassette staleness discipline documented but unwired** (`test/cassettes/README.md` promises
    `.meta.yaml` + 60/90-day gate; 0 `.meta.yaml` exist, no gate, no record script): a silently-rotting
    Bedrock/GitHub recording hides the exact upstream shape-drift the replay strategy exists to catch.
    *Fix:* generate `.meta.yaml` with `recorded_at`, add a >90-day CI-fail gate + record scripts, or
    rewrite the README to the actual policy.
- **Impact (aggregate):** Each erodes either quality measurability, deploy safety, or diagnosability;
  individually medium, collectively they are the connective tissue between the critical gaps.

---

## Prioritized Implementation Order

The ordering front-loads the items that (a) prevent silent data loss / silent quality collapse and
(b) unblock other fixes. Several criticals are *enablers* — e.g. XC5 must land before any metric-driven
alert (XM3, XH12) can work, and XC7+XC8 must land before calibration/per-repo tuning (XM14) are possible.

**Tier 0 — Stop-the-bleeding before the de-Temporal cutover (data loss + blind operation):**
1. **XC1** Postgres HA/DR (standby + PITR + restore drill + runbook) — *gates the cutover.*
2. **XC5** Register a `MeterProvider`/exporter — *unblocks all alerting (XM3, XH12, XM14 cost/budget).*
3. **XH7** TS DB-revision boot preflight (fail-loud) — *closes the silent-drift class the owner directed.*
4. **XC2** Make `validate-fast` fail-loud when security tiers are unexercised; checkout submodule.

**Tier 1 — Quality differentiator + safety net (the product's reason to exist):**
5. **XC8** Eval/golden-review harness (precision/recall/groundedness, nightly → pre-merge gate).
6. **XC3** Vendor secret/PII/prompt-injection corpora into TS with self-contained threshold gates.
7. **XH9** Wire `prior_findings` + carry-forward (deterministic re-push de-nag) — *first slice of XC7.*
8. **XC7** Feedback→learning derivation pipeline (start: suppression-of-dismissed).
9. **XH10** Ingest implicit feedback (reactions, resolved threads, accepted-fix commits).

**Tier 2 — Scalability + cost ceilings (unblock 3000-repo scale):**
10. **XC4** Remove the global cost_daily row lock from the hot path (lock-free conditional UPDATE).
11. **XM1** Anthropic prompt caching on chunk calls (50–70% input-token reduction).
12. **XH13** + **XM6** Short-circuit/memoize per-chunk retrieval; hoist PR-constant prompt assembly.
13. **XM2** + **XM5** Tunable fan-out concurrency + Worker back-pressure aligned to Bedrock/DB caps.
14. **XM3** End-to-end + per-stage latency histograms (depends on XC5).

**Tier 3 — Resilience / self-healing / operability:**
15. **XC6** Operator escape hatch (replay/clear dead jobs/outbox/mutex/blocked-installation).
16. **XH11** Deep readiness/liveness reflecting loop health.
17. **XH8** Split combined pod; isolate self-healing loops; enable HPA.
18. **XH12** SLOs + PrometheusRules + per-alert runbooks; complete review-timeline trail.
19. **XH2** Honor GitHub `Retry-After`/`reset_at`; circuit-breaker per installation.

**Tier 4 — Correctness/coverage edge cases + remaining gates + tail:**
20. **XH3** + **XH4** Per-file chunk isolation + per-file byte cap + token hard-truncate.
21. **XH5** GHE host config threaded through token mint / api_client / cloner.
22. **XH6** Draft-PR skip policy.
23. **XH1** Port the four bug-class gates (JSON-safe-input, LLM-coercion, silent-degradation, migration-safety).
24. **XM7** Re-anchor out-of-hunk findings; **XM8** force-push head-moved guard; **XM9** paginate check-run scan;
    **XM10** large-PR coverage notice.
25. **XM11** Serialize DB tests in `validate-fast` + flaky_quarantine; **XM12** mutation testing;
    **XM13** load/soak suite; **XM14** calibration / migration-rollback / per-repo tuning / structured logs /
    cassette staleness.

---

## Cross-References to Companion Audits

- **XC5** (no MeterProvider) is the *root* that makes the other audits' "observability-dark" findings
  (in particular the in-workflow metric-gating C3) unfixable by their narrow fixes alone.
- **XC8** (no eval harness) is why the hardening audit's H13 (token-cap finding-drop) and Q1 (no
  confidence floor) cannot be caught as quality regressions.
- **XH8** (combined-pod blast radius) is triggered concretely by the hardening audit's H15 (unbounded
  subprocess stdout OOM).
- **XH9/XC7** (no feedback loop) compound the hardening audit's H14/H13 recall+noise findings via the
  dead `prior_findings: []`.
