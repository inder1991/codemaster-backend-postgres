import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";

import {
  EXEMPTED,
  findSilentDegradationViolations,
  isScopedSource,
  MARKER_RE,
  type Violation,
} from "../../scripts/gates/check_workflow_silent_degradation.js";

// Build an in-memory TS project from a snippet and run the gate over it. Mirrors the frozen Python
// gate's tests (test_check_workflow_silent_degradation.py): deterministic AST fixtures expressing
// the silent-degradation contract, plus a real-repo smoke at the bottom. Fixtures default to a
// production workflow path so the gate's scope filter sees them; `exempted` defaults to `{}` so
// fixture assertions are never masked by the real registry.
function violations(
  code: string,
  filePath = "apps/backend/src/workflows/x.workflow.ts",
  exempted: Record<string, { symbol: string; reason: string; follow_up_story: string }> = {},
): Array<Violation> {
  const p = new Project({ useInMemoryFileSystem: true });
  p.createSourceFile(filePath, code);
  return findSilentDegradationViolations(p, exempted);
}

// A genuinely-silent catch: no stageOutcome, no throw, no log, no record, no marker.
const SILENT = [
  "async function run() {",
  "  try {",
  "    await doWork();",
  "  } catch {",
  "    fallback = true;",
  "  }",
  "}",
].join("\n");

