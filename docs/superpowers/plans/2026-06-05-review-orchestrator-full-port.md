# Review Orchestrator — Full TS Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan stage-by-stage. Each activity/helper is a 1:1 port — the frozen Python at `vendor/codemaster-py/` is the parity oracle. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port the codemaster review orchestrator (`review_pull_request.py` 4171 LoC + `review_pipeline_orchestrator.py` 1010 LoC) to a TypeScript Temporal workflow, staged so a minimal happy-path **spine runs live end-to-end** (Temporal dev + Postgres + Ollama) as early as possible, with operational layers stacking on after — culminating in a behaviourally 1:1 production pipeline.

**Architecture:** A small Temporal `@workflow` entry delegates to a deterministic `orchestrate()` helper that drives typed activity ports over a typed workflow-local state object. The 4171-line Python body is decomposed into 8 focused modules (workflow / orchestrator / gates / state / activity_ports / degradation / posting / lifecycle). All 25 `workflow.patched` gates **collapse to their current-prod branch** (new workflow type → zero Python histories → `patched()` is unconditionally true), so the gate machinery becomes straight-line code.

**Tech Stack:** Temporal TS SDK (`@temporalio/workflow` + `@temporalio/worker`), Zod contracts (`libs/contracts/`), Kysely (Postgres), the ledger-wired `LlmClientCache` (ADR-0068), Ollama-backed Bedrock-shaped LLM, Vitest + Temporal `TestWorkflowEnvironment`.

**Research basis:** Two parallel analysis workflows (2026-06-05): the orchestrator stage maps (`review_pull_request.py` 43-activity sequence + `review_pipeline_orchestrator.py` 17-stage helper), the TS-port gap inventory (132 items: 88 ported / 44 missing), and the gate ledger (all 25 gates collapse; 6 coupled groups). This plan reconciles all three plus the project-owner's 10 design findings (2026-06-05).

---

## 1. Architectural decisions (binding)

These override naive line-by-line transliteration. Each cites the owner finding / analysis it derives from.

1. **Module decomposition (finding 1).** Do NOT recreate the 4171-line body. New code:
   - `apps/backend/src/workflows/review_pull_request.workflow.ts` — Temporal `@workflow` **entry only** (in the workflow bundle; webpack-bundled into the sandbox; `worker/main.ts` `workflowsPath` points here; replaces `review_skeleton.workflow.ts`).
   - `apps/backend/src/review/pipeline/orchestrator.ts` — the deterministic `orchestrate()` helper (port of `orchestrate_review_pipeline`).
   - `apps/backend/src/review/pipeline/gates.ts` — the collapsed-gate **ledger** (documentation constant; see §6).
   - `.../pipeline/state.ts` — `ReviewWorkflowState` (typed replacement for the mutable closure boxes).
   - `.../pipeline/activity_ports.ts` — typed `proxyActivities` stubs + the retry-policy constants (one typed envelope per activity).
   - `.../pipeline/degradation.ts` — `stageOutcome()` + `DegradationCollector` + `STAGE_NAMES`.
   - `.../pipeline/posting.ts` — the extracted post-review sub-functions (finding 8).
   - `.../pipeline/lifecycle.ts` — run-state + delivery bookkeeping (ANALYSIS_STARTED/ANALYZED/finalize/skipped/degraded/failed/cancelled).
   - All of `review/pipeline/*` runs **in the workflow sandbox** (no `node:crypto`, no DB, no clock/uuid — see decision 7). Activity *implementations* live under `apps/backend/src/activities/` + `review/`.

2. **Typed `ReviewPipelineContext` (finding 2).** The ~35-kwarg `orchestrate_review_pipeline` signature becomes ONE typed parameter object (§6). No positional/callback explosion.

3. **Gate collapse (finding 3 + gate ledger).** The TS workflow is a **new Temporal workflow type with zero Python histories**, so `workflow.patched()` is unconditionally true → **every one of the 25 gates collapses to its current-prod (true) branch**; the `patched()`/`deprecate_patch()` calls and all legacy/false branches are **dead code and MUST NOT be ported**. `gates.ts` is a documented ledger, not runtime branching. TS introduces its *own* `patched()` only when IT later needs an in-flight migration. **Coupled groups port atomically (§3).**

