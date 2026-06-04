import { afterAll, describe, expect, it } from "vitest";

import { pyDoAggregate, shutdownAggregateRef, type FindingInput } from "./aggregate_oracle.js";
import { canonicalize } from "./canonical.js";
import { doAggregate } from "#backend/activities/aggregate_findings.activity.js";
import { AggregateFindingsInputV1 } from "#contracts/aggregate_findings.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

afterAll(() => {
  shutdownAggregateRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS `doAggregate` pipeline (scope-consistency → exact-dedup → semantic-skip →
// rank+cap) is byte-equal to the frozen Python `_do_aggregate` (vendor/codemaster-py/codemaster/review/
// aggregate_activity.py), driven over the dedicated ref (tools/parity/run_aggregate_ref.py).
//
// The frozen Python is driven with a FAILING embedder (forced fail-open), so its `semantic_skipped`
// behaviour matches the TS no-embedder skip path for every input: False when fewer than 2 findings reach
// the semantic stage (Python `len < 2` early return), True otherwise.
//
// `confidence` is a bare Python float that cannot byte-round-trip through the canonicalizer (1.0 vs "1");
// it is STRIPPED from the canonical compare on both sides (`stripConfidence`) and asserted STRUCTURALLY
// (`expectConfidenceParity`) — the established bare-float handling.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Build one finding wire dict (the shape `ReviewFindingV1(**dict)` / `ReviewFindingV1.parse` accept). */
function f(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    file: "a.py",
    start_line: 1,
    end_line: 1,
    severity: "issue",
    category: "bug",
    title: "t",
    body: "b",
    confidence: 0.5,
    ...overrides,
  };
}

/** Deep-clone a value with every `confidence` key removed, so the canonical compare ignores the bare
 *  float (Python serializes 1.0; JS serializes 1). Recurses into the nested findings list. */
function stripConfidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripConfidence);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "confidence") continue;
      out[k] = stripConfidence(v);
    }
    return out;
  }
  return value;
}

/** The confidence floats of each finding, in order — the structural assertion the canonical strip omits. */
function confidences(envelope: Record<string, unknown>): Array<number> {
  const findings = envelope["findings"] as Array<Record<string, unknown>>;
  return findings.map((x) => x["confidence"] as number);
}

/**
 * Run the SAME findings through the TS pipeline and the frozen Python, and assert byte-equality of the
 * whole `AggregatedFindingsV1` envelope (findings list + ORDER + dedupe_stats + policy_revision), with
 * `confidence` stripped from the canonical diff and asserted structurally. Returns the Python envelope so
 * a caller can make extra structural assertions (e.g. on dedupe_stats counts).
 */
async function assertParity(
  findings: ReadonlyArray<FindingInput>,
  policyRevision: number,
): Promise<AggregatedDictLocal> {
  // Parse each finding through the ported contract first — mirrors the Python driver's
  // `ReviewFindingV1(**dict)`, applying the contract defaults (sources / scope / evidence_refs) before
  // the pipeline consumes them.
  const parsed = findings.map((d) => ReviewFindingV1.parse(d));
  const ts = doAggregate(parsed, policyRevision) as unknown as Record<string, unknown>;
  const py = (await pyDoAggregate(findings, policyRevision)) as Record<string, unknown>;

  // Byte-equal envelope (confidence stripped). canonicalize key-sorts recursively + normalizes scalars.
  expect(canonicalize(stripConfidence(ts))).toBe(canonicalize(stripConfidence(py)));
  // Confidence floats match structurally, in order.
  expect(confidences(ts)).toEqual(confidences(py));
  return py as AggregatedDictLocal;
}

type AggregatedDictLocal = {
  readonly findings: ReadonlyArray<Record<string, unknown>>;
  readonly dedupe_stats: Record<string, unknown>;
  readonly policy_revision: number;
};

