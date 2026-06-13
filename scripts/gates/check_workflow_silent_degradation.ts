// Workflow silent-degradation gate.
//
// Refuses `try { ... } catch { ... }` sites in workflow/pipeline/runner code that swallow a failure
// SILENTLY — neither propagating it, nor logging it, nor recording it. The smoke-#5..#8
// apply_arbitration regression class begins exactly there: a bare catch that (at best) noted
// `type(e).__name__` and swallowed left `core.review_findings` empty with zero operator signal.
// The structural fix is the sanctioned degradation helper `stageOutcome`
// (apps/backend/src/review/pipeline/degradation.ts) which unifies the WARN log + record_stage
// outcome counter + degradation-notes mutation on every degradation path — catches whose try body
// routes through it are fine by construction.
//
// COMPLIANCE PATHS — a catch clause is compliant when ANY of these holds:
//
//   1. The TRY body uses `stageOutcome` at ANY nesting depth (bare `stageOutcome(...)` or property
//      `x.stageOutcome(...)`; includes the raiseAfterLog=true outer-catch pattern).
//      Helpers that themselves wrap stageOutcome are out of scope for v1 — only the bare name is
//      matched.
//
//   2. The CATCH block contains a TOP-LEVEL `throw` statement. The gate is STRICT on top-level —
//      a conditional re-throw (`if (fatal) throw e;`) does NOT count; the
//      swallow path through the false branch is still a silent degradation.
//
//   3. The CATCH block LOGS the failure at warning+ severity or RECORDS it (TS-surface extension —
//      see DELTAS below). Matched at any nesting depth inside the catch block:
//        * logger call whose method is warn / warning / error / fatal (console.*, pino, the
//          workflow logger, the CS8 structured StageLogger — every such warning now reaches a real
//          sink). info/debug/log do NOT count: a swallowed failure must be at least
//          warning-severity to be operator-visible.
//        * a `record*` call (recordStage, recordLifecycleSetterFailed, recordHeartbeatFailure, ...)
//          — the bounded-cardinality counter family is the canonical degradation record.
//        * a degradation-notes append — `.add(...)` / `.push(...)` on a receiver containing
//          "degradation" (state.degradation.add, degradationNotes.push).
//
//   4. The CATCH block contains a TOP-LEVEL `<controller>.abort(...)` call (TS-surface extension).
//      Abort-propagation is the cancellation-channel analogue of `throw`: the failure is converted
//      into a signal the owning scope observes and settles/logs (heartbeat loops, the shell's renew
//      loop). Top-level only — same strictness as rule 2.
//
//   5. The telemetry-emit shape (TS-surface extension): an EMPTY catch block whose try body is
//      EXACTLY ONE instrument emit — `<SCREAMING_SNAKE_CONST>.add(...)` / `.record(...)` — the
//      runner_metrics.ts "telemetry never perturbs the runner" posture. Nothing is degraded: the
//      guarded operation IS the observability emit, and there is nothing useful to do about a
//      failing counter. (The Python carried the same class as EXEMPTED
//      PERMANENT-EXEMPTION-auxiliary-observability entries; the shape is structural here so 13
//      registry lines don't rot with every runner_metrics.ts edit.)
//
//   6. Inline marker `// silent-degradation:exempt reason=<...> follow_up=<story-id>` on the try
//      line, the catch line, or the line immediately preceding either. The TS-comment equivalent of
//      the Python's registry mechanism, following the sibling `// tenant:exempt` marker convention.
//      Both reason= and follow_up= are mandatory. Prefer the marker for one-offs.
//
//   7. The site is in EXEMPTED (key `<repo-relative-path>::<try-line>`, the try statement being the
//      structural anchor). Every entry MUST carry a
//      follow_up_story per S23.AR.17 P-2 rotation discipline; the meta-gates
//      (check_exempted_lists_pointed / check_exempted_rotation_age) walk this registry.
//
// DELTAS from the original gate spec (each widens compliance, never narrows it):
//   * Python matched only `except Exception` / bare `except:`; a TS catch is ALWAYS untyped
//     (catches everything), so every catch clause is in scope — the typed-handler carve-out has no
//     TS analogue.
//   * Python accepted ONLY stage_outcome-in-try or top-level-raise; log/record compliance (rule 3)
//     is a TS-surface extension. It matches the gate's intent (failures must reach an operator
//     surface) and the post-CS8 reality that every degradation warning lands on a structured sink;
//     without it ~30 healthy log-and-continue loop/handler sites would need registry entries.
//   * Rules 4 + 5 are TS-surface shapes (cancellation channels, OTel instrument emits) with no
//     Python-gate analogue; both are structural, not comment-based — an explanatory comment alone
//     NEVER sanctions a swallow (the Python had no comment rule either).
//   * Promise `.catch(...)` method calls are out of scope for v1 (the Python walked `ast.Try`
//     only; the method-call shape has no analogue there). Same v1 boundary discipline as the
//     Python's helper-wrapper carve-out.
//
// SCOPE:
//     apps/backend/src/workflows/**       (Temporal workflow bodies)
//     apps/backend/src/review/pipeline/** (the workflow-body pipeline the workflows drive)
//     apps/backend/src/runner/**          (the de-temporal runner loops + handlers — the in-process
//                                          successors of the background workflows)
//   excluding `*.test.ts` and `*_repo.ts`. Repos are explicitly out of scope per the Python plan §
//   "What's NOT in scope" ("Activities, repos, helpers ... they raise and the failure surfaces");
//   activities/helpers/review-domain modules live outside the three scanned dirs already. Tests,
//   scripts/, tools/, migrations/ are NOT scanned.
//
// Mode: ERROR. Any silent-degradation site outside the escape hatches returns 1.
import * as path from "node:path";