describe("workflow silent-degradation gate", () => {
  it("flags a silent catch in a workflow module (file/line/catchLine anchored on the try)", () => {
    const v = violations(SILENT);
    expect(v).toHaveLength(1);
    expect(v[0]!.file).toBe("apps/backend/src/workflows/x.workflow.ts");
    expect(v[0]!.line).toBe(2); // the `try` statement — the structural anchor (1:1 with the Python)
    expect(v[0]!.catchLine).toBe(4);
  });

  describe("rule 1 — stageOutcome in the try body (any nesting depth)", () => {
    it("passes a bare stageOutcome(...) call nested inside the try body", () => {
      expect(
        violations(`
          async function run() {
            try {
              if (enabled) {
                await stageOutcome("clone", { logger }, async () => doWork());
              }
            } catch {
              fallback = true;
            }
          }`),
      ).toHaveLength(0);
    });

    it("passes a property-access x.stageOutcome(...) call", () => {
      expect(
        violations(`
          async function run() {
            try {
              await helpers.stageOutcome("clone", { logger }, async () => doWork());
            } catch {
              fallback = true;
            }
          }`),
      ).toHaveLength(0);
    });

    it("does NOT credit a stageOutcome call that only appears in the CATCH body", () => {
      expect(
        violations(`
          async function run() {
            try {
              await doWork();
            } catch {
              await stageOutcome("clone", { logger }, async () => undefined);
            }
          }`),
        // The helper must wrap the protected work; rule 3 must not fire either (stageOutcome is
        // neither a log nor a record* call).
      ).toHaveLength(1);
    });
  });

  describe("rule 2 — top-level throw in the catch (strict; conditional does NOT count)", () => {
    it("passes a top-level rethrow", () => {
      expect(
        violations(`
          async function run() {
            try { await doWork(); } catch (e) { aborted = true; throw e; }
          }`),
      ).toHaveLength(0);
    });

    it("passes a top-level `throw new WrappedError(...)`", () => {
      expect(
        violations(`
          async function run() {
            try { await doWork(); } catch (e) { throw new PermanentSinkError(String(e)); }
          }`),
      ).toHaveLength(0);
    });

    it("FLAGS a conditional-only rethrow — the false branch is still a silent swallow", () => {
      expect(
        violations(`
          async function run() {
            try { await doWork(); } catch (e) { if (fatal(e)) throw e; }
          }`),
      ).toHaveLength(1);
    });
  });

  describe("rule 3 — the catch logs at warning+ severity or records the failure", () => {
    it("passes logger.warning / console.warn / workflowLog.warn / console.error", () => {
      for (const call of [
        "logger.warning(String(e))",
        "console.warn(String(e))",
        "workflowLog.warn(String(e))",
        "console.error(String(e))",
      ]) {
        expect(
          violations(`async function run() { try { await doWork(); } catch (e) { ${call}; } }`),
        ).toHaveLength(0);
      }
    });

    it("FLAGS an info/debug-only emit — below operator-visible severity", () => {
      for (const call of ["console.info(String(e))", "logger.debug(String(e))"]) {
        expect(
          violations(`async function run() { try { await doWork(); } catch (e) { ${call}; } }`),
        ).toHaveLength(1);
      }
    });

    it("passes a record* counter emit (bare and property-access)", () => {
      for (const call of [
        'recordStage({ stage: "clone", outcome: "error" })',
        'recordLifecycleSetterFailed({ setter: "finalized" })',
        "metrics.recordHeartbeatFailure()",
      ]) {
        expect(
          violations(`async function run() { try { await doWork(); } catch (e) { ${call}; } }`),
        ).toHaveLength(0);
      }
    });

    it("passes a degradation-notes append; FLAGS an arbitrary array push", () => {
      expect(
        violations(`
          async function run() {
            try { await doWork(); } catch { state.degradation.add("clone_failed"); }
          }`),
      ).toHaveLength(0);
      expect(
        violations(`
          async function run() {
            try { await doWork(); } catch { degradationNotes.push("clone_failed"); }
          }`),
      ).toHaveLength(0);
      // failedSpaces.push(...) records into a local list, not a degradation-notes surface — the
      // real confluence per-space site carries an EXEMPTED entry instead (recorded-in-output).
      expect(
        violations(`
          async function run() {
            try { await doWork(); } catch { failedSpaces.push(key); }
          }`),
      ).toHaveLength(1);
    });

    it("matches the log at any nesting depth inside the catch", () => {
      expect(
        violations(`
          async function run() {
            try { await doWork(); } catch (e) {
              if (!isCancellation(e)) { console.warn(String(e)); }
            }
          }`),
      ).toHaveLength(0);
    });
  });

  describe("rule 4 — top-level abort-propagation (cancellation-channel analogue of throw)", () => {
    it("passes a top-level work.abort(new Error(...))", () => {
      expect(
        violations(`
          async function run() {
            try { await heartbeat(); } catch { work.abort(new Error("heartbeat error")); }
          }`),
      ).toHaveLength(0);
    });

    it("FLAGS a conditional abort — same strictness as rule 2", () => {
      expect(
        violations(`
          async function run() {
            try { await heartbeat(); } catch (e) { if (bad(e)) work.abort(e); }
          }`),
      ).toHaveLength(1);
    });
  });

  describe("rule 5 — the telemetry-emit shape (empty catch guarding one instrument emit)", () => {
    it("passes `try { CONST.add(1) } catch { /* comment */ }` (runner_metrics posture)", () => {
      expect(
        violations(
          "function f() { try { JOBS_TOTAL_COUNTER.add(1, { outcome }); } catch { /* telemetry never perturbs the runner */ } }",
          "apps/backend/src/runner/runner_metrics.ts",
        ),
      ).toHaveLength(0);
      expect(
        violations(
          "function f() { try { CLAIM_LATENCY_HISTOGRAM.record(ms); } catch {} }",
          "apps/backend/src/runner/runner_metrics.ts",
        ),
      ).toHaveLength(0);
    });

    it("FLAGS the shape when the receiver is not a SCREAMING_SNAKE instrument const", () => {
      expect(violations("function f() { try { db.add(row); } catch {} }")).toHaveLength(1);
    });

    it("FLAGS the shape when the try body has more than the single emit", () => {
      expect(
        violations("function f() { try { C_X.add(1); other(); } catch {} }"),
      ).toHaveLength(1);
    });

    it("FLAGS an empty catch guarding non-telemetry work — comments alone never sanction", () => {
      expect(
        violations(`
          async function run() {
            try { await doWork(); } catch { /* best-effort; failure does not matter */ }
          }`),
      ).toHaveLength(1);
    });
  });

  describe("rule 6 — inline `// silent-degradation:exempt reason=... follow_up=...` marker", () => {
    it("passes a marker on the line preceding the try", () => {
      expect(
        violations(`
          async function run() {
            // silent-degradation:exempt reason=fail-open-by-design follow_up=PERMANENT-EXEMPTION-x
            try { await doWork(); } catch { fallback = true; }
          }`),
      ).toHaveLength(0);
    });

    it("passes a marker on the catch line", () => {
      expect(
        violations(`
          async function run() {
            try {
              await doWork();
            } catch { // silent-degradation:exempt reason=fail-open follow_up=S16.X-some-fix
              fallback = true;
            }
          }`),
      ).toHaveLength(0);
    });

    it("FLAGS a malformed marker missing follow_up= (both fields are mandatory)", () => {
      expect(
        violations(`
          async function run() {
            // silent-degradation:exempt reason=fail-open-by-design
            try { await doWork(); } catch { fallback = true; }
          }`),
      ).toHaveLength(1);
      expect(MARKER_RE.test("silent-degradation:exempt reason=x")).toBe(false);
      expect(MARKER_RE.test("silent-degradation:exempt reason=x follow_up=S16.X-y")).toBe(true);
    });
  });

  describe("rule 7 — EXEMPTED registry, keyed <repo-relative-path>::<try-line>", () => {
    it("exempts a registered site (key anchored on the try line)", () => {
      expect(
        violations(SILENT, "apps/backend/src/workflows/x.workflow.ts", {
          "apps/backend/src/workflows/x.workflow.ts::2": {
            symbol: "run",
            reason: "fixture",
            follow_up_story: "PERMANENT-EXEMPTION-fixture",
          },
        }),
      ).toHaveLength(0);
    });

    it("does NOT exempt when the line key has drifted", () => {
      expect(
        violations(SILENT, "apps/backend/src/workflows/x.workflow.ts", {
          "apps/backend/src/workflows/x.workflow.ts::99": {
            symbol: "run",
            reason: "fixture",
            follow_up_story: "PERMANENT-EXEMPTION-fixture",
          },
        }),
      ).toHaveLength(1);
    });

    it("every real registry entry carries the documented shape (symbol + reason + story id)", () => {
      for (const [key, entry] of Object.entries(EXEMPTED)) {
        expect(key).toMatch(/^apps\/backend\/src\/(?:workflows|review\/pipeline|runner)\/.+\.ts::\d+$/);
        expect(entry.symbol.length).toBeGreaterThan(0);
        expect(entry.reason.length).toBeGreaterThan(20);
        // The meta-gate (check_exempted_lists_pointed) enforces the story-id grammar; this pins the
        // day-one posture that every ported entry is a judged PERMANENT by-design pattern.
        expect(entry.follow_up_story).toMatch(/^PERMANENT-EXEMPTION-[\w-]+$/);
      }
    });
  });

  describe("structural boundaries", () => {
    it("ignores try/finally without a catch — nothing is swallowed", () => {
      expect(
        violations(`
          async function run() {
            try { await doWork(); } finally { cleanup(); }
          }`),
      ).toHaveLength(0);
    });

    it("flags a nested silent catch inside an otherwise-compliant outer catch", () => {
      const v = violations(`
        async function run() {
          try {
            await doWork();
          } catch (e) {
            try { await bestEffortAudit(); } catch { ignored = true; }
            throw e;
          }
        }`);
      expect(v).toHaveLength(1);
      expect(v[0]!.line).toBe(6); // the INNER try — the outer is compliant via top-level throw
    });

    it("does not scan promise .catch(...) method calls (v1 boundary, like the Python ast.Try scope)", () => {
      expect(
        violations(`
          async function run() {
            const ok = await renew().catch(() => true);
            void ok;
          }`),
      ).toHaveLength(0);
    });
  });

  describe("scope — workflow/pipeline/runner production code only", () => {
    it("scans all three surfaces, including nested runner/handlers", () => {
      for (const f of [
        "apps/backend/src/workflows/x.workflow.ts",
        "apps/backend/src/review/pipeline/posting.ts",
        "apps/backend/src/runner/scheduler.ts",
        "apps/backend/src/runner/handlers/cron_handlers.ts",
      ]) {
        expect(violations(SILENT, f), f).toHaveLength(1);
      }
    });

    it("does NOT scan tests, scripts, repos, or out-of-surface production code", () => {
      for (const f of [
        "test/integration/runner/x.test.ts",
        "test/gates/x.ts",
        "scripts/gates/x.ts",
        "apps/backend/src/runner/review_jobs_repo.ts", // repos are out of scope (Python plan §)
        "apps/backend/src/runner/x.test.ts",
        "apps/backend/src/domain/repos/x.ts",
        "apps/backend/src/review/activities.ts", // review/ outside pipeline/ is out of scope
        "libs/platform/src/clock.ts",
      ]) {
        expect(violations(SILENT, f), f).toHaveLength(0);
      }
    });

    it("isScopedSource agrees on absolute real-tree paths", () => {
      expect(isScopedSource("/r/apps/backend/src/workflows/x.workflow.ts")).toBe(true);
      expect(isScopedSource("/r/apps/backend/src/review/pipeline/x.ts")).toBe(true);
      expect(isScopedSource("/r/apps/backend/src/runner/handlers/x.ts")).toBe(true);
      expect(isScopedSource("/r/apps/backend/src/runner/x.test.ts")).toBe(false);
      expect(isScopedSource("/r/apps/backend/src/runner/background_jobs_repo.ts")).toBe(false);
      expect(isScopedSource("/r/apps/backend/src/review/orchestrator_helpers.ts")).toBe(false);
      expect(isScopedSource("/r/test/integration/runner/x.ts")).toBe(false);
    });
  });

  describe("real-repo smoke", () => {
    // Scan the ACTUAL three surfaces (not fixtures). Heavier than the fixture tests but the load-
    // bearing assertion: the gate is green against the current tree, is not vacuously green, and
    // every EXEMPTED entry still anchors a real silent site (line drift fails HERE, loudly,
    // instead of silently un-exempting an entry — the Python registry documented exactly that
    // line-shift failure mode by hand).
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

    function realProject(): Project {
      const p = new Project({
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: true,
      });
      p.addSourceFilesAtPaths([
        path.join(repoRoot, "apps/backend/src/workflows/**/*.ts"),
        path.join(repoRoot, "apps/backend/src/review/pipeline/**/*.ts"),
        path.join(repoRoot, "apps/backend/src/runner/**/*.ts"),
      ]);
      return p;
    }

    it("the current tree passes the gate (0 violations with the registry applied)", () => {
      const v = findSilentDegradationViolations(realProject());
      const report = v.map((x) => `  ${x.file}:${x.line} (catch at ${x.catchLine})`).join("\n");
      expect(
        v,
        v.length === 0
          ? ""
          : `silent-degradation regression — wrap in stageOutcome, rethrow, log/record, or ` +
              `exempt with a documented marker. Offending sites:\n${report}`,
      ).toHaveLength(0);
    });

    it("raw violations (registry bypassed) anchor EXACTLY the EXEMPTED keys — no drift, no new silent sites", () => {
      const raw = findSilentDegradationViolations(realProject(), {})
        .map((x) => `${x.file}::${x.line}`)
        .sort();
      expect(raw).toEqual(Object.keys(EXEMPTED).sort());
      expect(raw.length).toBeGreaterThan(0); // the smoke is not vacuous
    });

    it("scans a non-empty surface (guard against the glob silently matching nothing)", () => {
      expect(realProject().getSourceFiles().length).toBeGreaterThan(0);
    });
  });
});
