// Unit tests for the STAGE-1 empty-valid `staticAnalysis` activity port.
//
// Stage 1a ships the structurally-faithful "no-tools-configured" result: the activity accepts the real
// typed input envelope (workspace_path + sandbox_files + changed_line_ranges + pr_meta) and returns a
// well-formed StaticAnalysisResultV1 with EMPTY collections — no Ruff/ESLint/Gitleaks runner fires (those
// land in Stage 4). This is NOT a hidden stub of behavior; it is the faithful result when no tool is
// configured, identical to what the frozen Python returns on the empty-file-routing fast path
// (StaticAnalysisResultV1() — see vendor/codemaster-py/codemaster/activities/static_analysis.py).
//
// The load-bearing assertions:
//  (1) the return PARSES as a StaticAnalysisResultV1 (the orchestrator's dedup/aggregate/fan-out path
//      re-validates the wire dict with extra="forbid"; a malformed shape would crash Step 3b);
//  (2) every collection is EMPTY (findings / per_tool_errors / curator_skipped=true / truncated_per_tool /
//      tier1_findings / tool_statuses) — byte-identical to the frozen Python's default envelope;
//  (3) the activity tolerates the real input's structural shape (populated sandbox_files +
//      changed_line_ranges + pr_meta) without inspecting it — the no-tools result is invariant in the
//      payload at Stage 1.

import { describe, expect, it } from "vitest";

import { staticAnalysis } from "#backend/activities/static_analysis.activity.js";

import { StaticAnalysisInputV1 } from "#contracts/static_analysis_input.v1.js";
import { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";

// A fully-populated valid PrMetaV1 payload (per contracts/walkthrough/pr_meta_v1.py). pr_id /
// installation_id are canonical-lowercase UUIDs.
const PR_META = {
  pr_id: "0123abcd-4567-89ab-cdef-0123456789ab",
  installation_id: "0123abcd-4567-89ab-cdef-0123456789ac",
  repo: "octo/widgets",
  pr_title: "Add the thing",
  pr_description: "A change that adds the thing.",
};

describe("staticAnalysis (Stage-1 empty-valid placeholder)", () => {
  it("returns a well-formed StaticAnalysisResultV1 that the dedup/aggregate path accepts", async () => {
    const input = StaticAnalysisInputV1.parse({
      workspace_path: "/tmp/ws-abc",
      sandbox_files: ["src/app.py", "src/util.ts"],
      changed_line_ranges: { "src/app.py": [[10, 20]], "src/util.ts": [[1, 5]] },
      pr_meta: PR_META,
    });

    const result = await staticAnalysis(input);

    // The activity already returns the typed shape; re-parsing through the strict (extra=forbid) output
    // contract proves the orchestrator's Step-3b round-trip (StaticAnalysisResultV1.model_validate)
    // accepts it. .strict() throws on any drift.
    expect(() => StaticAnalysisResultV1.parse(result)).not.toThrow();
  });

  it("emits the empty-valid no-tools envelope (every collection empty; defaults match frozen Python)", async () => {
    const input = StaticAnalysisInputV1.parse({
      workspace_path: "/tmp/ws-abc",
      sandbox_files: ["a.py"],
      changed_line_ranges: { "a.py": [[1, 1]] },
      pr_meta: PR_META,
    });

    const result = await staticAnalysis(input);

    // Byte-for-byte the frozen Python StaticAnalysisResultV1() default envelope: schema_version=1,
    // findings=[], per_tool_errors={}, curator_skipped=true, truncated_per_tool={}, tier1_findings=[],
    // tool_statuses=[].
    expect(result.schema_version).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.per_tool_errors).toEqual({});
    expect(result.curator_skipped).toBe(true);
    expect(result.truncated_per_tool).toEqual({});
    expect(result.tier1_findings).toEqual([]);
    expect(result.tool_statuses).toEqual([]);
  });

  it("returns the same empty envelope when sandbox_files is empty (empty-routing fast path)", async () => {
    const input = StaticAnalysisInputV1.parse({
      workspace_path: "/tmp/ws-empty",
      sandbox_files: [],
      changed_line_ranges: {},
      pr_meta: PR_META,
    });

    const result = await staticAnalysis(input);

    // The empty-file-routing path in the frozen Python returns StaticAnalysisResultV1() too — at Stage 1
    // the populated and empty inputs converge on the identical no-tools result.
    expect(() => StaticAnalysisResultV1.parse(result)).not.toThrow();
    expect(result.findings).toEqual([]);
    expect(result.tier1_findings).toEqual([]);
    expect(result.tool_statuses).toEqual([]);
  });

  it("does not mutate / depend on the input payload (no-tools result is payload-invariant at Stage 1)", async () => {
    const inputA = StaticAnalysisInputV1.parse({
      workspace_path: "/tmp/ws-a",
      sandbox_files: ["x.py", "y.go", "z.rs"],
      changed_line_ranges: { "x.py": [[1, 100]], "y.go": [[2, 3]] },
      pr_meta: PR_META,
    });
    const inputB = StaticAnalysisInputV1.parse({
      workspace_path: "/tmp/ws-b",
      sandbox_files: [],
      changed_line_ranges: {},
      pr_meta: { ...PR_META, repo: "octo/other" },
    });

    const a = await staticAnalysis(inputA);
    const b = await staticAnalysis(inputB);

    // Structurally identical regardless of the input — confirms the Stage-1 result carries NO derived
    // state from the payload (the runners that WOULD derive findings land in Stage 4).
    expect(a).toEqual(b);
  });
});