import {
  type Block,
  type CatchClause,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  type TryStatement,
} from "ts-morph";

export type ExemptedEntry = {
  /** The enclosing function/closure — documentation, not part of the lookup key. */
  symbol: string;
  reason: string;
  /** Sprint-aligned story id (S\d+\.[A-Z]+\.\d+), hotfix (S\d+\.X-<slug>), or PERMANENT-EXEMPTION-*. */
  follow_up_story: string;
};

// ── EXEMPTED registry ────────────────────────────────────────────────────────────────────────────
//
// Key shape: "<repo-relative path>::<line_no>" — line is the line of the `try` statement (the
// structural anchor of the pattern, and the line the gate reports on violations). Line drift on
// any of these files moves the key; the real-repo smoke in
// test/gates/check_workflow_silent_degradation.test.ts pins raw-violations == registry keys so a
// drifted entry fails loud instead of silently un-exempting.
//
// New entries require a follow_up_story per S23.AR.17 P-2 rotation. Prefer the inline
// `// silent-degradation:exempt reason=<...> follow_up=<...>` marker for one-offs.
export const EXEMPTED: Record<string, ExemptedEntry> = {
  "apps/backend/src/runner/stage_log_sink.ts::62": {
    symbol: "makeStructuredStageLogger",
    follow_up_story: "PERMANENT-EXEMPTION-defensive-log-emit",
    reason:
      "A failing log SINK must never fail the review — and there is no caller-side fix: the " +
      "failure is at the logging layer itself, so there is nowhere left to log it (1:1 with the " +
      "Python F13 PERMANENT-EXEMPTION-defensive-log-emit at review_pull_request.py::3430). " +
      "PERMANENT by construction.",
  },
  // run_with_retry.ts::15 (PERMANENT-EXEMPTION-retry-helper-conditional-rethrow) became an INLINE
  // `// silent-degradation:exempt` marker at the try site itself: the W1.9c composed-abort
  // threading shifted the try line, and the marker travels with the code where a line-keyed
  // registry entry cannot. The curated rationale lives verbatim in the marker's comment block.
};

/** Inline exemption marker — the TS-comment equivalent of the registry, mirroring the sibling
 *  `// tenant:exempt` convention. Both `reason=` and `follow_up=` are mandatory. */
export const MARKER_RE = /silent-degradation:exempt\s+reason=\S+\s+follow_up=\S+/;

/** The sanctioned degradation helper (apps/backend/src/review/pipeline/degradation.ts). */
const STAGE_OUTCOME_NAME = "stageOutcome";

/** Logger methods that count as an operator-visible failure log (warning+ severity only). */
const LOG_METHODS: ReadonlySet<string> = new Set(["warn", "warning", "error", "fatal"]);

/** The bounded-cardinality counter family: recordStage, recordLifecycleSetterFailed, ... */
const RECORD_CALL_RE = /^record[A-Z]/;

/** Degradation-notes appends: `.add(...)` / `.push(...)` on a degradation-notes receiver. */
const NOTES_APPEND_METHODS: ReadonlySet<string> = new Set(["add", "push"]);
const DEGRADATION_RECEIVER_RE = /degradation/i;

/** The telemetry-emit shape: `<SCREAMING_SNAKE_CONST>.add(...)` / `.record(...)` (OTel instrument
 *  module-consts in runner_metrics.ts) guarded by an EMPTY catch. */
const INSTRUMENT_EMIT_METHODS: ReadonlySet<string> = new Set(["add", "record"]);
const INSTRUMENT_RECEIVER_RE = /^[A-Z][A-Z0-9_]*$/;

/** The scanned surfaces — the TS equivalent of the Python's `codemaster/workflows/` scope. */
const SCOPED_DIR_RE = /^apps\/backend\/src\/(?:workflows|review\/pipeline|runner)\//;

