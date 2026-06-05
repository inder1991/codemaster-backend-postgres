/**
 * `staticAnalysis` activity — STAGE-1 EMPTY-VALID placeholder (no-tools-configured result).
 *
 * ## What this is (and explicitly is NOT)
 *
 * This is the STRUCTURALLY-FAITHFUL Stage-1a port of the frozen Python `static_analysis_activity`
 * (vendor/codemaster-py/codemaster/activities/static_analysis.py — `StaticAnalysisActivity`). It accepts
 * the REAL typed input envelope (workspace_path + sandbox_files + changed_line_ranges + pr_meta) and
 * returns a well-formed {@link StaticAnalysisResultV1} with EMPTY collections. No Ruff / ESLint /
 * Gitleaks / Semgrep / Trivy runner fires — the real runner orchestration (StaticAnalysisPipeline +
 * AnalysisCurator) lands in STAGE 4.
 *
 * This is NOT a behavioral stub we're hiding. It is the FAITHFUL result when no Tier-1 tool is
 * configured — byte-identical to what the frozen Python returns on its empty-file-routing fast path
 * (`if not files: return StaticAnalysisResultV1()`). The default `StaticAnalysisResultV1()` envelope IS
 * the legitimate "nothing to report" answer: `findings=[]`, `per_tool_errors={}`, `curator_skipped=true`,
 * `truncated_per_tool={}`, `tier1_findings=[]`, `tool_statuses=[]`. Because the orchestrator invokes
 * static-analysis UNCONDITIONALLY (review_pull_request.py:1431-1448, then re-validated via
 * `StaticAnalysisResultV1.model_validate(result)` with `extra="forbid"`), the Stage-1 spine needs THIS
 * activity to return a real, parseable envelope the dedup/aggregate/fan-out path accepts — an absent or
 * malformed return would crash Step 3b. The empty-valid envelope satisfies that contract today and lets
 * the rest of the pipeline compose end-to-end while the runners are still being ported.
 *
 * ## Stage-4 follow-up — FOLLOW-UP-static-analysis-stage4-runners
 *
 * STAGE 4 replaces the empty-valid body with the real runner orchestration: construct the Tier-1 runners
 * (Ruff/ESLint/Gitleaks + the JobRunner-dispatched Semgrep/Trivy/Checkov/Kube-linter), scan the
 * `sandbox_files` filtered by `changed_line_ranges`, populate `tier1_findings` + `tool_statuses`, run the
 * Haiku `AnalysisCurator` to promote raw findings → `findings`, and surface `per_tool_errors` /
 * `truncated_per_tool`. At that point this module gains a bound-method holder + injected pipeline port
 * (the 1:1 analogue of the frozen Python `StaticAnalysisActivity(pipeline=...)` holder), mirroring how
 * `aggregate_findings.activity.ts` grew its `AggregateFindingsActivity` holder. The empty-file-routing
 * fast path (`if not sandbox_files`) the Python guards stays valid then too — it short-circuits to this
 * same default envelope before constructing any runner.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The frozen Python activity dispatches with FOUR positional arguments
 * (`static_analysis_activity(workspace_path, files, changed_line_ranges, pr_meta_dict)`) — an
 * invariant-11 violation. This port CLOSES it: the single positional input is the
 * {@link StaticAnalysisInputV1} envelope (introduced during the port; consistent with the sibling
 * chunk_and_redact.v1 / classify_files.v1 / aggregate_findings.v1 envelopes).
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. The Stage-1 body is
 * PURE (no clock, no random, no DB, no fs, no network): it returns a constant envelope, so it registers
 * no clock/random seam and touches no Postgres. The Stage-4 runner orchestration will read the workspace
 * filesystem + invoke tool subprocesses, but that is out of scope here.
 *
 * ## Shared-wiring boundary
 *
 * The worker registry, build_activities, and the orchestrator's activity_ports all live in the shared
 * wiring files the Integrate phase owns — this module deliberately does NOT touch them. It exports the
 * registered activity function only; the Integrate phase binds it into the `activities=[...]` map under
 * the existing `static_analysis_activity` Temporal name.
 */

import type { StaticAnalysisInputV1 } from "#contracts/static_analysis_input.v1.js";
import { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";

/**
 * The registered activity — STAGE-1 empty-valid body.
 *
 * Returns the default {@link StaticAnalysisResultV1} envelope (every collection empty,
 * `curator_skipped=true`) regardless of the input payload. The input is accepted in full (and validated
 * by Zod at the dispatch boundary) so the activity's WIRE CONTRACT is the real Stage-4 contract from day
 * one — only the BODY is the no-tools placeholder. `StaticAnalysisResultV1.parse({})` applies all the
 * Pydantic-parity defaults, so the returned envelope is byte-identical to the frozen Python
 * `StaticAnalysisResultV1()` default.
 *
 * The `input` is intentionally referenced-but-unused at Stage 1 (the no-tools result is payload-invariant
 * until the Stage-4 runners derive findings from `sandbox_files` + `changed_line_ranges`). The leading
 * `void input;` documents that this is deliberate, not an oversight, and keeps the noUnusedParameters
 * lint honest about the FOLLOW-UP-static-analysis-stage4-runners boundary.
 */
export async function staticAnalysis(input: StaticAnalysisInputV1): Promise<StaticAnalysisResultV1> {
  // STAGE 1: the payload is accepted (and Zod-validated upstream) but not yet consumed — the runners that
  // derive findings from it land in FOLLOW-UP-static-analysis-stage4-runners. Until then the no-tools
  // result is invariant in the payload.
  void input;

  // The default envelope IS the faithful "no Tier-1 tool configured" answer — identical to the frozen
  // Python `StaticAnalysisResultV1()`. Parsing the empty object applies every Pydantic-parity default
  // (schema_version=1, findings=[], per_tool_errors={}, curator_skipped=true, truncated_per_tool={},
  // tier1_findings=[], tool_statuses=[]) so the return is a real, strictly-valid contract instance the
  // orchestrator's Step-3b `StaticAnalysisResultV1.model_validate` round-trip accepts.
  return StaticAnalysisResultV1.parse({});
}
