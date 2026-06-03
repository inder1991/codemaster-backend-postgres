import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { GenerateFixPromptInputV1 } from "#contracts/generate_fix_prompt.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 / aggregated_findings.v1
// template.
const PY = "contracts.generate_fix_prompt.v1";

// Lowercase UUIDs: Pydantic uuid.UUID model_dump emits the canonical lowercase form, so a payload
// passing UPPERCASE would round-trip to lowercase and the canonical diff would still hold via the
// Zod .toLowerCase() transform — but we use lowercase here to keep the round-trip a pure identity.
const REVIEW_ID = "11111111-2222-3333-4444-555555555555";
const INSTALLATION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// The nested AggregatedFindingsV1 nests ReviewFindingV1, whose bare Python `float` `confidence`
// serializes `1.0` on Pydantic vs `1` on JS — the canonicalizer REJECTS bare floats, so it can never
// byte-match. Strip `confidence` out of every nested finding (under aggregated.findings) before the
// canonical diff so EVERY other field of the envelope is still proven byte-equal; confidence is
// asserted structurally separately.
function dropNestedConfidence(canon: string): string {
  const o = JSON.parse(canon) as Record<string, unknown>;
  const aggregated = o.aggregated;
  if (aggregated && typeof aggregated === "object") {
    const findings = (aggregated as Record<string, unknown>).findings;
    if (Array.isArray(findings)) {
      for (const f of findings) {
        if (f && typeof f === "object") delete (f as Record<string, unknown>).confidence;
      }
    }
  }
  // Re-canonicalize so key-sort + scalar rules stay identical to the oracle path.
  return canonicalize(o);
}

// A representative valid nested ReviewFindingV1 payload (confidence is an int here; Pydantic coerces
// int→float, serializing 1.0 on Python / 1 on JS — handled by dropNestedConfidence).
const FINDING = {
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
} as const;

// A valid nested AggregatedFindingsV1 payload.
const AGGREGATED = {
  schema_version: 1,
  findings: [FINDING],
  dedupe_stats: {
    input_count: 5,
    exact_dropped: 1,
    semantic_merged: 1,
    capped: 0,
    semantic_skipped: false,
  },
  policy_revision: 7,
} as const;

// AggregatedFindingsV1 with no findings — full byte-equality holds (no nested float).
const AGGREGATED_EMPTY = {
  dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
  policy_revision: 0,
} as const;

describe("GenerateFixPromptInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (nested confidence excepted)", async () => {
    const payload = {
      schema_version: 1,
      review_id: REVIEW_ID,
      installation_id: INSTALLATION_ID,
      pr_number: 42,
      owner: "inder1991",
      repo: "inventory-service",
      aggregated: AGGREGATED,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GenerateFixPromptInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(GenerateFixPromptInputV1.parse(payload));
    // Every field except each nested float `confidence` is byte-equal between Pydantic and Zod.
    expect(dropNestedConfidence(zodCanon)).toBe(dropNestedConfidence(r.out!));
    // confidence still round-trips structurally in the nested finding.
    const zf = (
      JSON.parse(zodCanon) as { aggregated: { findings: Array<{ confidence: number }> } }
    ).aggregated.findings[0];
    const pf = (
      JSON.parse(r.out!) as { aggregated: { findings: Array<{ confidence: number }> } }
    ).aggregated.findings[0];
    expect(zf?.confidence).toBe(1);
    expect(pf?.confidence).toBe(1);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted (empty findings)", async () => {
    const payload = {
      review_id: REVIEW_ID,
      installation_id: INSTALLATION_ID,
      pr_number: 1,
      owner: "o",
      repo: "r",
      aggregated: AGGREGATED_EMPTY,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GenerateFixPromptInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(GenerateFixPromptInputV1.parse(payload));
    // No nested float when findings is empty — full byte-equality holds.
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
  }, 30_000);

  it("accepts a forward schema_version (int default, NOT z.literal)", async () => {
    // schema_version is a bare int (default 1); a wire payload carrying 2 must be accepted by both.
    const payload = {
      schema_version: 2,
      review_id: REVIEW_ID,
      installation_id: INSTALLATION_ID,
      pr_number: 1,
      owner: "o",
      repo: "r",
      aggregated: AGGREGATED_EMPTY,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GenerateFixPromptInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(GenerateFixPromptInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("lowercases UUIDs identically (Pydantic canonical form ↔ Zod .toLowerCase())", async () => {
    const payload = {
      review_id: REVIEW_ID.toUpperCase(),
      installation_id: INSTALLATION_ID.toUpperCase(),
      pr_number: 1,
      owner: "o",
      repo: "r",
      aggregated: AGGREGATED_EMPTY,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GenerateFixPromptInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(GenerateFixPromptInputV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as { review_id: string; installation_id: string };
    expect(z.review_id).toBe(REVIEW_ID);
    expect(z.installation_id).toBe(INSTALLATION_ID);
  }, 30_000);

  it("both REJECT a malformed UUID (review_id)", async () => {
    const bad = {
      review_id: "not-a-uuid",
      installation_id: INSTALLATION_ID,
      pr_number: 1,
      owner: "o",
      repo: "r",
      aggregated: AGGREGATED_EMPTY,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GenerateFixPromptInputV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => GenerateFixPromptInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-integer pr_number", async () => {
    const bad = {
      review_id: REVIEW_ID,
      installation_id: INSTALLATION_ID,
      pr_number: 1.5,
      owner: "o",
      repo: "r",
      aggregated: AGGREGATED_EMPTY,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GenerateFixPromptInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GenerateFixPromptInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (aggregated)", async () => {
    const bad = {
      review_id: REVIEW_ID,
      installation_id: INSTALLATION_ID,
      pr_number: 1,
      owner: "o",
      repo: "r",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GenerateFixPromptInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GenerateFixPromptInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested aggregated (policy_revision < 0 propagates)", async () => {
    const bad = {
      review_id: REVIEW_ID,
      installation_id: INSTALLATION_ID,
      pr_number: 1,
      owner: "o",
      repo: "r",
      aggregated: {
        dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
        policy_revision: -1,
      },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GenerateFixPromptInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GenerateFixPromptInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      review_id: REVIEW_ID,
      installation_id: INSTALLATION_ID,
      pr_number: 1,
      owner: "o",
      repo: "r",
      aggregated: AGGREGATED_EMPTY,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GenerateFixPromptInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GenerateFixPromptInputV1.parse(bad)).toThrow();
  }, 30_000);
});