export type Violation = {
  /** Repo-relative POSIX path of the offending file. */
  file: string;
  /** 1-based line of the `try` statement — the structural anchor (and the EXEMPTED key line). */
  line: number;
  /** 1-based line of the catch clause, for diagnostic clarity. */
  catchLine: number;
};

/** True iff `absPath` is a scanned workflow/pipeline/runner source file (not a test, not a repo). */
export function isScopedSource(absPath: string): boolean {
  const rel = toRepoRelPosix(absPath);
  if (!rel.endsWith(".ts")) return false;
  if (rel.endsWith(".test.ts")) return false;
  // Repos are explicitly out of scope (Python plan § "What's NOT in scope": they raise; the
  // persistence layer's idempotency forks are not degradation paths).
  if (rel.endsWith("_repo.ts")) return false;
  return SCOPED_DIR_RE.test(rel);
}

/**
 * Repo-relative POSIX path, anchored on the `libs/` or `apps/` segment so the predicate is
 * identical for the real tree, the ts-morph in-memory FS, and already-relative inputs (same
 * anchoring rationale as check_clock_random.ts).
 */
function toRepoRelPosix(absPath: string): string {
  const posix = absPath.split(path.sep).join("/");
  const match = /(?:^|\/)((?:libs|apps)\/.*)$/.exec(posix);
  if (match) return match[1]!;
  const rel = path.isAbsolute(absPath) ? path.relative(process.cwd(), absPath) : absPath;
  return rel.split(path.sep).join("/").replace(/^\.\//, "");
}

/**
 * Pure finder: every silent-degradation try/catch in the scoped surfaces. `exempted` is injectable
 * so tests can pass `{}` to surface the RAW violation set (the real-repo smoke pins raw ==
 * registry keys, which fails loud on line drift instead of silently un-exempting an entry).
 */
export function findSilentDegradationViolations(
  project: Project,
  exempted: Record<string, ExemptedEntry> = EXEMPTED,
): Array<Violation> {
  const out: Array<Violation> = [];
  for (const sf of project.getSourceFiles()) {
    if (!isScopedSource(sf.getFilePath())) continue;
    collectFileViolations(sf, toRepoRelPosix(sf.getFilePath()), exempted, out);
  }
  return out;
}

function collectFileViolations(
  sf: SourceFile,
  rel: string,
  exempted: Record<string, ExemptedEntry>,
  out: Array<Violation>,
): void {
  const lines = sf.getFullText().split("\n");
  for (const tryStmt of sf.getDescendantsOfKind(SyntaxKind.TryStatement)) {
    const catchClause = tryStmt.getCatchClause();
    if (catchClause === undefined) continue; // try/finally — nothing is swallowed.
    const catchBlock = catchClause.getBlock();
    if (tryBlockUsesStageOutcome(tryStmt.getTryBlock())) continue; // rule 1
    if (catchHasTopLevelThrow(catchBlock)) continue; // rule 2
    if (catchObservesFailure(catchBlock)) continue; // rule 3
    if (catchHasTopLevelAbort(catchBlock)) continue; // rule 4
    if (isTelemetryEmitShape(tryStmt.getTryBlock(), catchBlock)) continue; // rule 5
    if (hasExemptMarker(tryStmt, catchClause, lines)) continue; // rule 6
    if (Object.hasOwn(exempted, `${rel}::${tryStmt.getStartLineNumber()}`)) continue; // rule 7
    out.push({
      file: rel,
      line: tryStmt.getStartLineNumber(),
      catchLine: catchClause.getStartLineNumber(),
    });
  }
}

/** Rule 1: the try body routes through the sanctioned degradation helper — bare `stageOutcome(...)`
 *  or property `x.stageOutcome(...)`, at ANY nesting depth (the catch/finally bodies are NOT
 *  walked; a stageOutcome call in the handler does not satisfy the contract). */
function tryBlockUsesStageOutcome(tryBlock: Block): boolean {
  for (const call of tryBlock.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (Node.isIdentifier(callee) && callee.getText() === STAGE_OUTCOME_NAME) return true;
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === STAGE_OUTCOME_NAME) {
      return true;
    }
  }
  return false;
}

/** Rule 2: a `throw` as a DIRECT child statement of the catch block. Strict on top-level — a
 *  conditional re-throw leaves the false branch silent and does NOT count. */
function catchHasTopLevelThrow(catchBlock: Block): boolean {
  return catchBlock.getStatements().some((s) => Node.isThrowStatement(s));
}

/** Rule 3: the catch logs at warning+ severity, emits a `record*` counter, or appends a
 *  degradation note — at any nesting depth inside the catch block. */