4. **Typed `ReviewWorkflowState` (finding 4).** The mutable closure boxes (`policy_bundles`, `repo_config_box`, `query_vector_cache`, `inline_post_filter_metadata`, `posted_review_capture`, `arbitration_capture`, `_persisted_review_finding_ids`) become one typed state object with explicit, testable transitions (§6).

5. **LLM idempotency — DONE (finding 5).** The narrow ledger (ADR-0068) shipped (`d82297c`/`2e5e4eb`) and is wired into the production `LlmClientCache` client factory (`6ea5836`). Key = `installation_id + chunk_id + role + model + prompt_sha256 + tool_schema_version`; persist-first then telemetry/cost/Langfuse as replayable side-effects; check-first ordering. **Open refinement at orchestrator-wiring:** consider folding `workflow_id`/`run_id` into the key now that the orchestrator exposes them (the chunk_id is already PR-stable, so this is belt-and-suspenders).

6. **Mutex + workspace lifecycle are spine-adjacent, not deferrable past stage 2 (finding 6).** acquire-before-work → renew-mid-run → **claim-check before clone, aggregate, persist, post** → release-in-finally; workspace released in finally; **cancellation releases owned resources**. Until stage 2 lands, stage-1 live runs go to the **disposable Postgres (localhost:5434), never the cluster** (memory: isolated-test-DB) so leaked run-state/mutex rows can't pollute shared state.

7. **All crypto/uuid/hash/clock/DB work stays in ACTIVITIES (ADR-0065 / `check_workflow_bundle.ts`).** The workflow bundle bans `node:crypto`. `build_retrieved_evidence` (mints `ev_` ids), redaction, DB writes, `uuid`/`Date.now` must execute in activities. Contracts pulled into the workflow bundle must be **type-only** imports where they transitively touch crypto. The orchestrator/state/posting/lifecycle modules must pass `npm run` build with `check_workflow_bundle.ts` green.

8. **Degradation-notes-before-post bug FIX (finding 7 — deliberate divergence).** Python folds orchestrator degradation notes into the result *after* the orchestrator already posted (`review_pull_request.py:3485`). In TS, **compose degradation notes before `postReview`** so the GitHub review/check-run reflects the true degraded state. Documented as an intentional TS hardening divergence (ADR — new, `0069`).

9. **Single typed activity envelopes (finding 9) — half-done.** All 15 already-ported activities are 1-arg (arity-verified in `6ea5836`). `activity_ports.ts` gives every activity a typed input envelope + retry policy; the orchestrator calls `ports.reviewChunk({...})`, never positional `args=[...]`. New activities follow the 1-arg rule (gate already enforces).

10. **Retrieval guards (finding 10).** In `orchestrator.ts`: cache query embeddings by stable chunk-path key (`state.queryVectorCache`), validate embedding dimension before the pgvector query, fail-open-with-explicit-degradation on `embed_query`/`retrieve_knowledge` failure, thread the degradation reason into the chunk prompt context (`ReviewContextV1.retrieval_degraded` + `retrieval_degradation_reason`).

---

## 2. Gap summary (what to build)

**88 ported / 44 missing / 0 partial.** Already ported & live: the worker bootstrap, `data_converter`, `buildActivities()` (15 real activities), and essentially every spine contract (`ClonedRepoV1`, `FileRoutingV1`, `DiffChunkV1`, `ReviewContextV1`, `ReviewChunkResponseV1`, `AggregatedFindingsV1`, `WalkthroughV1`, `PostedReviewV1`+`PublicationOutcome`, `CitationValidationResultV1`, `CarryForwardSelectionV1`, `StaticAnalysisResultV1`, the lifecycle `*InputV1`s).

**The 44 missing, grouped:**

