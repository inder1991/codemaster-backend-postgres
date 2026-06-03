import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../../../test/parity/canonical.js";
import { pyRef, shutdownRef } from "../../../test/parity/oracle.js";
import { CitationV1, ReviewFindingV1 } from "./review_findings.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 template.
const PY = "contracts.review_findings.v1";

// `confidence` is a bare Python `float`: model_dump(mode="json") emits `1.0` while a JS number `1`
// emits `1`, so the canonicalizer can never byte-match that one column (documented Python-side
// serialization quirk — see review_findings.v1.ts header). Strip it from BOTH canonical strings so
// every OTHER field is still proven byte-equal, and assert confidence separately.
function dropConfidence(canon: string): string {
  const o = JSON.parse(canon) as Record<string, unknown>;
  delete o.confidence;
  // Re-canonicalize via canonicalize() so key-sort + scalar rules stay identical to the oracle path.
  return canonicalize(o);
}

describe("CitationV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { kind: "repo_path", locator: "src/app.py", excerpt: "def f():" };
    const r = await pyRef({ pyModule: PY, pyCallable: "CitationV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(CitationV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same excerpt default (null) when omitted", async () => {
    const payload = { kind: "linter_rule", locator: "E501" };
    const r = await pyRef({ pyModule: PY, pyCallable: "CitationV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(CitationV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an out-of-range value (locator length 0)", async () => {
    const bad = { kind: "repo_path", locator: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "CitationV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => CitationV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { kind: "repo_path", locator: "a", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "CitationV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CitationV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid enum value (kind out of vocabulary)", async () => {
    const bad = { kind: "not_a_kind", locator: "a" };
    const r = await pyRef({ pyModule: PY, pyCallable: "CitationV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CitationV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ReviewFindingV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (confidence column excepted)", async () => {
    const payload = {
      file: "src/app.py",
      start_line: 10,
      end_line: 20,
      severity: "issue",
      category: "bug",
      title: "Null deref",
      body: "Dereferences a possibly-null pointer.",
      suggestion: "Add a guard.",
      confidence: 1, // pydantic coerces int→float; serialized 1.0 on Python, 1 on JS (see dropConfidence)
      sources: [
        { kind: "repo_path", locator: "src/app.py", excerpt: "def f():" },
        { kind: "knowledge_chunk", locator: "kc_123" },
      ],
      scope: "cross_chunk",
      evidence_refs: ["ev_0123456789abcdef", "ev_fedcba9876543210"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewFindingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(ReviewFindingV1.parse(payload));
    // Every field except the float `confidence` is byte-equal between Pydantic and Zod.
    expect(dropConfidence(zodCanon)).toBe(dropConfidence(r.out!));
    // confidence still round-trips structurally: Zod keeps the bound, Python emits the float form.
    expect((JSON.parse(zodCanon) as { confidence: number }).confidence).toBe(1);
    expect((JSON.parse(r.out!) as { confidence: number }).confidence).toBe(1);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted", async () => {
    const payload = {
      file: "a.py",
      start_line: 1,
      end_line: 1,
      severity: "nit",
      category: "style",
      title: "t",
      body: "b",
      confidence: 0, // → 0.0 Python / 0 JS
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewFindingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(ReviewFindingV1.parse(payload));
    expect(dropConfidence(zodCanon)).toBe(dropConfidence(r.out!));
    // Defaults: schema_version=1, suggestion=null, sources=[], scope=chunk_observed, evidence_refs=[].
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.suggestion).toBeNull();
    expect(z.sources).toEqual([]);
    expect(z.scope).toBe("chunk_observed");
    expect(z.evidence_refs).toEqual([]);
  }, 30_000);

  it("both REJECT an out-of-range value (start_line < 1)", async () => {
    const bad = {
      file: "a.py",
      start_line: 0,
      end_line: 1,
      severity: "nit",
      category: "style",
      title: "t",
      body: "b",
      confidence: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT confidence out of [0,1] (le=1.0)", async () => {
    const bad = {
      file: "a.py",
      start_line: 1,
      end_line: 1,
      severity: "nit",
      category: "style",
      title: "t",
      body: "b",
      confidence: 2,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT the line-range validator (_check_line_range: end_line < start_line)", async () => {
    const bad = {
      file: "a.py",
      start_line: 20,
      end_line: 10,
      severity: "issue",
      category: "bug",
      title: "t",
      body: "b",
      confidence: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewFindingV1", kwargs: bad });
    expect(r.ok).toBe(false); // ValueError from @model_validator
    expect(() => ReviewFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed evidence_ref (_check_evidence_refs_pattern)", async () => {
    const bad = {
      file: "a.py",
      start_line: 1,
      end_line: 2,
      severity: "issue",
      category: "bug",
      title: "t",
      body: "b",
      confidence: 1,
      evidence_refs: ["not_an_ev_id"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT too many evidence_refs (max_length=20)", async () => {
    const refs = Array.from({ length: 21 }, (_, i) => `ev_${i.toString(16).padStart(16, "0")}`);
    const bad = {
      file: "a.py",
      start_line: 1,
      end_line: 2,
      severity: "issue",
      category: "bug",
      title: "t",
      body: "b",
      confidence: 1,
      evidence_refs: refs,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      file: "a.py",
      start_line: 1,
      end_line: 2,
      severity: "issue",
      category: "bug",
      title: "t",
      body: "b",
      confidence: 1,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewFindingV1.parse(bad)).toThrow();
  }, 30_000);
});
