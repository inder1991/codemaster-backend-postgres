/**
 * `static_analysis_activity` — the REAL in-worker static-analysis activity. The holder owns:
 *   - the three in-worker runners (Ruff / ESLint / Gitleaks);
 *   - the NEWER soft-barrier {@link StaticAnalysisOrchestrator} (it owns the Tier-1 deadline, spawns
 *     the runners concurrently, soft-barrier-cancels at the deadline, and emits per-tool
 *     {@link ToolStatusV1} as first-class output);
 *   - the Haiku {@link AnalysisCurator} (promotes raw linter findings → reviewer-facing
 *     {@link ReviewFindingV1}; gitleaks/trivy always-promote, the rest go through Haiku).
 *
 * The bound activity method dispatches:
 *   1. EMPTY-ROUTING FAST PATH — when `sandbox_files` is empty (every PR file was reviewer-routed),
 *      return the default {@link StaticAnalysisResultV1} without constructing or running any runner.
 *      Returns the default {@link StaticAnalysisResultV1} when `sandbox_files` is empty.
 *   2. ROUTE files by language → a `RunnerSpec` list (`.py`→ruff, `.ts/.tsx/.js/.jsx`→eslint, ALL
 *      files→gitleaks — gitleaks is a secret scanner, file-language is irrelevant).
 *   3. RUN the orchestrator → RAW findings (uncapped, unfiltered, registration-ordered) + per-tool
 *      `tool_statuses`. The orchestrator NEVER raises (recoverable failures degrade to failure
 *      statuses); a degraded tool does NOT fail the review.
 *   4. `tier1_findings` = the RAW orchestrator findings (the Tier-2 LLM prompt cites them by
 *      finding_id; they must NOT be capped or changed-line-filtered).
 *   5. CAP per-tool at {@link MAX_RAW_PER_TOOL} (protects the curator's Bedrock budget from a
 *      misbehaving tool emitting tens of thousands of findings); drops surface in `truncated_per_tool`.
 *      Applied BEFORE the changed-line filter — exactly as the frozen `static_analysis_pipeline.py`
 *      (cap is PRE-filter so the budget is bounded even when a tool emits pre-existing-code findings).
 *   6. CHANGED-LINE FILTER the capped set (drops pre-existing-code findings + findings on files not in
 *      this PR) via {@link filterToChangedLines}.
 *   7. CURATE the filtered set → `findings` (ReviewFindingV1) + `curator_skipped`.
 *   8. `per_tool_errors` derived from the degraded tool statuses (failed_startup / failed_runtime /
 *      timed_out / auth_failed → `{tool_name: error_message}`), the per-tool degradation surface the
 *      walkthrough footer renders.
 *   9. ASSEMBLE {@link StaticAnalysisResultV1}.{findings, tier1_findings, tool_statuses,
 *      per_tool_errors, truncated_per_tool, curator_skipped}.
 *
 * ## Invariant-11 / typed-input envelope (ADR-0047)
 *
 * The single positional input is the {@link StaticAnalysisInputV1} envelope (workspace_path +
 * sandbox_files + changed_line_ranges + pr_meta).
 *
 * ## Runtime context (vs the workflow body)
 *
 * This is an ACTIVITY — it runs in the NORMAL Node runtime, NOT the workflow V8-isolate sandbox. The
 * runners spawn subprocesses (`child_process`), the curator invokes the LLM over the network, and the
 * orchestrator arms an AbortController + reads the injected {@link Clock}. ALL of that is forbidden in
 * the workflow body but fine here, exactly like `bedrockReviewChunk` + `generateWalkthrough`.
 *
 * ## K8s-Job runners (DEFERRED)
 *
 * Only the in-worker runners are registered. The heavy K8s-Job tools (Semgrep / Trivy / Checkov /
 * Kube-linter) are owner-provided infra — see `static_analysis_orchestrator.ts::JobRunnerPort` +
 * FOLLOW-UP-static-analysis-k8s-job-runners. Trivy's always-promote path in the curator stays correct
 * once a Trivy JobRunner is registered (the curator's always-promote set already includes "trivy").
 */

import type { Clock } from "#platform/clock.js";

