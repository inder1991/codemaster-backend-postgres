import { afterAll, describe, expect, it } from "vitest";

import {
  pyAggregateSemantic,
  shutdownAggregateSemanticRef,
  type FindingInput,
  type VectorTable,
} from "./aggregate_semantic_oracle.js";
import { canonicalize } from "./canonical.js";
import {
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingsPort,
  EmbeddingsConnectivityError,
} from "#backend/adapters/embeddings_port.js";
import { aggregateSemantic } from "#backend/review/aggregation_semantic.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

afterAll(() => {
  shutdownAggregateSemanticRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS `aggregateSemantic` cosine-merge branch is byte-equal to the frozen Python
// `aggregate_semantic` (vendor/codemaster-py/codemaster/review/aggregation_semantic.py), driven over the
// dedicated ref (tools/parity/run_aggregate_semantic_ref.py).
//
// THE PARITY-EMBEDDER APPROACH: the Python `RecordingEmbeddingsClient` is NOT cross-language reproducible
// (abs(hash) + Mersenne-Twister). So BOTH sides embed via an EXPLICIT body->vector table: the Python
// driver's `_TableEmbedder` and the TS `TableEmbeddingsClient` below look up the SAME vector per body.
// The cosine of any pair is therefore identical across runtimes, so the merge decisions (merge/no-merge,
// absorb direction, body join) are deterministic and parity-significant.
//
// Controlled cosine geometry (3-dim explicit vectors, all unit or orthogonal):
//   X = [1,0,0]   Y = [0,1,0]   Z = [0,0,1]
//   cos(X,X) = 1.0  (≥ 0.92 → MERGE)
//   cos(X,Y) = 0.0  (<  0.92 → NO merge)
// Same-file X/X pairs merge; cross-file X/X pairs do NOT (same-file guard); X/Y pairs never merge.
//
// `confidence` is a bare Python float that cannot byte-round-trip through the canonicalizer (1.0 vs "1");
// it is STRIPPED from the canonical compare on both sides and asserted STRUCTURALLY (the established
// bare-float handling, shared with aggregate.parity.test.ts).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const X: ReadonlyArray<number> = [1, 0, 0];
const Y: ReadonlyArray<number> = [0, 1, 0];
const Z: ReadonlyArray<number> = [0, 0, 1];

/**
 * TS test double: an {@link EmbeddingsPort} that returns explicit per-body vectors from a table — the TS
 * twin of the Python driver's `_TableEmbedder`. Records every call. NOT a production path (test file only;
 * production embeds over HTTP via the real adapters).
 */
class TableEmbeddingsClient implements EmbeddingsPort {
  public readonly calls: Array<EmbedRequest> = [];
  private readonly table: VectorTable;
  private readonly fail: boolean;
  private readonly wrongCount: boolean;

  public constructor(opts: { table: VectorTable; fail?: boolean; wrongCount?: boolean }) {
    this.table = opts.table;
    this.fail = opts.fail ?? false;
    this.wrongCount = opts.wrongCount ?? false;
  }

  public async embed(req: EmbedRequest): Promise<EmbedResult> {
    this.calls.push(req);
    if (this.fail) {
      throw new EmbeddingsConnectivityError("table embedder: forced failure (fail-open)");
    }
    let vectors: Array<ReadonlyArray<number>> = req.texts.map((t) => {
      const vec = this.table[t];
      if (vec === undefined) {
        throw new Error(`TableEmbeddingsClient: no vector for body ${JSON.stringify(t)}`);
      }
      return vec;
    });
    if (this.wrongCount && vectors.length > 0) {
      vectors = vectors.slice(0, -1);
    }
    return { vectors, model_name: req.model_name, model_version: "parity-v1", cache_hits: 0 };
  }
}

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

/** Deep-clone with every `confidence` key removed (Python serializes 1.0; JS serializes 1). */
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
function confidences(findings: ReadonlyArray<Record<string, unknown>>): Array<number> {
  return findings.map((x) => x["confidence"] as number);
}

type SemanticTsResult = {
  readonly findings: ReadonlyArray<Record<string, unknown>>;
  readonly semantic_skipped: boolean;
};

/**
 * Drive the SAME findings + vector table through the TS `aggregateSemantic` and the frozen Python, and
 * assert byte-equality of the merged finding list (+ ORDER) and the skipped flag, with `confidence`
 * stripped from the canonical diff and asserted structurally. Returns both results for extra assertions.
 */
async function assertParity(
  findings: ReadonlyArray<FindingInput>,
  opts: { table?: VectorTable; fail?: boolean; wrongCount?: boolean; threshold?: number } = {},
): Promise<{ ts: SemanticTsResult; py: SemanticResultLocal }> {
  const parsed = findings.map((d) => ReviewFindingV1.parse(d));
  // TS side: a real EmbeddingsPort double driven by the same table. `fail` → the double throws, which
  // exercises the catch/fail-open branch (parity with the Python `fail`).
  const embedder = new TableEmbeddingsClient({
    table: opts.table ?? {},
    ...(opts.fail !== undefined ? { fail: opts.fail } : {}),
    ...(opts.wrongCount !== undefined ? { wrongCount: opts.wrongCount } : {}),
  });
  const semOpts = opts.threshold !== undefined ? { threshold: opts.threshold } : {};
  const [tsFindings, tsSkipped] = await aggregateSemantic(parsed, embedder, semOpts);
  const ts: SemanticTsResult = {
    findings: tsFindings as unknown as ReadonlyArray<Record<string, unknown>>,
    semantic_skipped: tsSkipped,
  };

  const py = (await pyAggregateSemantic(findings, {
    ...(opts.table !== undefined ? { vectors: opts.table } : {}),
    ...(opts.fail !== undefined ? { fail: opts.fail } : {}),
    ...(opts.wrongCount !== undefined ? { wrongCount: opts.wrongCount } : {}),
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
  })) as SemanticResultLocal;

  // Byte-equal merged findings (confidence stripped) + identical skip flag.
  expect(canonicalize(stripConfidence(ts.findings))).toBe(canonicalize(stripConfidence(py.findings)));
  expect(ts.semantic_skipped).toBe(py.semantic_skipped);
  // Confidence floats match structurally, in order.
  expect(confidences(ts.findings)).toEqual(confidences(py.findings));
  return { ts, py };
}

type SemanticResultLocal = {
  readonly findings: ReadonlyArray<Record<string, unknown>>;
  readonly semantic_skipped: boolean;
};

describe("aggregate_semantic cosine-merge parity (Pydantic ↔ TS)", () => {
  it("fewer than 2 findings → early return, no embed, semantic_skipped False", async () => {
    const findings = [f({ body: "solo" })];
    const { py } = await assertParity(findings, { table: { solo: X } });
    expect(py.findings).toHaveLength(1);
    expect(py.semantic_skipped).toBe(false);
  }, 30_000);

  it("embedder error → fail-open pass-through, semantic_skipped True", async () => {
    const findings = [f({ body: "one" }), f({ body: "two", start_line: 5, end_line: 5 })];
    const { py } = await assertParity(findings, { fail: true });
    // Input passed through unchanged, both findings survive, skip recorded.
    expect(py.findings).toHaveLength(2);
    expect(py.semantic_skipped).toBe(true);
    expect(py.findings.map((x) => x["body"])).toEqual(["one", "two"]);
  }, 30_000);

  it("vector-count mismatch → fail-open pass-through, semantic_skipped True", async () => {
    const findings = [f({ body: "one" }), f({ body: "two", start_line: 5, end_line: 5 })];
    const { py } = await assertParity(findings, {
      table: { one: X, two: X },
      wrongCount: true,
    });
    expect(py.findings).toHaveLength(2);
    expect(py.semantic_skipped).toBe(true);
  }, 30_000);

  it("real merge — 2 same-file near-duplicates (cosine 1.0 ≥ 0.92) collapse to 1", async () => {
    const findings = [
      f({ body: "first finding", confidence: 0.3 }),
      f({ body: "second finding", start_line: 5, end_line: 5, confidence: 0.9 }),
    ];
    const { py } = await assertParity(findings, {
      table: { "first finding": X, "second finding": X },
    });
    expect(py.findings).toHaveLength(1);
    expect(py.semantic_skipped).toBe(false);
    // Higher-confidence (0.9, second) absorbs the lower → ABSORBER fields follow `second`:
    //   file/lines/title/suggestion follow the absorber; body = absorber + sep + absorbed.
    const merged = py.findings[0]!;
    expect(merged["start_line"]).toBe(5);
    expect(merged["body"]).toBe("second finding\n---\nfirst finding");
    expect(merged["confidence"]).toBe(0.9);
  }, 30_000);

  it("cross-file near-duplicate (cosine 1.0) does NOT merge (same-file guard)", async () => {
    const findings = [
      f({ file: "a.py", body: "dup body", confidence: 0.3 }),
      f({ file: "b.py", body: "dup body other", confidence: 0.9 }),
    ];
    const { py } = await assertParity(findings, {
      table: { "dup body": X, "dup body other": X }, // identical vectors, but different files
    });
    // Both survive — the cross-file pair is never considered for merge.
    expect(py.findings).toHaveLength(2);
    expect(py.semantic_skipped).toBe(false);
    expect(py.findings.map((x) => x["file"])).toEqual(["a.py", "b.py"]);
  }, 30_000);

  it("below-threshold pair (cosine 0.0 < 0.92) does NOT merge", async () => {
    const findings = [
      f({ body: "alpha", confidence: 0.3 }),
      f({ body: "beta", start_line: 5, end_line: 5, confidence: 0.9 }),
    ];
    const { py } = await assertParity(findings, { table: { alpha: X, beta: Y } });
    expect(py.findings).toHaveLength(2);
    expect(py.semantic_skipped).toBe(false);
  }, 30_000);

  it("higher-confidence-absorbs direction — absorber is the LATER, higher-confidence finding", async () => {
    // i=0 (conf 0.2) scans j=1 (conf 0.85); cosine 1.0 ≥ threshold; f_j.confidence > absorber →
    // f_j absorbs, slot vector becomes f_j's. The merged finding's identity is f_j's (start_line 9).
    const findings = [
      f({ body: "low conf body", start_line: 1, end_line: 1, confidence: 0.2, title: "low" }),
      f({ body: "high conf body", start_line: 9, end_line: 9, confidence: 0.85, title: "high" }),
    ];
    const { py } = await assertParity(findings, {
      table: { "low conf body": X, "high conf body": X },
    });
    expect(py.findings).toHaveLength(1);
    const merged = py.findings[0]!;
    expect(merged["title"]).toBe("high");
    expect(merged["start_line"]).toBe(9);
    // Absorber (high) body + separator + absorbed (low) body.
    expect(merged["body"]).toBe("high conf body\n---\nlow conf body");
    expect(merged["confidence"]).toBe(0.85);
  }, 30_000);

  it("absorber-keeps-on-tie — equal confidence keeps the EARLIER finding as absorber", async () => {
    // f_j.confidence (0.5) is NOT strictly greater than absorber (0.5) → earlier finding absorbs.
    const findings = [
      f({ body: "earlier body", start_line: 1, end_line: 1, confidence: 0.5, title: "earlier" }),
      f({ body: "later body", start_line: 7, end_line: 7, confidence: 0.5, title: "later" }),
    ];
    const { py } = await assertParity(findings, {
      table: { "earlier body": X, "later body": X },
    });
    expect(py.findings).toHaveLength(1);
    const merged = py.findings[0]!;
    expect(merged["title"]).toBe("earlier");
    expect(merged["start_line"]).toBe(1);
    expect(merged["body"]).toBe("earlier body\n---\nlater body");
  }, 30_000);

  it("three same-file findings, two merge, one distinct survives", async () => {
    const findings = [
      f({ body: "merge me a", start_line: 1, end_line: 1, confidence: 0.4 }),
      f({ body: "merge me b", start_line: 2, end_line: 2, confidence: 0.7 }),
      f({ body: "distinct one", start_line: 3, end_line: 3, confidence: 0.6 }),
    ];
    const { py } = await assertParity(findings, {
      table: { "merge me a": X, "merge me b": X, "distinct one": Z },
    });
    // a+b merge (cosine 1.0); distinct (Z, orthogonal) survives → 2 out.
    expect(py.findings).toHaveLength(2);
    expect(py.semantic_skipped).toBe(false);
  }, 30_000);

  it("no-embedder fallback — TS undefined embedder takes the fail-open skip path on ≥2 findings", async () => {
    // This is the TS-only seam (no Python counterpart op): undefined embedder, ≥2 findings → skip path.
    const parsed = [f({ body: "one" }), f({ body: "two" })].map((d) => ReviewFindingV1.parse(d));
    const [out, skipped] = await aggregateSemantic(parsed, undefined);
    expect(out).toHaveLength(2);
    expect(skipped).toBe(true);
    // And <2 with no embedder → not skipped.
    const [out1, skipped1] = await aggregateSemantic([parsed[0]!], undefined);
    expect(out1).toHaveLength(1);
    expect(skipped1).toBe(false);
  });
});
