import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  DetectorTrace,
  RetrievalTraceV1,
  Stage1Trace,
  Stage2Trace,
  Stage3Trace,
  Stage3TrackTrace,
  TokenAccounting,
} from "#contracts/retrieval_trace.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 template.
const PY = "contracts.retrieval.retrieval_trace.v1";

// `lambda_mmr` (Stage3Trace) is a bare Python `float`: model_dump(mode="json") emits `0.7` while the
// repo canonicalizer (test/parity/canonical.ts) REJECTS bare floats. Strip it from BOTH sides BEFORE
// canonicalizing (top-level for Stage3Trace, nested under `stage3` for RetrievalTraceV1) so every
// OTHER field is still proven byte-equal, and assert lambda_mmr structurally. Each helper takes a
// plain JSON string (JSON.stringify of the Zod-parsed object, or the Python oracle's `r.out`), deletes
// the float, then re-canonicalizes via canonicalize() so key-sort + scalar rules stay identical to the
// oracle path. (We cannot canonicalize() the Zod object first — it throws on the bare float.)
function dropTopLambda(json: string): string {
  const o = JSON.parse(json) as Record<string, unknown>;
  delete o.lambda_mmr;
  return canonicalize(o);
}
function dropNestedLambda(json: string): string {
  const o = JSON.parse(json) as Record<string, unknown>;
  const stage3 = o.stage3 as Record<string, unknown> | undefined;
  if (stage3) delete stage3.lambda_mmr;
  return canonicalize(o);
}

const TRACK_A = { selection_basis: "default-track" };
const TRACK_B = { selection_basis: "non-default-track" };

