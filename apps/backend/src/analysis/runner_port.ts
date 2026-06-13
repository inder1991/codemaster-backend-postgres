/**
 * AnalysisRunner — the seam every static-analysis runner implements.
 *
 * Two implementation strategies:
 *   - subprocess `InWorkerRunner` (Ruff / ESLint / Gitleaks) — fast, low-memory tools run inside the
 *     worker pod.
 *   - `JobRunner` (Semgrep / Trivy / Checkov / Kube-linter) — heavy tools run as one-shot K8s Jobs.
 *     Out of scope here.
 *
 * Either way the orchestrator only sees `run(...) -> ReadonlyArray<AnalysisFindingV1>`; the sandbox
 * choice is invisible to it.
 *
 * On `changedLineRanges`: subprocess runners ACCEPT but IGNORE this argument — filtering is
 * centralized (the orchestrator applies `filterToChangedLines` post-fan-out). It is part of the
 * contract so future source-level-optimizing runners can consume it.
 */

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";

/** Per-file inclusive `[start_line, end_line]` tuples of changed lines. */
export type ChangedLineRanges = Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>;

/** Options passed to every runner's `run`. */
export type RunnerRunInput = {
  /** Absolute workspace path the tool scans (subprocess `cwd`). */
  readonly workspace: string;
  /** The files (workspace-relative) routed to this tool. Empty ⇒ no subprocess; return `[]`. */
  readonly files: ReadonlyArray<string>;
  /** Accepted but currently unused by subprocess runners (central filtering). */
  readonly changedLineRanges: ChangedLineRanges;
  /**
   * Soft-barrier cancellation signal. The orchestrator owns the authoritative Tier-1 deadline and
   * arms ONE shared signal; when it fires (deadline hit) a runner should abandon its in-flight work.
   * This is the cancellation analogue — JS promises aren't
   * cancellable, so cooperative cancellation flows through this signal (the subprocess `InWorkerRunner`
   * tears down the process group when it sees the abort). Optional: a runner MAY ignore it (the
   * orchestrator stops awaiting it at the deadline regardless and records `timed_out`).
   */
  readonly signal?: AbortSignal;
};

/** Run a static-analysis tool against a workspace. */
export type AnalysisRunner = {
  /** Stable tool identifier; matches `AnalysisFindingV1.tool` and `ToolStatusV1.tool_name`. */
  readonly name: string;
  run(input: RunnerRunInput): Promise<ReadonlyArray<AnalysisFindingV1>>;
};