describe("aggregate_findings _do_aggregate parity (Pydantic ↔ TS)", () => {
  it("passthrough — distinct findings, no dups, no caps", async () => {
    const findings = [
      f({ start_line: 1, end_line: 1, body: "one", confidence: 0.3 }),
      f({ start_line: 5, end_line: 5, body: "two", confidence: 0.9 }),
    ];
    const py = await assertParity(findings, 7);
    expect(py.dedupe_stats["exact_dropped"]).toBe(0);
    expect(py.dedupe_stats["semantic_merged"]).toBe(0);
    expect(py.dedupe_stats["capped"]).toBe(0);
    // 2 distinct findings reach the semantic stage → skip flag True (Python embedder-failure fail-open).
    expect(py.dedupe_stats["semantic_skipped"]).toBe(true);
  }, 30_000);

  it("exact-dedup — 2 identical (same file/lines/category) collapse to 1, exact_dropped=1", async () => {
    const findings = [f({ body: "same" }), f({ body: "same" })];
    const py = await assertParity(findings, 1);
    expect(py.findings).toHaveLength(1);
    expect(py.dedupe_stats["exact_dropped"]).toBe(1);
    // After exact-dedup only 1 finding reaches the semantic stage → len<2 early return → skip False.
    expect(py.dedupe_stats["semantic_skipped"]).toBe(false);
  }, 30_000);

  it("exact-dedup — distinct bodies on same key union by separator + take max severity/confidence", async () => {
    const findings = [
      f({ body: "first body", severity: "nit", confidence: 0.2 }),
      f({ body: "second body", severity: "blocker", confidence: 0.8 }),
    ];
    const py = await assertParity(findings, 2);
    expect(py.findings).toHaveLength(1);
    const merged = py.findings[0]!;
    expect(merged["body"]).toBe("first body\n---\nsecond body");
    expect(merged["severity"]).toBe("blocker");
    expect(merged["confidence"]).toBe(0.8);
  }, 30_000);

  it("scope-drop — a non-chunk_observed finding is dropped before aggregation", async () => {
    const findings = [
      f({ body: "keep", scope: "chunk_observed" }),
      f({ body: "drop", scope: "cross_chunk", start_line: 2, end_line: 2 }),
    ];
    const py = await assertParity(findings, 3);
    // The cross_chunk finding is structurally dropped; only the chunk_observed one survives.
    expect(py.findings).toHaveLength(1);
    expect(py.findings[0]!["body"]).toBe("keep");
    // input_count counts pre-drop; the drop is NOT counted in exact_dropped (scope-drop is separate).
    expect(py.dedupe_stats["input_count"]).toBe(2);
    expect(py.dedupe_stats["exact_dropped"]).toBe(0);
  }, 30_000);

  it("rank_and_cap — 12 findings in one file exceed PER_FILE_CAP(10) → capped=2, rank order preserved", async () => {
    const findings = Array.from({ length: 12 }, (_, k) =>
      f({
        start_line: k + 1,
        end_line: k + 1,
        body: `b${k + 1}`,
        severity: "nit",
        confidence: 0.1 + 0.01 * (k + 1),
      }),
    );
    const py = await assertParity(findings, 5);
    expect(py.findings).toHaveLength(10);
    expect(py.dedupe_stats["capped"]).toBe(2);
  }, 30_000);

  it("rank order — severity desc, then confidence desc, then stable input index", async () => {
    const findings = [
      f({ start_line: 1, end_line: 1, body: "b1", severity: "nit", confidence: 0.9 }),
      f({ start_line: 2, end_line: 2, body: "b2", severity: "blocker", confidence: 0.1 }),
      f({ start_line: 3, end_line: 3, body: "b3", severity: "issue", confidence: 0.8 }),
      f({ start_line: 4, end_line: 4, body: "b4", severity: "blocker", confidence: 0.9 }),
    ];
    const py = await assertParity(findings, 1);
    // blocker/0.9 (idx3) > blocker/0.1 (idx1) > issue/0.8 (idx2) > nit/0.9 (idx0).
    expect(py.findings.map((x) => x["severity"])).toEqual(["blocker", "blocker", "issue", "nit"]);
    expect(py.findings.map((x) => x["start_line"])).toEqual([4, 2, 3, 1]);
  }, 30_000);

  it("empty findings → empty output + zeroed stats + semantic_skipped False", async () => {
    const py = await assertParity([], 0);
    expect(py.findings).toHaveLength(0);
    expect(py.dedupe_stats).toEqual({
      input_count: 0,
      exact_dropped: 0,
      semantic_merged: 0,
      capped: 0,
      semantic_skipped: false,
    });
  }, 30_000);

  it("single finding → semantic stage short-circuits (len<2) → semantic_skipped False", async () => {
    const py = await assertParity([f({ body: "solo" })], 4);
    expect(py.findings).toHaveLength(1);
    expect(py.dedupe_stats["semantic_skipped"]).toBe(false);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// AggregateFindingsInputV1 — the NEW typed envelope introduced during the port (CLAUDE.md invariant 11 /
// ADR-0047 closure of the Python 2-positional dispatch). There is NO Python counterpart to byte-diff, so
// this covers round-trip + validation only.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AggregateFindingsInputV1 envelope (no Python counterpart — validation only)", () => {
  it("accepts a valid {findings, policy_revision} and applies the schema_version default", () => {
    const parsed = AggregateFindingsInputV1.parse({
      findings: [f({ body: "x" })],
      policy_revision: 7,
    });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.policy_revision).toBe(7);
    expect(parsed.findings).toHaveLength(1);
    // The nested finding got the ReviewFindingV1 defaults.
    expect(parsed.findings[0]!.scope).toBe("chunk_observed");
    expect(parsed.findings[0]!.sources).toEqual([]);
    expect(parsed.findings[0]!.evidence_refs).toEqual([]);
  });

  it("accepts empty findings", () => {
    const parsed = AggregateFindingsInputV1.parse({ findings: [], policy_revision: 0 });
    expect(parsed.findings).toHaveLength(0);
  });

  it("rejects unknown top-level keys (.strict())", () => {
    expect(() =>
      AggregateFindingsInputV1.parse({ findings: [], policy_revision: 0, bogus: true }),
    ).toThrow();
  });

  it("rejects a non-integer policy_revision", () => {
    expect(() =>
      AggregateFindingsInputV1.parse({ findings: [], policy_revision: 1.5 }),
    ).toThrow();
  });

  it("rejects a finding that violates the ReviewFindingV1 contract (end_line < start_line)", () => {
    expect(() =>
      AggregateFindingsInputV1.parse({
        findings: [f({ start_line: 5, end_line: 1 })],
        policy_revision: 0,
      }),
    ).toThrow();
  });
});