describe("DetectorTrace parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { name: "lang-detector", version: 3, emitted: ["lang:python", "fw:fastapi"] };
    const r = await pyRef({ pyModule: PY, pyCallable: "DetectorTrace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DetectorTrace.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=1, emitted=[]) when omitted", async () => {
    const payload = { name: "d", version: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DetectorTrace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DetectorTrace.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an out-of-range value (version < 1)", async () => {
    const bad = { name: "d", version: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DetectorTrace", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => DetectorTrace.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty name (min_length=1)", async () => {
    const bad = { name: "", version: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DetectorTrace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DetectorTrace.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { name: "d", version: 1, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DetectorTrace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DetectorTrace.parse(bad)).toThrow();
  }, 30_000);
});

describe("Stage1Trace parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { candidates_in: 50, candidates_out: 12, per_label_cap_applied: true };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage1Trace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(Stage1Trace.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an out-of-range value (candidates_in < 0)", async () => {
    const bad = { candidates_in: -1, candidates_out: 0, per_label_cap_applied: false };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage1Trace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage1Trace.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { candidates_in: 1, candidates_out: 1, per_label_cap_applied: false, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage1Trace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage1Trace.parse(bad)).toThrow();
  }, 30_000);
});

describe("Stage2Trace parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically (dict[str, int] per_tier_quotas)", async () => {
    const payload = {
      per_tier_quotas: { SECURITY_POLICY: 3, LANG_GUIDANCE: 1 },
      tier_pool_size: 8,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage2Trace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(Stage2Trace.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an out-of-range value (tier_pool_size < 0)", async () => {
    const bad = { per_tier_quotas: {}, tier_pool_size: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage2Trace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage2Trace.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { per_tier_quotas: {}, tier_pool_size: 1, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage2Trace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage2Trace.parse(bad)).toThrow();
  }, 30_000);
});

describe("Stage3TrackTrace parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically (lowercase UUID chunk ids)", async () => {
    const payload = {
      selection_basis: "cosine + freshness + specificity rerank",
      selected_chunk_ids: ["11111111-1111-1111-1111-111111111111"],
      dropped_chunk_ids: [
        "22222222-2222-2222-2222-222222222222",
        "33333333-3333-3333-3333-333333333333",
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage3TrackTrace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(Stage3TrackTrace.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=1, [] chunk ids) when omitted", async () => {
    const payload = { selection_basis: "basis" };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage3TrackTrace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(Stage3TrackTrace.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an empty selection_basis (min_length=1)", async () => {
    const bad = { selection_basis: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage3TrackTrace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage3TrackTrace.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed chunk id (not a UUID)", async () => {
    const bad = { selection_basis: "b", selected_chunk_ids: ["not-a-uuid"] };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage3TrackTrace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage3TrackTrace.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { selection_basis: "b", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage3TrackTrace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage3TrackTrace.parse(bad)).toThrow();
  }, 30_000);
});

describe("Stage3Trace parity (Pydantic ↔ Zod)", () => {
  // lambda_mmr is a bare float (default 0.7); strip it from the canonical compare and assert it
  // structurally (see dropTopLambda + header note in retrieval_trace.v1.ts).
  it("validates a valid payload; non-float fields canonicalize identically", async () => {
    const payload = {
      track_a_default: TRACK_A,
      track_b_non_default: TRACK_B,
      starvation_observed: true,
      starvation_tiers: ["SECURITY_POLICY", "DEFAULT_ONLY"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage3Trace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);

    const parsed = Stage3Trace.parse(payload);
    // Structural assertion on the float-bearing column (cannot byte-round-trip a bare float).
    expect(parsed.lambda_mmr).toBe(0.7);
    // Every other field is byte-equal between Pydantic and Zod.
    expect(dropTopLambda(JSON.stringify(parsed))).toBe(dropTopLambda(r.out!));
  }, 30_000);

  it("applies the same defaults (lambda_mmr=0.7, starvation_observed=false, []) when omitted", async () => {
    const payload = { track_a_default: TRACK_A, track_b_non_default: TRACK_B };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage3Trace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);

    const parsed = Stage3Trace.parse(payload);
    expect(parsed.lambda_mmr).toBe(0.7);
    expect(parsed.starvation_observed).toBe(false);
    expect(parsed.starvation_tiers).toEqual([]);
    expect(dropTopLambda(JSON.stringify(parsed))).toBe(dropTopLambda(r.out!));
  }, 30_000);

  it("both REJECT lambda_mmr out of [0,1] (le=1.0)", async () => {
    const bad = { track_a_default: TRACK_A, track_b_non_default: TRACK_B, lambda_mmr: 1.5 };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage3Trace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage3Trace.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid starvation_tier (out of PriorityTierStr vocabulary)", async () => {
    const bad = {
      track_a_default: TRACK_A,
      track_b_non_default: TRACK_B,
      starvation_tiers: ["NOT_A_TIER"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage3Trace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage3Trace.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { track_a_default: TRACK_A, track_b_non_default: TRACK_B, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "Stage3Trace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage3Trace.parse(bad)).toThrow();
  }, 30_000);
});

describe("TokenAccounting parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = {
      budget_total: 8000,
      default_pool_used: 5000,
      non_default_pool_used: 2000,
      remaining: 1000,
      reserved_floors_consumed: { SECURITY_POLICY: 500 },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "TokenAccounting", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(TokenAccounting.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same reserved_floors_consumed default ({}) when omitted", async () => {
    const payload = {
      budget_total: 100,
      default_pool_used: 40,
      non_default_pool_used: 20,
      remaining: 40,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "TokenAccounting", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(TokenAccounting.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an out-of-range value (budget_total < 0)", async () => {
    const bad = { budget_total: -1, default_pool_used: 0, non_default_pool_used: 0, remaining: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "TokenAccounting", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => TokenAccounting.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      budget_total: 1,
      default_pool_used: 0,
      non_default_pool_used: 0,
      remaining: 1,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "TokenAccounting", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => TokenAccounting.parse(bad)).toThrow();
  }, 30_000);
});

describe("RetrievalTraceV1 parity (Pydantic ↔ Zod)", () => {
  const baseTrace = {
    trace_id: "11111111-1111-1111-1111-111111111111",
    review_id: "22222222-2222-2222-2222-222222222222",
    pr_id: "33333333-3333-3333-3333-333333333333",
    captured_at: "2026-06-03T10:00:00+00:00",
    taxonomy_version: 1,
    pipeline_version: 1,
    platform_exposed_labels_count: 2,
    stage1: { candidates_in: 50, candidates_out: 12, per_label_cap_applied: true },
    stage2: { per_tier_quotas: { SECURITY_POLICY: 3 }, tier_pool_size: 8 },
    stage3: {
      track_a_default: { selection_basis: "default-track" },
      track_b_non_default: { selection_basis: "non-default-track" },
    },
    token_accounting: {
      budget_total: 8000,
      default_pool_used: 5000,
      non_default_pool_used: 2000,
      remaining: 1000,
    },
  };

  // The nested stage3.lambda_mmr bare float is stripped from both sides (see dropNestedLambda).
  it("validates + dumps a full nested payload identically (datetime + UUID + nested models)", async () => {
    const payload = {
      ...baseTrace,
      detectors: [{ name: "lang-detector", version: 2, emitted: ["lang:python"] }],
      effective_labels: ["lang:python", "fw:fastapi"],
      repo_include_attempts_filtered: ["adr/0001.md"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievalTraceV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);

    const parsed = RetrievalTraceV1.parse(payload);
    expect(parsed.stage3.lambda_mmr).toBe(0.7);
    expect(dropNestedLambda(JSON.stringify(parsed))).toBe(dropNestedLambda(r.out!));
  }, 30_000);

  it("applies all the same defaults when optional collection fields omitted", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievalTraceV1", kwargs: baseTrace });
    expect(r.ok, r.err).toBe(true);

    const parsed = RetrievalTraceV1.parse(baseTrace);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.detectors).toEqual([]);
    expect(parsed.effective_labels).toEqual([]);
    expect(parsed.repo_include_attempts_filtered).toEqual([]);
    expect(dropNestedLambda(JSON.stringify(parsed))).toBe(dropNestedLambda(r.out!));
  }, 30_000);

  it("normalizes a microsecond-precision datetime identically (Z ↔ +00:00 offset)", async () => {
    const payload = { ...baseTrace, captured_at: "2026-06-03T10:00:00.123456+00:00" };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievalTraceV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(dropNestedLambda(JSON.stringify(RetrievalTraceV1.parse(payload)))).toBe(
      dropNestedLambda(r.out!),
    );
  }, 30_000);

  it("both REJECT a naive (tz-unaware) captured_at (_require_tz ↔ datetime({offset:true}))", async () => {
    const bad = { ...baseTrace, captured_at: "2026-06-03T10:00:00" };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievalTraceV1", kwargs: bad });
    expect(r.ok).toBe(false); // ValueError from _require_tz AfterValidator
    expect(() => RetrievalTraceV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-range value (pipeline_version < 1)", async () => {
    const bad = { ...baseTrace, pipeline_version: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievalTraceV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievalTraceV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed trace_id (not a UUID)", async () => {
    const bad = { ...baseTrace, trace_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievalTraceV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievalTraceV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...baseTrace, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievalTraceV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievalTraceV1.parse(bad)).toThrow();
  }, 30_000);
});
