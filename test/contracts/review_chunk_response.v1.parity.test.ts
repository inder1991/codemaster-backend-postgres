import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  ORIGINAL_TEXT_MAX_BYTES,
  OutputSafetySanitizationEventV1,
  ReviewChunkResponseV1,
} from "#contracts/review_chunk_response.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 / review_findings.v1 template.
const PY = "contracts.review_chunk_response.v1";
// OutputSafetySanitizationEventV1 lives in a sibling Python module (ported INLINE on the Zod side).
const PY_SANITIZE = "contracts.review_chunk_response.sanitization_event_v1";

// Nested ReviewFindingV1.confidence is a bare Python `float`: model_dump(mode="json") emits `1.0` while a
// JS number `1` emits `1`, AND the repo canonicalizer REJECTS bare floats. Strip `findings[*].confidence`
// from a parsed (plain-JSON) object so every OTHER field is still proven byte-equal; confidence is asserted
// structurally. (Same Python-side float-serialization quirk documented in review_findings.v1.ts.)
function stripFindingConfidence(obj: Record<string, unknown>): Record<string, unknown> {
  const findings = obj.findings;
  if (Array.isArray(findings)) {
    obj.findings = findings.map((f) => {
      if (f && typeof f === "object") {
        const copy = { ...(f as Record<string, unknown>) };
        delete copy.confidence;
        return copy;
      }
      return f;
    });
  }
  return obj;
}

// Canonicalize a Zod-parsed value that may contain bare floats (nested confidence) by routing it through
// plain JSON first, stripping the float column, then through the shared canonicalizer.
function canonZodWithFindings(parsed: unknown): string {
  return canonicalize(stripFindingConfidence(JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>));
}

// Canonicalize the Python oracle's JSON string the same way (parse → strip → canonicalize).
function canonPyWithFindings(out: string): string {
  return canonicalize(stripFindingConfidence(JSON.parse(out) as Record<string, unknown>));
}