- **Orchestration layer (workflow sandbox):** `orchestrate_review_pipeline`, `fan_out_review`, `_coerce_chunk_result`, `dedup_linter_with_llm`, `stage_outcome` + `STAGE_NAMES` + `record_stage`, `ReviewPipelineResult`, and the pure helpers (`_infer_pr_topology_kind`, `_path_filters_excluded_all_finding`, `_config_change_notice_finding`, `_compose_orchestrator_degradation_note`, `_resolve_degraded_payload`, `_build_analyzed_payload`, `_stage_outcome_for_publication`, `_fix_prompt_stage_outcome`).
- **3 orchestrator-required activities (no skip branch — stage 1 MUST build):** `select_carry_forward` (trivial pure line-range overlap), `static_analysis_activity` (stage 1: valid-but-empty `StaticAnalysisResultV1`; real Ruff/ESLint in stage 4), `generate_walkthrough` (real Opus call).
- **Walkthrough persist:** `persist_review_walkthrough_activity` (contract+repo exist; body only).
- **Gate/mutex/webhook (stage 2):** `start_review_for_webhook_activity`, `renew_pr_review_mutex_lease_activity`, `release_pr_review_mutex_activity`, `post_review_placeholder_activity`, `delete_review_placeholder_activity` + their inputs; `ReviewPullRequestResultV1`.
- **Lifecycle bookkeeping (stage 3):** `record_review_lifecycle_event_activity`, `finalize_review_run_activity`, `record_run_failed_activity`, `record_run_cancelled_activity`, `record_delivery_{finalized,skipped,degraded}_activity`, `record_tool_runs_activity`, `emit_output_safety_audit_event_activity`, `citation_validate_activity` + inputs.
- **Enrichment/manifest/context (stage 4):** `enrich_pr_files_activity(_v2)`, `fetch_manifest_snapshots_activity`, `parse_manifest_dependencies_activity`, `fetch_linked_issues_activity`, `fetch_suggested_reviewers_activity`, `update_pr_description_summary`, `build_retrieved_evidence`.
- **Arbitration/fix-prompt (stage 5):** `apply_arbitration_activity` + `ApplyArbitrationInput` + `ArbitrationResult`, `generate_fix_prompt_activity`.

> NOTE: `PublicationOutcome` is **already ported** (`posted_review.v1.ts:30`) — the gap agent mis-flagged it. `ReviewPipelineResult` and the lifecycle input contracts mostly exist; verify each at port time.

---

## 3. Coupled-gate groups (atomic port units)

From the gate ledger — collapsing one without its partners breaks dataflow/quality (not replay, since TS has no history). Port each group as ONE unit:

| Group | Markers (collapsed-on) | Why atomic |
|---|---|---|
| **config+policy+persist** | repo-config-wiring, policy-engine-wiring, persist-input-v2, policy-post-filter-relocated | Nested in source; `repo_config_box` shared; persist v2 takes the policy bundle as 6th arg; post-filter-relocated bypasses the persist-side re-filter (R-23). Port as: typed `PersistReviewFindingsInputV1` + policy-bundle arg + inline pre-persist post-filter + `path_filters` narrowing. |
| **Phase-B static-analysis** | static-analysis-orchestrator-v2, tier2-linter-aware-prompt, bedrock-review-chunk-envelope | Tier-1 dataflow: orchestrator threads `tier1_findings`/`tool_statuses` into fan-out; prompt gate renders them; envelope carries the typed return. Thread + render together or the prompt section is always empty. |
| **confluence cluster** | confluence-pr-context-manifests, confluence-label-routing, manifest-dependency-parsing, confluence-pr-context-full-pr | AND-gated; all key off `enrich-pr-files-v2.files`; DELETE the MVP per-chunk fallback (`FOLLOW-UP-retire-pr-context-mvp-helper`). **Stage 4.** |
| **enrich→confluence bridge** | enrich-pr-files-v2 (+ the cluster) | enrich is the data source; port enrich-v2 FIRST. **Stage 4.** |
| **repo-path retirement cohort** | repo-path-cutover, enrich-pr-files-v2, citation-validate-activity | Port the post-cutover contracts (`ClonedRepoV1.repo_path` explicit, `PrFilesEnrichmentResultV1`, citation activity boundary); drop derived-path/v1-enrich/inline-citation fallbacks. |
| **output-safety emit pair** | output-safety-emit-chunk, output-safety-emit-walkthrough | Both read `sanitization_event` off the typed chunk envelope; port the envelope first. **Stage 3.** |