import { AnalysisCurator } from "#backend/analysis/curator.js";
import type { LlmClientCacheLike } from "#backend/analysis/curator.js";
import { filterToChangedLines } from "#backend/analysis/promotion.js";
import type { AnalysisRunner } from "#backend/analysis/runner_port.js";
import {
  StaticAnalysisOrchestrator,
  type RunnerSpec,
} from "#backend/analysis/static_analysis_orchestrator.js";

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { StaticAnalysisInputV1 } from "#contracts/static_analysis_input.v1.js";
import { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";
import type { ToolStatusV1 } from "#contracts/tool_status.v1.js";
import type { PrMetaV1 } from "#contracts/walkthrough.v1.js";

/**
 * Per-tool raw-findings cap applied BEFORE curation (and before the changed-line filter). Protects the
 * curator's Bedrock budget from a misbehaving tool that emits thousands of findings. Drops surface in
 * `truncated_per_tool`.
 */
export const MAX_RAW_PER_TOOL = 500;

/**
 * Per-runner FILE-LIST cap applied at routing time (W2.6 / M1). Ruff + ESLint spread the routed
 * files onto the spawn argv; with no cap a monster PR (vendored-dep bump, generated code, mass
 * rename — 1000+ files) builds an argv past ARG_MAX (~2 MiB) → spawn fails E2BIG → `failed_startup`
 * for ruff, eslint AND gitleaks: the largest, highest-risk PRs silently lose ALL Tier-1 analysis
 * including the secret scan. 1000 files × ~100-byte paths ≈ 100 KiB of argv — a ~20× margin.
 * The cap keeps the FIRST N files (deterministic — sandbox_files order) and the drop is VISIBLE:
 * `ToolStatusV1.files_total` carries the full routed count (files_scanned < files_total) and a
 * structured WARN names the tool + drop count. Fail-OPEN, never crash the review (W1.9b posture).
 */
export const MAX_FILES_PER_RUNNER = 1000;

/**
 * The Tier-1 soft-barrier deadline (seconds) — the orchestrator's AUTHORITATIVE budget, owned here
 * next to the holder that constructs the orchestrator. W2.6 (M4): this MUST stay strictly below the
 * per-tool safety guard ({@link import("#backend/analysis/in_worker_runner.js").DEFAULT_TIMEOUT_SECONDS},
 * 60s) — when the two are equal the documented "orchestrator owns the deadline; tool timeouts are
 * only safety guards" inversion never happens and a hung tool eats the full per-tool budget. 45s
 * barrier / 60s guard gives the barrier a 15s preemption margin. (Pre-M4 both were 60 — the barrier
 * never preempted anything.) Both production composition roots (worker/build_activities.ts +
 * runner/in_process_ports.ts) import THIS constant; the lockstep is unit-pinned.
 */
export const TIER1_SOFT_BARRIER_SECONDS = 45;

/** ESLint-eligible extensions. */
const ESLINT_EXTENSIONS: ReadonlyArray<string> = [".ts", ".tsx", ".js", ".jsx"];

/** Tool-status labels that represent a per-tool DEGRADATION (vs `completed` / `skipped`). Their
 *  `error_message` feeds `per_tool_errors` (the walkthrough footer's degradation surface). */
const DEGRADED_STATUSES: ReadonlySet<string> = new Set<string>([
  "failed_startup",
  "failed_runtime",
  "timed_out",
  "auth_failed",
  "oom", // W2.6 (H15/M5): resource-exhaustion teardown is a per-tool degradation like any other
]);

/**
 * The slice of the {@link AnalysisCurator} the activity uses. The real curator owns the
 * {@link import("#backend/analysis/curator.js").LlmClientCacheLike} (Haiku via `forRole("secondary")`);
 * activity tests inject a fake that returns canned promotions without an LLM call.
 */
export type CuratorPort = {
  curate(
    findings: ReadonlyArray<AnalysisFindingV1>,
    args: { prMeta: PrMetaV1 },
  ): Promise<{ readonly findings: ReadonlyArray<ReviewFindingV1>; readonly curator_skipped: boolean }>;
};

/** The three in-worker runners the holder routes files to. */
export type StaticAnalysisRunners = {
  readonly ruff: AnalysisRunner;
  readonly eslint: AnalysisRunner;
  readonly gitleaks: AnalysisRunner;
};

/**
 * Activity holder. Owns the runners + soft-barrier orchestrator + curator, and binds
 * `static_analysis_activity` as a 1-arg method `buildActivities` registers under the Temporal name
 * `staticAnalysis`.
 */
export class StaticAnalysisActivity {
  private readonly runners: StaticAnalysisRunners;
  private readonly curator: CuratorPort;
  private readonly orchestrator: StaticAnalysisOrchestrator;

  public constructor(args: {
    runners: StaticAnalysisRunners;
    curator: CuratorPort;
    deadlineSeconds: number;
    clock: Clock;
  }) {
    this.runners = args.runners;
    this.curator = args.curator;
    this.orchestrator = new StaticAnalysisOrchestrator({
      deadlineSeconds: args.deadlineSeconds,
      clock: args.clock,
    });
  }

  /**
   * Dispatch the static-analysis subsystem against the input envelope. Bound as an arrow property so
   * it stays wired when destructured into `buildActivities`'s registration map.
   */
  public staticAnalysis = async (rawInput: StaticAnalysisInputV1): Promise<StaticAnalysisResultV1> => {
    // Parse at the activity boundary: a wrong-shape dispatch (e.g. a camelCase key from a drifting caller)
    // throws a clear ZodError here instead of silently reading `undefined`. Shadow `input` with the parsed
    // (defaulted + validated) value so every downstream read uses it.
    const input = StaticAnalysisInputV1.parse(rawInput);
    const files = input.sandbox_files;
    // 1. Empty-routing fast path — no runner fires; the default envelope is the "nothing to analyze"
    //    answer.
    if (files.length === 0) {
      return StaticAnalysisResultV1.parse({});
    }

    // 2. Route files by language → the RunnerSpec list, each list bounded at MAX_FILES_PER_RUNNER
    //    (W2.6 / M1 — see the constant's doc).
    const pyFiles = files.filter((f) => f.endsWith(".py"));
    const tsJsFiles = files.filter((f) => ESLINT_EXTENSIONS.some((ext) => f.endsWith(ext)));
    const runners: ReadonlyArray<RunnerSpec> = [
      capRunnerFiles({ name: "ruff", runner: this.runners.ruff, files: pyFiles }),
      capRunnerFiles({ name: "eslint", runner: this.runners.eslint, files: tsJsFiles }),
      // Gitleaks scans the WHOLE file set (secret scanner; file-language irrelevant).
      capRunnerFiles({ name: "gitleaks", runner: this.runners.gitleaks, files }),
    ];

    // 3. Run the orchestrator → RAW findings (uncapped, unfiltered) + per-tool statuses. Never throws.
    const { findings: rawFindings, toolStatuses } = await this.orchestrator.run({
      runners,
      workspace: input.workspace_path,
      changedLineRanges: input.changed_line_ranges,
    });

    // 4. tier1_findings = the RAW orchestrator findings (the Tier-2 LLM prompt cites them by
    //    finding_id; they must NOT be capped or changed-line-filtered).
    const tier1Findings = rawFindings;

    // 5. Cap per-tool at MAX_RAW_PER_TOOL (protects the curator budget), recording drops. Applied
    //    BEFORE the changed-line filter — exactly as the frozen pipeline.
    const { capped, truncatedPerTool } = capPerTool(rawFindings);

    // 6. Changed-line filter the capped set (drops pre-existing-code + non-PR-file findings).
    const filtered = filterToChangedLines(capped, input.changed_line_ranges);

    // 7. Curate the filtered set → reviewer-facing findings + curator_skipped.
    const curated = await this.curator.curate(filtered, { prMeta: input.pr_meta });

    // 8. per_tool_errors — the per-tool degradation surface, derived from the failed/timed-out
    //    statuses (the walkthrough footer renders it).
    const perToolErrors = perToolErrorsFromStatuses(toolStatuses);

    // 9. Assemble the envelope (.strict() validates the wire shape the orchestrator re-validates).
    return StaticAnalysisResultV1.parse({
      findings: curated.findings,
      tier1_findings: tier1Findings,
      tool_statuses: toolStatuses,
      per_tool_errors: perToolErrors,
      truncated_per_tool: truncatedPerTool,
      curator_skipped: curated.curator_skipped,
    });
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Bound one runner's routed file list at {@link MAX_FILES_PER_RUNNER} (W2.6 / M1). Keeps the FIRST
 * N (sandbox_files order — deterministic); `filesTotal` carries the full routed count so the
 * orchestrator's ToolStatusV1 surfaces the partial coverage (files_scanned < files_total) instead
 * of silently re-baselining. A structured WARN names the tool + drop count (skip-with-degradation-
 * note, the W1.9b posture — the spawn must never E2BIG away the whole tool).
 */
function capRunnerFiles(spec: RunnerSpec): RunnerSpec {
  if (spec.files.length <= MAX_FILES_PER_RUNNER) {
    return spec;
  }
  console.warn(
    JSON.stringify({
      event: "static_analysis.files_capped",
      tool: spec.name,
      files_total: spec.files.length,
      files_kept: MAX_FILES_PER_RUNNER,
      files_dropped: spec.files.length - MAX_FILES_PER_RUNNER,
    }),
  );
  return {
    ...spec,
    files: spec.files.slice(0, MAX_FILES_PER_RUNNER),
    filesTotal: spec.files.length,
  };
}

/**
 * Cap each tool's findings at {@link MAX_RAW_PER_TOOL}, preserving registration order. Per-tool drop
 * counts surface in `truncatedPerTool`. Applied BEFORE merging; findings retain their input order and
 * the cap keeps the FIRST `MAX_RAW_PER_TOOL` per tool.
 */
function capPerTool(rawFindings: ReadonlyArray<AnalysisFindingV1>): {
  capped: ReadonlyArray<AnalysisFindingV1>;
  truncatedPerTool: Readonly<Record<string, number>>;
} {
  const seenPerTool = new Map<string, number>();
  const truncated = new Map<string, number>();
  const capped: Array<AnalysisFindingV1> = [];
  for (const f of rawFindings) {
    const seen = seenPerTool.get(f.tool) ?? 0;
    if (seen < MAX_RAW_PER_TOOL) {
      capped.push(f);
      seenPerTool.set(f.tool, seen + 1);
    } else {
      truncated.set(f.tool, (truncated.get(f.tool) ?? 0) + 1);
    }
  }
  return { capped, truncatedPerTool: Object.fromEntries(truncated) };
}

/**
 * Derive `per_tool_errors` from the per-tool statuses: every DEGRADED status (failed_startup /
 * failed_runtime / timed_out / auth_failed) contributes `{tool_name: error_message}`. Sourced from the
 * orchestrator's first-class statuses (the single source of per-tool outcome truth).
 */
function perToolErrorsFromStatuses(
  toolStatuses: ReadonlyArray<ToolStatusV1>,
): Readonly<Record<string, string>> {
  const out = new Map<string, string>();
  for (const s of toolStatuses) {
    if (DEGRADED_STATUSES.has(s.status)) {
      out.set(s.tool_name, s.error_message ?? s.status);
    }
  }
  return Object.fromEntries(out);
}

/**
 * Build the production {@link StaticAnalysisActivity} holder. Constructs the three in-worker runners
 * (default binary names on `$PATH`; the worker-image provides ruff/eslint/gitleaks) + the orchestrator
 * (deadline + clock) + the Haiku curator (which owns the injected LLM cache). `buildActivities` calls
 * this with the shared ledger-wired LlmClientCache + the WallClock + the configured Tier-1 deadline.
 */
export function buildStaticAnalysisActivity(args: {
  runners: StaticAnalysisRunners;
  curatorCache: LlmClientCacheLike;
  deadlineSeconds: number;
  clock: Clock;
}): StaticAnalysisActivity {
  return new StaticAnalysisActivity({
    runners: args.runners,
    curator: new AnalysisCurator({ cache: args.curatorCache }),
    deadlineSeconds: args.deadlineSeconds,
    clock: args.clock,
  });
}