function catchObservesFailure(catchBlock: Block): boolean {
  for (const call of catchBlock.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (Node.isIdentifier(callee) && RECORD_CALL_RE.test(callee.getText())) return true;
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const method = callee.getName();
    if (LOG_METHODS.has(method)) return true;
    if (RECORD_CALL_RE.test(method)) return true;
    if (
      NOTES_APPEND_METHODS.has(method) &&
      DEGRADATION_RECEIVER_RE.test(callee.getExpression().getText())
    ) {
      return true;
    }
  }
  return false;
}

/** Rule 4: a TOP-LEVEL `<controller>.abort(...)` — failure conversion into the cancellation
 *  channel the owning scope observes and settles/logs. Top-level only (rule-2 strictness). */
function catchHasTopLevelAbort(catchBlock: Block): boolean {
  for (const stmt of catchBlock.getStatements()) {
    if (!Node.isExpressionStatement(stmt)) continue;
    const expr = stmt.getExpression();
    if (!Node.isCallExpression(expr)) continue;
    const callee = expr.getExpression();
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === "abort") return true;
  }
  return false;
}

/** Rule 5: empty catch guarding EXACTLY ONE module-const instrument emit — the runner_metrics.ts
 *  "telemetry never perturbs the runner" posture. Structural, not comment-based. */
function isTelemetryEmitShape(tryBlock: Block, catchBlock: Block): boolean {
  if (catchBlock.getStatements().length !== 0) return false;
  const statements = tryBlock.getStatements();
  const only = statements[0];
  if (statements.length !== 1 || only === undefined || !Node.isExpressionStatement(only)) {
    return false;
  }
  const expr = only.getExpression();
  if (!Node.isCallExpression(expr)) return false;
  const callee = expr.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  if (!INSTRUMENT_EMIT_METHODS.has(callee.getName())) return false;
  const receiver = callee.getExpression();
  return Node.isIdentifier(receiver) && INSTRUMENT_RECEIVER_RE.test(receiver.getText());
}

/** Rule 6: inline marker on the try line, the catch line, or the line immediately above either. */
function hasExemptMarker(
  tryStmt: TryStatement,
  catchClause: CatchClause,
  lines: ReadonlyArray<string>,
): boolean {
  for (const ln of [tryStmt.getStartLineNumber(), catchClause.getStartLineNumber()]) {
    if (MARKER_RE.test(lines[ln - 1] ?? "") || MARKER_RE.test(lines[ln - 2] ?? "")) return true;
  }
  return false;
}

/** CLI entry: emit H-16-format ERROR lines; return 1 on any violation (ERROR-mode). */
export function main(): number {
  const project = new Project({ tsConfigFilePath: "tsconfig.json" });
  const violations = findSilentDegradationViolations(project);

  if (violations.length === 0) {
    // Count the scanned surface for operator-visible signal.
    let files = 0;
    let catchSites = 0;
    for (const sf of project.getSourceFiles()) {
      if (!isScopedSource(sf.getFilePath())) continue;
      files += 1;
      catchSites += sf
        .getDescendantsOfKind(SyntaxKind.TryStatement)
        .filter((t) => t.getCatchClause() !== undefined).length;
    }
    process.stdout.write(
      `[INFO] workflow-silent-degradation(ts): ${files} file(s) scanned, ${catchSites} ` +
        `try/catch site(s) inspected; 0 violations (${Object.keys(EXEMPTED).length} exempted)\n`,
    );
    return 0;
  }

  for (const v of violations) {
    process.stderr.write(
      `[ERROR] file=${v.file}:${v.line} rule=workflow-silent-degradation ` +
        `message="try/catch at line ${v.line} (catch at line ${v.catchLine}) is a ` +
        `silent-degradation swallow: the try body does not use stageOutcome(...) and the catch ` +
        `neither rethrows (top-level throw) nor logs at warning+ severity nor records the ` +
        `failure. The smoke-#5..#8 apply_arbitration regression class begins exactly here." ` +
        `suggestion="wrap the stage body in stageOutcome(<stage>, { logger, ... }, async () => ` +
        `{ ... }) per apps/backend/src/review/pipeline/degradation.ts; OR add a top-level ` +
        "`throw` to the catch; OR log/record the failure (logger.warning / console.warn / " +
        "record*); OR add `// silent-degradation:exempt reason=<...> follow_up=<story-id>`; OR " +
        `add the site to EXEMPTED with a follow_up_story per S23.AR.17 P-2."\n`,
    );
  }
  process.stderr.write(
    `[ERROR] workflow-silent-degradation(ts): ${violations.length} violation(s)\n`,
  );
  return 1; // ERROR-mode: block on any silent swallow outside the escape hatches.
}

// CLI shim: run main() when invoked directly (`npx tsx scripts/gates/check_workflow_silent_degradation.ts`).
// The aggregate runner (run_all.ts) imports main() instead, so this branch is dormant there.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