---

## 4. Target module layout

```
apps/backend/src/
  workflows/
    review_pull_request.workflow.ts     # @workflow entry (sandbox); replaces review_skeleton
  review/pipeline/
    orchestrator.ts                     # orchestrate(ctx): port of orchestrate_review_pipeline
    gates.ts                            # collapsed-gate ledger (doc constant + future-TS-gate seam)
    state.ts                            # ReviewWorkflowState + DegradationCollector + capture types
    activity_ports.ts                   # ReviewActivityPorts (typed proxyActivities) + RETRY_POLICIES
    degradation.ts                      # stageOutcome() + STAGE_NAMES + record_stage shim→real
    posting.ts                          # renderWalkthroughForPost / persistWalkthroughIfEnabled / ...
    lifecycle.ts                        # ANALYSIS_STARTED/ANALYZED/finalize/skipped/degraded/...
    helpers.ts                          # pure: _infer_pr_topology_kind, _resolve_degraded_payload, ...
  activities/
    select_carry_forward.activity.ts    # NEW (stage 1)
    static_analysis.activity.ts         # NEW (stage 1 empty-valid → stage 4 real)
    generate_walkthrough.activity.ts    # NEW (stage 1)
    persist_review_walkthrough.activity.ts  # NEW (stage 1)
    ... (stage 2-5 activities)
libs/contracts/src/                     # any missing trivial *.v1.ts
```

---

## 5. Drafted interfaces (the typed seams)

```typescript
// state.ts — finding 4
export class DegradationCollector {
  readonly notes: string[] = [];                 // machine-keys + human-readable
  add(note: string): void { if (!this.notes.includes(note)) this.notes.push(note); }
  compose(priorNote?: string): string | undefined { /* port of _compose_orchestrator_degradation_note */ }
}
export type PostedReviewCapture = {
  reviewId: number | null;
  commentIds: readonly number[];
  postedReviewPrId: string | null;
  keptFindingIndices: readonly number[];
  publicationOutcome: PublicationOutcome | null;
  degradationNotes: readonly string[];
  droppedClassifications: readonly DroppedClassificationV1[];
};
export class ReviewWorkflowState {
  readonly policyBundles = new Map<string, ResolvedGuidanceBundleV1>();
  readonly queryVectorCache = new Map<string, readonly number[]>();   // finding 10: keyed by chunk path
  readonly degradation = new DegradationCollector();
  repoConfig: CodemasterConfigV1 = CodemasterConfigV1.parse({});      // box → field
  inlinePostFilterMetadata?: InlinePostFilterMetadata;
  postedReview?: PostedReviewCapture;
  arbitration?: ArbitrationCapture;
  persistedFindingIds: readonly string[] = [];
}

// activity_ports.ts — finding 9 (one typed envelope per activity) + retry policies
export type ReviewActivityPorts = {
  clone(i: CloneRepoIntoWorkspaceInput): Promise<ClonedRepoV1>;
  classify(i: { workspacePath: string; files: readonly string[] }): Promise<FileRoutingV1>;
  chunkAndRedact(i: { workspacePath: string; files: readonly string[]; ranges: ChangedLineRanges }): Promise<readonly DiffChunkV1[]>;
  staticAnalysis(i: { workspacePath: string; sandboxFiles: readonly string[]; ranges: ChangedLineRanges; prMeta: PrMetaV1 }): Promise<StaticAnalysisResultV1>;
  selectCarryForward(i: { parentFindings: readonly ReviewFindingV1[]; chunks: readonly DiffChunkV1[]; ranges: ChangedLineRanges; parentReviewId: string | null }): Promise<CarryForwardSelectionV1>;
  embedQuery(i: EmbedQueryInputV1): Promise<EmbedQueryResultV1>;
  retrieveKnowledge(i: RetrieveKnowledgeInputV1): Promise<RetrieveKnowledgeResultV1>;
  reviewChunk(i: ReviewContextV1): Promise<ReviewChunkResponseV1>;
  aggregate(i: { findings: readonly ReviewFindingV1[]; policyRevision: number }): Promise<AggregatedFindingsV1>;
  generateWalkthrough(i: { prMeta: PrMetaV1; aggregated: AggregatedFindingsV1; linkedIssues: readonly LinkedIssueV1[]; suggestedReviewers: readonly string[] }): Promise<WalkthroughV1>;
  postReview(i: PostReviewInputV1): Promise<PostedReviewV1>;
  postCheckRun(i: { prMeta: PrMetaV1; headSha: string; summary: string }): Promise<unknown>;
  cleanup(i: ReleaseWorkspaceInput): Promise<void>;
  // ... stage 2-5 ports added incrementally
};
// Per-activity retry policy constants (1:1 with the Python start_to_close/retry values from the map).
export const RETRY_POLICIES = { clone: {...}, reviewChunk: {...}, postReview: {...}, /* ... */ } as const;

// degradation.ts — stage_outcome (CancelledError ALWAYS re-raises; finding + risk)
export async function stageOutcome<T>(
  stage: StageName,
  o: { state: ReviewWorkflowState; raiseAfterLog?: boolean; skipOutcome?: boolean },
  body: () => Promise<T>,
): Promise<T | undefined>;   // swallow-by-default unless raiseAfterLog; CancelledError re-raised unconditionally

// gates.ts — collapsed ledger (finding 3): all 25 markers documented; NO runtime patched()
export const COLLAPSED_GATES = Object.freeze({ /* marker: { disposition: 'collapse-on', portedInStage } */ });
```

