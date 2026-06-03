import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 / review_findings.v1
// templates.
const PY = "contracts.static_analysis_result.v1";

// Each embedded ReviewFindingV1 in `findings` carries the bare-float `confidence` column. Pydantic
// model_dump(mode="json") emits it as `1.0` while a JS number `1` emits `1`, so the repo canonicalizer
// (test/parity/canonical.ts) REJECTS bare floats and can never byte-match that column. Strip every
// nested `findings[].confidence` from the parsed object BEFORE canonicalizing so the canonicalizer is
// never handed a bare float, and assert the confidence values structurally afterward. Same approach as
// review_findings.v1.parity.test.ts::dropConfidence, lifted to the nested-array shape.
function dropFindingConfidence(obj: Record<string, unknown>): Record<string, unknown> {
  const findings = obj["findings"];
  if (!Array.isArray(findings)) return obj;
  const stripped = findings.map((f) => {
    const copy = { ...(f as Record<string, unknown>) };
    delete copy["confidence"];
    return copy;
  });
  return { ...obj, findings: stripped };
}

// A valid ReviewFindingV1 payload (per contracts/review_findings/v1.py). confidence is an int that
// Pydantic coerces to float; the helper above strips it before the canonical diff.
const REVIEW_FINDING = {
  file: "src/app.py",
  start_line: 10,
  end_line: 20,
  severity: "issue",
  category: "bug",
  title: "Null deref",
  body: "Dereferences a possibly-null pointer.",
  suggestion: "Add a guard.",
  confidence: 1,
  sources: [{ kind: "repo_path", locator: "src/app.py", excerpt: "def f():" }],
  scope: "cross_chunk",
  evidence_refs: ["ev_0123456789abcdef"],
};

// A valid AnalysisFindingV1 payload (per contracts/analysis_findings/v1.py). finding_id is a required
// canonical-LOWERCASE UUID (Pydantic lowercases on dump; keep it lowercase to avoid a spurious diff).
const TIER1_FINDING = {
  finding_id: "0123abcd-4567-89ab-cdef-0123456789ab",
  tool: "ruff",
  rule_id: "E501",
  file: "src/app.py",
  start_line: 1,
  end_line: 1,
  severity_raw: "warning",
  message: "line too long",
};

// A valid ToolStatusV1 payload (per contracts/tool_status/v1.py). RFC3339 datetimes are auto-normalized
// by both canonicalizers.
const TOOL_STATUS = {
  tool_name: "ruff",
  status: "completed",
  files_scanned: 5,
  files_total: 5,
  started_at: "2026-06-03T10:00:00+00:00",
  finished_at: "2026-06-03T10:00:01+00:00",
  duration_ms: 1000,
  findings_produced: 3,
};

describe("StaticAnalysisResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full nested payload identically (findings.confidence excepted)", async () => {
    const payload = {
      schema_version: 1,
      findings: [REVIEW_FINDING],
      per_tool_errors: { ruff: "boom", eslint: "timeout" },
      curator_skipped: false,
      truncated_per_tool: { eslint: 100, ruff: 0 },
      tier1_findings: [TIER1_FINDING],
      tool_statuses: [TOOL_STATUS],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "StaticAnalysisResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodObj = StaticAnalysisResultV1.parse(payload) as Record<string, unknown>;
    const pyObj = JSON.parse(r.out!) as Record<string, unknown>;
    // Every field except the nested float `findings[].confidence` is byte-equal between the two sides.
    expect(canonicalize(dropFindingConfidence(zodObj))).toBe(canonicalize(dropFindingConfidence(pyObj)));
    // confidence still round-trips structurally on both sides.
    const zodConf = (zodObj["findings"] as Array<{ confidence: number }>)[0]!.confidence;
    const pyConf = (pyObj["findings"] as Array<{ confidence: number }>)[0]!.confidence;
    expect(zodConf).toBe(1);
    expect(pyConf).toBe(1);
  }, 30_000);

  it("applies all the same defaults when every optional field is omitted", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "StaticAnalysisResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodObj = StaticAnalysisResultV1.parse(payload) as Record<string, unknown>;
    expect(canonicalize(zodObj)).toBe(r.out);
    // Defaults: schema_version=1, findings=[], per_tool_errors={}, curator_skipped=true,
    // truncated_per_tool={}, tier1_findings=[], tool_statuses=[].
    expect(zodObj["schema_version"]).toBe(1);
    expect(zodObj["findings"]).toEqual([]);
    expect(zodObj["per_tool_errors"]).toEqual({});
    expect(zodObj["curator_skipped"]).toBe(true);
    expect(zodObj["truncated_per_tool"]).toEqual({});
    expect(zodObj["tier1_findings"]).toEqual([]);
    expect(zodObj["tool_statuses"]).toEqual([]);
  }, 30_000);

  it("validates + dumps an empty-collections explicit payload identically", async () => {
    const payload = {
      schema_version: 1,
      findings: [],
      per_tool_errors: {},
      curator_skipped: true,
      truncated_per_tool: {},
      tier1_findings: [],
      tool_statuses: [],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "StaticAnalysisResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(StaticAnalysisResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts a forward-compat schema_version=2 envelope on both sides (bare int, not literal)", async () => {
    const payload = { schema_version: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: "StaticAnalysisResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(StaticAnalysisResultV1.parse(payload))).toBe(r.out);
    expect((StaticAnalysisResultV1.parse(payload) as { schema_version: number }).schema_version).toBe(2);
  }, 30_000);

  it("both REJECT a negative truncated_per_tool count (_NonNegativeInt: ge=0)", async () => {
    const bad = { truncated_per_tool: { eslint: -1 } };
    const r = await pyRef({ pyModule: PY, pyCallable: "StaticAnalysisResultV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => StaticAnalysisResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-int truncated_per_tool count", async () => {
    const bad = { truncated_per_tool: { eslint: 1.5 } };
    const r = await pyRef({ pyModule: PY, pyCallable: "StaticAnalysisResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => StaticAnalysisResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a nested invalid ReviewFindingV1 (start_line < 1) inside findings", async () => {
    const bad = {
      findings: [{ ...REVIEW_FINDING, start_line: 0, end_line: 0 }],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "StaticAnalysisResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => StaticAnalysisResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a nested invalid ToolStatusV1 (files_scanned > files_total) inside tool_statuses", async () => {
    const bad = {
      tool_statuses: [{ ...TOOL_STATUS, files_scanned: 6, files_total: 5 }],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "StaticAnalysisResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => StaticAnalysisResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "StaticAnalysisResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => StaticAnalysisResultV1.parse(bad)).toThrow();
  }, 30_000);
});
