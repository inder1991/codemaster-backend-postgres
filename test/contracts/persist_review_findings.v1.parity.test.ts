import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { PersistReviewFindingsInputV1 } from "../../libs/contracts/src/persist_review_findings.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `PersistReviewFindingsInputV1(**payload).model_dump(mode="json")`) and through Zod
// (`PersistReviewFindingsInputV1.parse(payload)`), then diff canonical JSON. Accept/reject must also
// agree. Follows the markdown_chunk.v1 / aggregated_findings.v1 template.
// UUIDs are spelled lowercase so Pydantic's lowercasing-on-dump matches Zod's pass-through.
const PY = "contracts.persist_review_findings.v1";

// The embedded AggregatedFindingsV1.findings[*] is a ReviewFindingV1 carrying a bare Python `float`
// (`confidence`): model_dump(mode="json") emits `1.0` while a JS number `1` emits `1`, so the
// canonicalizer (which REJECTS bare floats) can never byte-match that one column. Strip
// `aggregated.findings[*].confidence` before the canonical diff so EVERY other field of the envelope
// (incl. the rest of each finding) is still proven byte-equal; confidence is asserted structurally +
// range-rejected separately.
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

const DEDUPE_STATS = {
  input_count: 5,
  exact_dropped: 1,
  semantic_merged: 1,
  capped: 0,
  semantic_skipped: false,
} as const;

const AGGREGATED = {
  schema_version: 1,
  findings: [FINDING],
  dedupe_stats: DEDUPE_STATS,
  policy_revision: 7,
} as const;

// A valid nested ResolvedGuidanceBundleV1 (with one DedupedRuleV1 → ExtractedRuleV1). No bare floats /
// UUID / datetime anywhere in this sub-tree, so it byte-round-trips fully.
const EXTRACTED_RULE = {
  schema_version: 1,
  rule_id: "rule-001",
  normalized_hash: "a".repeat(64),
  source_file: "docs/CLAUDE.md",
  source_file_sha256: "b".repeat(64),
  scope_dir: "src",
  heading_path: ["Security"],
  rule_index: 0,
  title: "No eval",
  body: "Never call eval on untrusted input.",
  category: "security",
  intent: "forbid",
  priority: 100,
  oversized_rule_warning: false,
} as const;

const POLICY_BUNDLE = {
  schema_version: 1,
  changed_path: "src/app.py",
  applicable_rules: [{ schema_version: 1, rule: EXTRACTED_RULE, sources: [EXTRACTED_RULE] }],
  resolution_explanation: ["Applied docs/CLAUDE.md (Security) — nearest-ancestor; priority=100"],
} as const;

const PRECOMPUTED_METADATA = [
  { schema_version: 1, invariant_violation_attempted: false, invariants_fired: ["evidence_required"] },
] as const;

// Lowercase UUIDs (Pydantic lowercases on dump).
const PR_ID = "550e8400-e29b-41d4-a716-446655440000";
const INSTALLATION_ID = "123e4567-e89b-12d3-a456-426614174000";
const RUN_ID = "00000000-0000-4000-8000-000000000000";
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";

describe("PersistReviewFindingsInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically (nested confidence excepted)", async () => {
    const payload = {
      schema_version: 1,
      pr_id: PR_ID,
      installation_id: INSTALLATION_ID,
      aggregated: AGGREGATED,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      policy_bundle: POLICY_BUNDLE,
      precomputed_metadata: PRECOMPUTED_METADATA,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewFindingsInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(PersistReviewFindingsInputV1.parse(payload));
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

  it("applies all the same defaults when optional fields omitted", async () => {
    const payload = {
      pr_id: PR_ID,
      installation_id: INSTALLATION_ID,
      aggregated: {
        dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
        policy_revision: 0,
      },
      run_id: RUN_ID,
      review_id: REVIEW_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewFindingsInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(PersistReviewFindingsInputV1.parse(payload));
    // No nested float when findings is empty — full byte-equality holds.
    expect(zodCanon).toBe(r.out);
    // Defaults: schema_version=1, policy_bundle=null, precomputed_metadata=null.
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.policy_bundle).toBeNull();
    expect(z.precomputed_metadata).toBeNull();
  }, 30_000);

  it("accepts a forward schema_version (int default, NOT z.literal)", async () => {
    // schema_version is a bare int (default 1); a wire payload carrying 2 must be accepted by both.
    const payload = {
      schema_version: 2,
      pr_id: PR_ID,
      installation_id: INSTALLATION_ID,
      aggregated: {
        dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
        policy_revision: 0,
      },
      run_id: RUN_ID,
      review_id: REVIEW_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewFindingsInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PersistReviewFindingsInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("round-trips an explicit empty precomputed_metadata tuple (() distinct from null)", async () => {
    const payload = {
      pr_id: PR_ID,
      installation_id: INSTALLATION_ID,
      aggregated: {
        dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
        policy_revision: 0,
      },
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      precomputed_metadata: [],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewFindingsInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(PersistReviewFindingsInputV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as { precomputed_metadata: unknown }).precomputed_metadata).toEqual([]);
  }, 30_000);

  it("both REJECT a malformed UUID (pr_id)", async () => {
    const bad = {
      pr_id: "not-a-uuid",
      installation_id: INSTALLATION_ID,
      aggregated: {
        dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
        policy_revision: 0,
      },
      run_id: RUN_ID,
      review_id: REVIEW_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewFindingsInputV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => PersistReviewFindingsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (aggregated)", async () => {
    const bad = {
      pr_id: PR_ID,
      installation_id: INSTALLATION_ID,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewFindingsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PersistReviewFindingsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested finding (start_line < 1 propagates through aggregated)", async () => {
    const bad = {
      pr_id: PR_ID,
      installation_id: INSTALLATION_ID,
      aggregated: { ...AGGREGATED, findings: [{ ...FINDING, start_line: 0 }] },
      run_id: RUN_ID,
      review_id: REVIEW_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewFindingsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PersistReviewFindingsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested policy_bundle (changed_path empty propagates)", async () => {
    const bad = {
      pr_id: PR_ID,
      installation_id: INSTALLATION_ID,
      aggregated: {
        dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
        policy_revision: 0,
      },
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      policy_bundle: { ...POLICY_BUNDLE, changed_path: "" },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewFindingsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PersistReviewFindingsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      pr_id: PR_ID,
      installation_id: INSTALLATION_ID,
      aggregated: {
        dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
        policy_revision: 0,
      },
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PersistReviewFindingsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PersistReviewFindingsInputV1.parse(bad)).toThrow();
  }, 30_000);
});
