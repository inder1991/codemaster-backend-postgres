import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  DetectorTrace,
  PersistRetrievalTraceInputV1,
  PersistRetrievalTraceOutputV1,
  RetrievalTraceV2,
  RetrievedKnowledgeDecisionV1,
  Stage1Trace,
  Stage2Trace,
  Stage3TraceV2,
  Stage3TrackTraceV2,
  TokenAccounting,
} from "../../libs/contracts/src/persist_retrieval_trace.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 / review_findings.v1 /
// aggregated_findings.v1 template.
//
// persist_retrieval_trace.v1 embeds RetrievalTraceV2, whose subtree is ported inline (none of the
// retrieval_trace tree is ported on its own yet); every embedded sub-model is parity-checked here too.
const PY_INPUT = "contracts.retrieval.persist_retrieval_trace.v1";
const PY_TRACE = "contracts.retrieval.retrieval_trace.v2";
const PY_TRACE_V1 = "contracts.retrieval.retrieval_trace.v1";

// Bare-float field names across the trace subtree: model_dump(mode="json") emits e.g. `0.7` / `1.0`,
// while a JS number emits `0.7` / `1`, and the canonicalizer (test/parity/canonical.ts) REJECTS bare
// floats outright. So these columns can never byte-match a canonical diff — strip every one of them
// (recursively) out of BOTH canonical objects before diffing, so EVERY other field is still proven
// byte-equal. The numeric bound is still enforced by Zod + asserted by the reject cases. Same pattern
// as review_findings.v1's `confidence` exclusion.
const BARE_FLOAT_FIELDS = new Set<string>([
  "freshness_score",
  "stage3_base_score",
  "cosine_component",
  "freshness_component",
  "specificity_component",
  "mmr_diversity_penalty",
  "final_score",
  "lambda_mmr",
]);

function stripFloats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripFloats);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (BARE_FLOAT_FIELDS.has(k)) continue;
      out[k] = stripFloats(v);
    }
    return out;
  }
  return value;
}

// canonicalize() THROWS on any bare float, so prune the float fields BEFORE canonicalizing.
// `floatlessZod` operates on the Zod-parsed object (never canonicalized whole — that would throw);
// `floatlessRef` parses the oracle's already-canonical string (Python's json tolerates floats), prunes,
// then re-canonicalizes so key-sort + scalar rules stay identical on both sides.
function floatlessZod(parsed: unknown): string {
  return canonicalize(stripFloats(parsed));
}

function floatlessRef(canon: string): string {
  return canonicalize(stripFloats(JSON.parse(canon)));
}

// A valid decision record exercising the bare-float columns + the evidence_ref pattern.
const DECISION = {
  chunk_id: "0a8b8c2d-0000-4000-8000-00000000000a",
  matched_labels: ["lang:python"],
  emitting_detectors: ["lang"],
  priority_tier: "LANG_GUIDANCE",
  match_specificity_score: 3,
  freshness_score: 1.0,
  selected_because: "top-rank",
  stage3_base_score: 0.9,
  cosine_component: 0.8,
  final_score: 0.95,
  rank_after_mmr: 1,
  evidence_ref: "ev_0123456789abcdef",
} as const;

// A valid Stage-3 track carrying both a selected + a dropped decision detail record.
const TRACK_A = {
  selection_basis: "mmr-rerank",
  selected_chunk_ids: ["0a8b8c2d-0000-4000-8000-00000000000a"],
  selected_chunks_detail: [DECISION],
  dropped_chunks_detail: [
    {
      chunk_id: "0a8b8c2d-0000-4000-8000-00000000000b",
      priority_tier: "DEFAULT_ONLY",
      match_specificity_score: 0,
      drop_reason: "mmr_redundant",
      drop_context: "too similar",
    },
  ],
} as const;

const TRACK_B = { selection_basis: "default-floor" } as const;