---

## 6. Staged tasks

Each stage = a few small commits in ONE parent PR (`feat/review-orchestrator-port`); **do not merge until the whole PR is green** (owner commit plan). Stage 1 is a **live dual-run checkpoint**.

### Stage 0 — Foundations (contracts, state, ports, degradation, gates ledger)
**Files:** `review/pipeline/{state,activity_ports,degradation,gates,helpers}.ts`; any missing trivial `libs/contracts/src/*.v1.ts`.
**Parity:** the closure boxes + helper fns in `review_pull_request.py` (state) and `stage_outcome.py` (degradation).
**Build:** `ReviewWorkflowState`+`DegradationCollector`; `ReviewActivityPorts`+`RETRY_POLICIES` (values transcribed from the activity map); `stageOutcome`+`STAGE_NAMES`+`record_stage` (no-op shim in stage 0; real Prometheus in stage 5); the pure helpers; `gates.ts` ledger; missing trivial contracts.
**Tests:** unit — `stageOutcome` swallow/re-raise matrix incl. **CancelledError always re-raises**; `DegradationCollector.compose` dedup; helper pure-fn parity vs Python fixtures.
**DoD:** typecheck + `check_workflow_bundle.ts` green (no crypto pulled into sandbox modules).

### Stage 1 — The live spine ⭐ (dual-run checkpoint)
**Files:** `review/pipeline/orchestrator.ts`; `activities/{select_carry_forward,static_analysis,generate_walkthrough,persist_review_walkthrough}.activity.ts`; `workflows/review_pull_request.workflow.ts`; extend `worker/build_activities.ts`+`worker/registry`+`worker/main.ts`.
**Parity:** `review_pipeline_orchestrator.py` happy-path stages 1–13 (clone → load_repo_config → compute_policy_rules → classify → filter → [chunk_and_redact ‖ static_analysis] → select_carry_forward → fan_out(review_chunk) → dedup → aggregate → walkthrough → [post_review ‖ post_check_run] → cleanup-finally); the 3 missing activities from their Python sources.
**Build:** `orchestrate()` (typed `ReviewPipelineContext`); `fanOutReview` (concurrency-limited, **slot-ordered deterministic fan-in**, returns `[findings, intents]`); `_coerce_chunk_result`; `dedupLinterWithLlm` (over existing `aggregation_semantic.ts`; fail-open on embedder); the 3 required activities (`select_carry_forward` pure; `static_analysis` empty-valid `StaticAnalysisResultV1`; `generate_walkthrough` real Opus); `persist_review_walkthrough`; thin workflow body that **bypasses** mutex/webhook/lifecycle and calls `orchestrate()` from a hand-seeded `ReviewPullRequestPayloadV1` (**schema_version=2**).
**Concurrency/replay:** fan-out uses `Promise.all` over a deterministic index-ordered array with an explicit semaphore; **no `Math.random`/`Date.now`/`crypto` in the sandbox**.
**Tests:** `TestWorkflowEnvironment` composition test (in-process, time-skip) proving clone→…→post executes with stubbed activities; registry-coverage test extended; **then the live dual-run** (§8).
**DoD:** the in-process workflow test green; **live run** against Temporal dev + disposable PG (5434) + Ollama posts a real review. ⚠ Verify `LlmClientCache.forRole` resolves the **walkthrough role** to the local model (risk: 2nd model `claude-opus-4-7`).

