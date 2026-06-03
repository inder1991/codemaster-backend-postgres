import { z } from "zod";

import { ExtractedRuleV1 } from "./extracted_rules.v1.js";

// Zod port of contracts/resolved_guidance/v1.py (frozen Python, Sprint 25 / A-3).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in resolved_guidance.v1.parity.test.ts.
//
// Output of `resolve_guidance`. Given a changed file path + the full set of ExtractedRuleV1 (A-2
// output), A-3 returns the rules that apply to that path — sorted by precedence and deduplicated by
// normalized_hash. Platform-internal: never serialized to Postgres in v1.
//
// Source models / enums / constants ported (every public one):
//  - DedupedRuleV1            (ConfigDict extra=forbid, frozen, __contract_internal__) → .strict()
//  - ResolvedGuidanceBundleV1 (ConfigDict extra=forbid, frozen)                        → .strict()
//
// `rule: ExtractedRuleV1` / `sources: tuple[ExtractedRuleV1, ...]` / `applicable_rules:
// tuple[DedupedRuleV1, ...]` import the already-ported sibling Zod schema (./extracted_rules.v1.js)
// rather than redefining it. ExtractedRuleV1 carries NO bare float / UUID / datetime fields, so the
// nested envelope byte-round-trips fully through the canonicalizer (no nested-column strip needed —
// unlike review_findings' bare `confidence` float).
//
// No @model_validator / @field_validator on either source model — straight field port.

// DedupedRuleV1 — one canonical rule plus the source rules that collapsed to it via normalized_hash
// equivalence. ConfigDict(extra="forbid", frozen=True) → .strict().
// `__contract_internal__ = True` is a contract-lint marker (versions move with the parent envelope);
// it has no wire/runtime effect, so there is nothing to mirror on the Zod side.
//  - schema_version: int = 1                            → z.number().int().default(1)
//    (plain int default, NOT Literal[1] — a literal would false-reject a future schema_version=2).
//  - rule: ExtractedRuleV1                              → ExtractedRuleV1 (required, no default).
//  - sources: tuple[ExtractedRuleV1, ...] = Field(min_length=1) → z.array(ExtractedRuleV1).min(1)
//    (required; at least one element — always contains at least the canonical rule).
export const DedupedRuleV1 = z
  .object({
    schema_version: z.number().int().default(1),
    rule: ExtractedRuleV1,
    sources: z.array(ExtractedRuleV1).min(1),
  })
  .strict();
export type DedupedRuleV1 = z.infer<typeof DedupedRuleV1>;

// ResolvedGuidanceBundleV1 — result of `resolve_guidance` for one changed_path.
// ConfigDict(extra="forbid", frozen=True) → .strict().
//  - schema_version: int = 1                            → z.number().int().default(1)
//  - changed_path: Field(min_length=1, max_length=500)  → z.string().min(1).max(500)
//  - applicable_rules: tuple[DedupedRuleV1, ...] = default_factory=tuple
//                                                       → z.array(DedupedRuleV1).default([])
//  - resolution_explanation: tuple[str, ...] = default_factory=tuple
//                                                       → z.array(z.string()).default([])
export const ResolvedGuidanceBundleV1 = z
  .object({
    schema_version: z.number().int().default(1),
    changed_path: z.string().min(1).max(500),
    applicable_rules: z.array(DedupedRuleV1).default([]),
    resolution_explanation: z.array(z.string()).default([]),
  })
  .strict();
export type ResolvedGuidanceBundleV1 = z.infer<typeof ResolvedGuidanceBundleV1>;