// A full, valid RetrievalTraceV2 payload (timezone-aware captured_at; required for _require_tz).
const TRACE = {
  trace_id: "0a8b8c2d-0000-4000-8000-000000000001",
  review_id: "0a8b8c2d-0000-4000-8000-000000000002",
  pr_id: "0a8b8c2d-0000-4000-8000-000000000003",
  captured_at: "2026-06-03T10:00:00+00:00",
  taxonomy_version: 1,
  pipeline_version: 1,
  detectors: [{ name: "lang", version: 1, emitted: ["lang:python"] }],
  effective_labels: ["lang:python"],
  platform_exposed_labels_count: 1,
  repo_include_attempts_filtered: ["docs/**"],
  stage1: { candidates_in: 10, candidates_out: 4, per_label_cap_applied: true },
  stage2: { per_tier_quotas: { REPO_ADR: 2, LANG_GUIDANCE: 1 }, tier_pool_size: 3 },
  stage3: { track_a_default: TRACK_A, track_b_non_default: TRACK_B },
  token_accounting: {
    budget_total: 1000,
    default_pool_used: 100,
    non_default_pool_used: 50,
    remaining: 850,
    reserved_floors_consumed: { SECURITY_POLICY: 200 },
  },
} as const;

describe("DetectorTrace parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { name: "lang", version: 2, emitted: ["lang:python", "framework:fastapi"] };
    const r = await pyRef({ pyModule: PY_TRACE_V1, pyCallable: "DetectorTrace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DetectorTrace.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=1, emitted=[]) when omitted", async () => {
    const payload = { name: "lang", version: 1 };
    const r = await pyRef({ pyModule: PY_TRACE_V1, pyCallable: "DetectorTrace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(DetectorTrace.parse(payload));
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.emitted).toEqual([]);
  }, 30_000);

  it("both REJECT an out-of-range value (version < 1)", async () => {
    const bad = { name: "lang", version: 0 };
    const r = await pyRef({ pyModule: PY_TRACE_V1, pyCallable: "DetectorTrace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DetectorTrace.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { name: "lang", version: 1, bogus: 1 };
    const r = await pyRef({ pyModule: PY_TRACE_V1, pyCallable: "DetectorTrace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DetectorTrace.parse(bad)).toThrow();
  }, 30_000);
});

describe("Stage1Trace parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { candidates_in: 10, candidates_out: 4, per_label_cap_applied: true };
    const r = await pyRef({ pyModule: PY_TRACE_V1, pyCallable: "Stage1Trace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(Stage1Trace.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an out-of-range value (candidates_in < 0)", async () => {
    const bad = { candidates_in: -1, candidates_out: 0, per_label_cap_applied: false };
    const r = await pyRef({ pyModule: PY_TRACE_V1, pyCallable: "Stage1Trace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage1Trace.parse(bad)).toThrow();
  }, 30_000);
});

describe("Stage2Trace parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically (dict[str,int] per_tier_quotas)", async () => {
    const payload = { per_tier_quotas: { REPO_ADR: 2, LANG_GUIDANCE: 1 }, tier_pool_size: 3 };
    const r = await pyRef({ pyModule: PY_TRACE_V1, pyCallable: "Stage2Trace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(Stage2Trace.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a missing required field (per_tier_quotas)", async () => {
    const bad = { tier_pool_size: 3 };
    const r = await pyRef({ pyModule: PY_TRACE_V1, pyCallable: "Stage2Trace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage2Trace.parse(bad)).toThrow();
  }, 30_000);
});

describe("TokenAccounting parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = {
      budget_total: 1000,
      default_pool_used: 100,
      non_default_pool_used: 50,
      remaining: 850,
      reserved_floors_consumed: { SECURITY_POLICY: 200 },
    };
    const r = await pyRef({ pyModule: PY_TRACE_V1, pyCallable: "TokenAccounting", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(TokenAccounting.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same reserved_floors_consumed default ({}) when omitted", async () => {
    const payload = {
      budget_total: 0,
      default_pool_used: 0,
      non_default_pool_used: 0,
      remaining: 0,
    };
    const r = await pyRef({ pyModule: PY_TRACE_V1, pyCallable: "TokenAccounting", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(TokenAccounting.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).reserved_floors_consumed).toEqual({});
  }, 30_000);

  it("both REJECT an out-of-range value (remaining < 0)", async () => {
    const bad = {
      budget_total: 0,
      default_pool_used: 0,
      non_default_pool_used: 0,
      remaining: -1,
    };
    const r = await pyRef({ pyModule: PY_TRACE_V1, pyCallable: "TokenAccounting", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => TokenAccounting.parse(bad)).toThrow();
  }, 30_000);
});

describe("RetrievedKnowledgeDecisionV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (bare-float columns excepted)", async () => {
    const r = await pyRef({
      pyModule: PY_TRACE,
      pyCallable: "RetrievedKnowledgeDecisionV1",
      kwargs: DECISION,
    });
    expect(r.ok, r.err).toBe(true);
    const zodObj = RetrievedKnowledgeDecisionV1.parse(DECISION);
    expect(floatlessZod(zodObj)).toBe(floatlessRef(r.out!));
    // The float columns still round-trip structurally (Zod keeps the bound; Python emits the float form).
    expect(zodObj.freshness_score).toBe(1);
    expect(zodObj.final_score).toBe(0.95);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted (dropped-record shape)", async () => {
    const payload = {
      chunk_id: "0a8b8c2d-0000-4000-8000-00000000000b",
      priority_tier: "DEFAULT_ONLY",
      match_specificity_score: 0,
      drop_reason: "mmr_redundant",
    };
    const r = await pyRef({
      pyModule: PY_TRACE,
      pyCallable: "RetrievedKnowledgeDecisionV1",
      kwargs: payload,
    });
    expect(r.ok, r.err).toBe(true);
    const zodObj = RetrievedKnowledgeDecisionV1.parse(payload);
    expect(floatlessZod(zodObj)).toBe(floatlessRef(r.out!));
    // Defaults: schema_version=1, matched_labels=[], selected_because=null, evidence_ref=null,
    // and freshness_score=0.0 (the only non-null bare float when omitted).
    const z = zodObj as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.matched_labels).toEqual([]);
    expect(z.selected_because).toBeNull();
    expect(z.evidence_ref).toBeNull();
    expect(z.freshness_score).toBe(0);
  }, 30_000);

  it("both REJECT an out-of-range value (match_specificity_score < 0)", async () => {
    const bad = {
      chunk_id: "0a8b8c2d-0000-4000-8000-00000000000a",
      priority_tier: "LANG_GUIDANCE",
      match_specificity_score: -1,
    };
    const r = await pyRef({
      pyModule: PY_TRACE,
      pyCallable: "RetrievedKnowledgeDecisionV1",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => RetrievedKnowledgeDecisionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed evidence_ref (pattern ^ev_[0-9a-f]{16}$)", async () => {
    const bad = {
      chunk_id: "0a8b8c2d-0000-4000-8000-00000000000a",
      priority_tier: "LANG_GUIDANCE",
      match_specificity_score: 3,
      evidence_ref: "not_an_ev",
    };
    const r = await pyRef({
      pyModule: PY_TRACE,
      pyCallable: "RetrievedKnowledgeDecisionV1",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => RetrievedKnowledgeDecisionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid drop_reason (closed vocabulary)", async () => {
    const bad = {
      chunk_id: "0a8b8c2d-0000-4000-8000-00000000000a",
      priority_tier: "LANG_GUIDANCE",
      match_specificity_score: 3,
      drop_reason: "nonsense",
    };
    const r = await pyRef({
      pyModule: PY_TRACE,
      pyCallable: "RetrievedKnowledgeDecisionV1",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => RetrievedKnowledgeDecisionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      chunk_id: "0a8b8c2d-0000-4000-8000-00000000000a",
      priority_tier: "LANG_GUIDANCE",
      match_specificity_score: 3,
      bogus: 1,
    };
    const r = await pyRef({
      pyModule: PY_TRACE,
      pyCallable: "RetrievedKnowledgeDecisionV1",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => RetrievedKnowledgeDecisionV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("Stage3TrackTraceV2 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (nested decision floats excepted)", async () => {
    const r = await pyRef({ pyModule: PY_TRACE, pyCallable: "Stage3TrackTraceV2", kwargs: TRACK_A });
    expect(r.ok, r.err).toBe(true);
    expect(floatlessZod(Stage3TrackTraceV2.parse(TRACK_A))).toBe(floatlessRef(r.out!));
  }, 30_000);

  it("applies all the same defaults when optional fields omitted", async () => {
    const payload = { selection_basis: "default-floor" };
    const r = await pyRef({ pyModule: PY_TRACE, pyCallable: "Stage3TrackTraceV2", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(Stage3TrackTraceV2.parse(payload));
    // No nested decision records ⇒ no bare float ⇒ full byte-equality.
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(2);
    expect(z.selected_chunk_ids).toEqual([]);
    expect(z.selected_chunks_detail).toEqual([]);
    expect(z.dropped_chunks_detail).toEqual([]);
  }, 30_000);

  it("both REJECT an empty selection_basis (min_length=1)", async () => {
    const bad = { selection_basis: "" };
    const r = await pyRef({ pyModule: PY_TRACE, pyCallable: "Stage3TrackTraceV2", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage3TrackTraceV2.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested decision (bad evidence_ref propagates)", async () => {
    const bad = {
      selection_basis: "x",
      selected_chunks_detail: [{ ...DECISION, evidence_ref: "bad" }],
    };
    const r = await pyRef({ pyModule: PY_TRACE, pyCallable: "Stage3TrackTraceV2", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage3TrackTraceV2.parse(bad)).toThrow();
  }, 30_000);
});

describe("Stage3TraceV2 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (lambda_mmr + nested floats excepted)", async () => {
    const payload = {
      track_a_default: TRACK_A,
      track_b_non_default: TRACK_B,
      starvation_observed: true,
      starvation_tiers: ["LANG_GUIDANCE"],
      lambda_mmr: 0.5,
    };
    const r = await pyRef({ pyModule: PY_TRACE, pyCallable: "Stage3TraceV2", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodObj = Stage3TraceV2.parse(payload);
    expect(floatlessZod(zodObj)).toBe(floatlessRef(r.out!));
    expect(zodObj.lambda_mmr).toBe(0.5);
  }, 30_000);

  it("applies the same defaults (lambda_mmr=0.7, starvation_observed=false) when omitted", async () => {
    const payload = { track_a_default: TRACK_B, track_b_non_default: TRACK_B };
    const r = await pyRef({ pyModule: PY_TRACE, pyCallable: "Stage3TraceV2", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodObj = Stage3TraceV2.parse(payload);
    // lambda_mmr (0.7) is a bare float — strip it for the byte-equal diff, assert structurally.
    expect(floatlessZod(zodObj)).toBe(floatlessRef(r.out!));
    const z = zodObj as Record<string, unknown>;
    expect(z.lambda_mmr).toBe(0.7);
    expect(z.starvation_observed).toBe(false);
    expect(z.starvation_tiers).toEqual([]);
    expect(z.schema_version).toBe(2);
  }, 30_000);

  it("both REJECT lambda_mmr out of [0,1]", async () => {
    const bad = { track_a_default: TRACK_B, track_b_non_default: TRACK_B, lambda_mmr: 1.5 };
    const r = await pyRef({ pyModule: PY_TRACE, pyCallable: "Stage3TraceV2", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => Stage3TraceV2.parse(bad)).toThrow();
  }, 30_000);
});

describe("RetrievalTraceV2 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (bare-float columns excepted)", async () => {
    const r = await pyRef({ pyModule: PY_TRACE, pyCallable: "RetrievalTraceV2", kwargs: TRACE });
    expect(r.ok, r.err).toBe(true);
    const floatlessCanon = floatlessZod(RetrievalTraceV2.parse(TRACE));
    expect(floatlessCanon).toBe(floatlessRef(r.out!));
    // captured_at normalizes to the same microsecond-precision RFC3339 instant on both sides.
    expect((JSON.parse(floatlessCanon) as Record<string, unknown>).captured_at).toBe(
      "2026-06-03T10:00:00.000000+00:00",
    );
  }, 30_000);

  it("applies all the same envelope defaults when optional fields omitted", async () => {
    const payload = {
      trace_id: "0a8b8c2d-0000-4000-8000-000000000001",
      review_id: "0a8b8c2d-0000-4000-8000-000000000002",
      pr_id: "0a8b8c2d-0000-4000-8000-000000000003",
      captured_at: "2026-06-03T10:00:00+00:00",
      taxonomy_version: 0,
      pipeline_version: 1,
      platform_exposed_labels_count: 0,
      stage1: { candidates_in: 0, candidates_out: 0, per_label_cap_applied: false },
      stage2: { per_tier_quotas: {}, tier_pool_size: 0 },
      stage3: { track_a_default: TRACK_B, track_b_non_default: TRACK_B },
      token_accounting: {
        budget_total: 0,
        default_pool_used: 0,
        non_default_pool_used: 0,
        remaining: 0,
      },
    };
    const r = await pyRef({ pyModule: PY_TRACE, pyCallable: "RetrievalTraceV2", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodObj = RetrievalTraceV2.parse(payload);
    expect(floatlessZod(zodObj)).toBe(floatlessRef(r.out!));
    const z = zodObj as Record<string, unknown>;
    expect(z.schema_version).toBe(2);
    expect(z.detectors).toEqual([]);
    expect(z.effective_labels).toEqual([]);
    expect(z.repo_include_attempts_filtered).toEqual([]);
  }, 30_000);

  it("both REJECT a naive (timezone-less) captured_at (_require_tz ↔ offset:true)", async () => {
    const bad = { ...TRACE, captured_at: "2026-06-03T10:00:00" };
    const r = await pyRef({ pyModule: PY_TRACE, pyCallable: "RetrievalTraceV2", kwargs: bad });
    expect(r.ok).toBe(false); // ValueError from the _require_tz AfterValidator
    expect(() => RetrievalTraceV2.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-range value (pipeline_version < 1)", async () => {
    const bad = { ...TRACE, pipeline_version: 0 };
    const r = await pyRef({ pyModule: PY_TRACE, pyCallable: "RetrievalTraceV2", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievalTraceV2.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...TRACE, bogus: 1 };
    const r = await pyRef({ pyModule: PY_TRACE, pyCallable: "RetrievalTraceV2", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievalTraceV2.parse(bad)).toThrow();
  }, 30_000);
});

describe("PersistRetrievalTraceInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (nested trace floats excepted)", async () => {
    const payload = { schema_version: 1, trace: TRACE };
    const r = await pyRef({
      pyModule: PY_INPUT,
      pyCallable: "PersistRetrievalTraceInputV1",
      kwargs: payload,
    });
    expect(r.ok, r.err).toBe(true);
    expect(floatlessZod(PersistRetrievalTraceInputV1.parse(payload))).toBe(floatlessRef(r.out!));
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = { trace: TRACE };
    const r = await pyRef({
      pyModule: PY_INPUT,
      pyCallable: "PersistRetrievalTraceInputV1",
      kwargs: payload,
    });
    expect(r.ok, r.err).toBe(true);
    const zodObj = PersistRetrievalTraceInputV1.parse(payload);
    expect(floatlessZod(zodObj)).toBe(floatlessRef(r.out!));
    expect((zodObj as Record<string, unknown>).schema_version).toBe(1);
  }, 30_000);

  it("both REJECT a missing required field (trace)", async () => {
    const bad = { schema_version: 1 };
    const r = await pyRef({
      pyModule: PY_INPUT,
      pyCallable: "PersistRetrievalTraceInputV1",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => PersistRetrievalTraceInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested trace (naive captured_at propagates)", async () => {
    const bad = { trace: { ...TRACE, captured_at: "2026-06-03T10:00:00" } };
    const r = await pyRef({
      pyModule: PY_INPUT,
      pyCallable: "PersistRetrievalTraceInputV1",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => PersistRetrievalTraceInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { trace: TRACE, bogus: 1 };
    const r = await pyRef({
      pyModule: PY_INPUT,
      pyCallable: "PersistRetrievalTraceInputV1",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => PersistRetrievalTraceInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("PersistRetrievalTraceOutputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { persisted: true };
    const r = await pyRef({
      pyModule: PY_INPUT,
      pyCallable: "PersistRetrievalTraceOutputV1",
      kwargs: payload,
    });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(PersistRetrievalTraceOutputV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).schema_version).toBe(1);
  }, 30_000);

  it("both REJECT a missing required field (persisted)", async () => {
    const bad = { schema_version: 1 };
    const r = await pyRef({
      pyModule: PY_INPUT,
      pyCallable: "PersistRetrievalTraceOutputV1",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => PersistRetrievalTraceOutputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { persisted: true, bogus: 1 };
    const r = await pyRef({
      pyModule: PY_INPUT,
      pyCallable: "PersistRetrievalTraceOutputV1",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => PersistRetrievalTraceOutputV1.parse(bad)).toThrow();
  }, 30_000);
});