const VALID_FINDING = {
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

const VALID_INTENT = {
  target_finding_id: "123e4567-e89b-12d3-a456-426614174000",
  action: "SUPPRESS",
  confidence: "0.750",
  reason: "Tier-1 finding is a known false positive in this generated file.",
};

const VALID_SANITIZE = {
  installation_id: "123e4567-e89b-12d3-a456-426614174001",
  request_id: "123e4567-e89b-12d3-a456-426614174002",
  original_text: "leaked AKIA-style secret in preamble",
  redacted_text: "[redacted]",
  spans_redacted: 2,
  detector_kinds: ["aws_key", "generic_secret"],
  stage: "review_chunk",
};

describe("OutputSafetySanitizationEventV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const r = await pyRef({
      pyModule: PY_SANITIZE,
      pyCallable: "OutputSafetySanitizationEventV1",
      kwargs: VALID_SANITIZE,
    });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(OutputSafetySanitizationEventV1.parse(VALID_SANITIZE))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const r = await pyRef({
      pyModule: PY_SANITIZE,
      pyCallable: "OutputSafetySanitizationEventV1",
      kwargs: VALID_SANITIZE,
    });
    expect(r.ok, r.err).toBe(true);
    const z = OutputSafetySanitizationEventV1.parse(VALID_SANITIZE);
    expect(z.schema_version).toBe(1);
    // UUID fields lowercase on dump (Pydantic), matched by the Zod .transform.
    expect(z.installation_id).toBe(VALID_SANITIZE.installation_id);
  }, 30_000);

  it("both REJECT spans_redacted < 1 (ge=1)", async () => {
    const bad = { ...VALID_SANITIZE, spans_redacted: 0 };
    const r = await pyRef({ pyModule: PY_SANITIZE, pyCallable: "OutputSafetySanitizationEventV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => OutputSafetySanitizationEventV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT empty detector_kinds (min_length=1)", async () => {
    const bad = { ...VALID_SANITIZE, detector_kinds: [] };
    const r = await pyRef({ pyModule: PY_SANITIZE, pyCallable: "OutputSafetySanitizationEventV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => OutputSafetySanitizationEventV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT empty stage (min_length=1)", async () => {
    const bad = { ...VALID_SANITIZE, stage: "" };
    const r = await pyRef({ pyModule: PY_SANITIZE, pyCallable: "OutputSafetySanitizationEventV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => OutputSafetySanitizationEventV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT stage over max_length=64", async () => {
    const bad = { ...VALID_SANITIZE, stage: "x".repeat(65) };
    const r = await pyRef({ pyModule: PY_SANITIZE, pyCallable: "OutputSafetySanitizationEventV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => OutputSafetySanitizationEventV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT original_text over ORIGINAL_TEXT_MAX_BYTES + 32", async () => {
    const bad = { ...VALID_SANITIZE, original_text: "x".repeat(ORIGINAL_TEXT_MAX_BYTES + 33) };
    const r = await pyRef({ pyModule: PY_SANITIZE, pyCallable: "OutputSafetySanitizationEventV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => OutputSafetySanitizationEventV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed UUID (installation_id)", async () => {
    const bad = { ...VALID_SANITIZE, installation_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY_SANITIZE, pyCallable: "OutputSafetySanitizationEventV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => OutputSafetySanitizationEventV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...VALID_SANITIZE, bogus: 1 };
    const r = await pyRef({ pyModule: PY_SANITIZE, pyCallable: "OutputSafetySanitizationEventV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => OutputSafetySanitizationEventV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ReviewChunkResponseV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps an empty envelope identically (all defaults)", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewChunkResponseV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(ReviewChunkResponseV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.findings).toEqual([]);
    expect(z.arbitration_intents).toEqual([]);
    expect(z.sanitization_event).toBeNull();
  }, 30_000);

  it("validates + dumps a full populated envelope identically (nested confidence excepted)", async () => {
    const payload = {
      findings: [VALID_FINDING],
      arbitration_intents: [VALID_INTENT],
      sanitization_event: VALID_SANITIZE,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewChunkResponseV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = ReviewChunkResponseV1.parse(payload);
    // Every field except the nested float `findings[*].confidence` is byte-equal Pydantic↔Zod.
    expect(canonZodWithFindings(parsed)).toBe(canonPyWithFindings(r.out!));
    // The nested confidence still round-trips structurally (Zod keeps the bound; Python emits the float form).
    const zFindings = (JSON.parse(JSON.stringify(parsed)) as { findings: Array<{ confidence: number }> }).findings;
    const pFindings = (JSON.parse(r.out!) as { findings: Array<{ confidence: number }> }).findings;
    expect(zFindings[0]?.confidence).toBe(1);
    expect(pFindings[0]?.confidence).toBe(1);
  }, 30_000);

  it("validates + dumps an envelope with sanitization_event=null identically", async () => {
    const payload = { findings: [], arbitration_intents: [], sanitization_event: null };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewChunkResponseV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ReviewChunkResponseV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a wrong schema_version (Literal[1])", async () => {
    const bad = { schema_version: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewChunkResponseV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewChunkResponseV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed nested finding (start_line < 1 propagates)", async () => {
    const bad = { findings: [{ ...VALID_FINDING, start_line: 0 }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewChunkResponseV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewChunkResponseV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed nested arbitration_intent (confidence > 1)", async () => {
    const bad = { arbitration_intents: [{ ...VALID_INTENT, confidence: "1.500" }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewChunkResponseV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewChunkResponseV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed nested sanitization_event (empty detector_kinds)", async () => {
    const bad = { sanitization_event: { ...VALID_SANITIZE, detector_kinds: [] } };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewChunkResponseV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewChunkResponseV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewChunkResponseV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewChunkResponseV1.parse(bad)).toThrow();
  }, 30_000);
});