### Stage 2 — Webhook gate + PR-review mutex + workspace lifecycle (finding 6)
**Build:** `start_review_for_webhook_activity` (tenancy re-check + `acquire_pr_review_mutex`, holder_workflow_id), `renew_pr_review_mutex_lease_activity` (bool, fail-open), `release_pr_review_mutex_activity` (idempotent, finally), `post_review_placeholder` + `delete_review_placeholder`; `ReviewPullRequestResultV1`. Workflow body: prepend gate (`skipped_busy`/`skipped_disabled`/`closed`), wrap orchestrator in lease (acquire→renew-heartbeat→**release in finally**), **claim-check before clone/aggregate/persist/post**, release workspace in finally, cancellation releases resources.
**Tests:** mutex busy → `skipped_busy`; claim-lost-before-{clone,aggregate,post} → no GitHub post; cancellation releases mutex+workspace.

### Stage 3 — Run-state + delivery lifecycle + BF-5/BF-13 + degradation-before-post fix (finding 7) + citation/audit
**Build:** `record_review_lifecycle_event` (ANALYSIS_STARTED/ANALYZED), `finalize_review_run`, `record_run_failed` (BF-5), `record_run_cancelled` (BF-13), `record_delivery_{finalized,skipped,degraded}`, `record_tool_runs`, `emit_output_safety_audit_event` (idempotent), `citation_validate`. Workflow body: full lifecycle ordering; **compose degradation notes BEFORE postReview** (ADR-0069 divergence); `posting.ts` split (finding 8): `renderWalkthroughForPost`/`persistWalkthroughIfEnabled`/`postReviewResults`/`extractDroppedStateFromPostFailure`/`dispatchInlineSkippedLifecycle`/`derivePublicationOutcome`.
**Tests:** citation drops findings; output-safety sanitization audit; persist failure fail-open; dropped-state post failure → inline skipped lifecycle; no zombie RUNNING rows.

### Stage 4 — Real static analysis + enrichment/manifest/issue/reviewer + evidence (coupled groups: confluence, enrich)
**Build:** real Ruff/ESLint runners behind `StaticAnalysisPipelinePort`; `enrich_pr_files_v2`; `fetch_manifest_snapshots` + `parse_manifest_dependencies` (+ ecosystem parsers); `fetch_linked_issues`; `fetch_suggested_reviewers`; `update_pr_description_summary`; `build_retrieved_evidence` (**in an activity** — crypto). Port the **confluence cluster atomically**, DELETE the MVP fallback.
**Tests:** static-analysis findings merged with LLM; manifest/issue/reviewer context threaded; classify partial failure → degradation note; path-filters-exclude-all early-exit.

### Stage 5 — Arbitration + fix-prompt + real observability + policy post-filter (coupled: config+policy+persist, Phase-B)
**Build:** `apply_arbitration` + `ApplyArbitrationInput` + `ArbitrationResult` + `arbitrate()` + `SuppressionPolicy`; `generate_fix_prompt`; `record_stage` **real Prometheus emit** (replace shim) + `STAGE_NAMES` validation; `apply_policy_post_filter` wired into orchestrator; the **config+policy+persist** and **Phase-B static-analysis** coupled groups fully wired straight-line (NO `patched()`).
**Tests:** arbitration suppression + failure fail-open; fix-prompt comment; aggregate cap + config notice; chunk cap exceeded.

### Stage 6 — Full test matrix + replay determinism + final dual-run
**Build:** the complete §7 matrix; `TestWorkflowEnvironment` replay-determinism test; activity-registry coverage; the final live dual-run against a real PR.

---

## 7. Required test matrix (Definition of Done — owner)

Mapped to the stage that makes each assertable:

| Scenario | Stage |
|---|---|
| repo disabled by config | 2 |
| mutex busy → skipped_busy | 2 |
| claim lost before clone / aggregate / post → no GitHub post | 2 |
| clone failure | 1 |
| classify partial failure → degradation note | 4 |
| path filters exclude all files → early-exit advisory | 4 |
| chunk cap exceeded | 5 |
| static analysis failure | 4 |
| carry-forward failure fallback (review all) | 1 |
| embed_query failure / retrieve_knowledge failure → fail-open degradation | 1 (guards) |
| LLM single-chunk failure | 1 |
| output-safety sanitization | 3 |
| aggregate cap + config notice | 5 |
| citation validation drops findings | 3 |
| persist failure fail-open | 3 |
| arbitration failure | 5 |
| walkthrough failure fallback | 1 |
| GitHub post failure with dropped state | 3 |
| cleanup failure | 1 |
| workflow cancellation releases mutex/workspace | 2 |
| activity registry coverage | 1 (extended) |
| workflow replay determinism | 6 |

---

## 8. Live dual-run protocol (owner: "I'll start Temporal")

1. Owner starts the dev server: `temporal server start-dev` (gRPC on `:7233`).
2. Ensure disposable PG (`localhost:5434`, migrated to head) + Ollama (`localhost:11434`, `mxbai-embed-large` + a chat model the walkthrough/review roles resolve to).
3. Configure `core.llm_provider_settings` rows for the review + walkthrough roles → the local Ollama model (Bedrock-shaped).
4. Run the worker (`buildActivities()` + the new workflow) against namespace/queue isolated from any cluster.
5. Execute the workflow with a hand-seeded `ReviewPullRequestPayloadV1` (v2) for a small fixture PR; observe clone→…→post in Temporal Web; assert the GitHub review/check-run + persisted findings/walkthrough rows.
6. **Stage-1 runs use the disposable PG only** (no mutex/lifecycle yet → never the cluster).

---

## 9. Risks & mitigations

- **3 required activities have no skip branch** → stage 1 builds all three (cheapest faithful: pure carry-forward + empty-valid static-analysis + real walkthrough). Never `None`/fake.
- **Walkthrough = 2nd model** → verify the dev Ollama config maps the walkthrough role, else `tldr` is empty.
- **`stage_outcome` semantics** → CancelledError unconditionally re-raised even in the shim; unit-test the matrix in stage 0.
- **Fan-out determinism** → index-ordered slots + explicit semaphore; no nondeterministic ordering in the sandbox.
- **Crypto in sandbox** → `build_retrieved_evidence`/redaction/uuid/clock stay in activities; `check_workflow_bundle.ts` is the gate.
- **Stage-1 leaks without mutex/lifecycle** → disposable PG only until stage 2/3.
- **Gate over-collapse** → port coupled groups atomically (§3); do NOT leave MVP fallbacks as "safe defaults" (silent quality regressions).
- **No `patched()` in TS** → porting any `patched()`/`deprecate_patch()`/legacy branch re-introduces dead optionality (violates remove-rollout-scaffolding discipline). The gap-synth's "introduce 24 gates" is OVERRIDDEN by the gate ledger.

---

## 10. Commit / PR strategy (owner)

One parent PR `feat/review-orchestrator-port`, small reviewable commits roughly per stage (0→6). **Do not merge until the whole PR is green.** Stage 1 is a live checkpoint (owner dual-run) but stays in the same PR. ADR-0069 records the degradation-notes-before-post divergence. The Python repo stays frozen as the parity oracle.
