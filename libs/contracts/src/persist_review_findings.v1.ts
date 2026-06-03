import { z } from "zod";

import { AggregatedFindingsV1 } from "./aggregated_findings.v1.js";
import { FindingPolicyMetadataV1 } from "./finding_policy_metadata.v1.js";
import { ResolvedGuidanceBundleV1 } from "./resolved_guidance.v1.js";

// Zod port of contracts/persist_review_findings/v1.py::PersistReviewFindingsInputV1 (frozen Python,
// 2026-05-24 retrofit). Typed input envelope for `persist_review_findings_activity_v2`
// (CLAUDE.md invariant 11 — single positional Pydantic BaseModel input per activity).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in persist_review_findings.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - PersistReviewFindingsInputV1 (ConfigDict extra=forbid, frozen) → .strict()
//    No @model_validator / @field_validator on the source model — straight field port.
//
// Cross-contract refs (import the already-ported sibling Zod schemas; do NOT redefine):
//  - aggregated: AggregatedFindingsV1                     → ./aggregated_findings.v1.js
//  - policy_bundle: ResolvedGuidanceBundleV1 | None       → ./resolved_guidance.v1.js
//  - precomputed_metadata: tuple[FindingPolicyMetadataV1, ...] | None → ./finding_policy_metadata.v1.js
//
// NOTE on nested `confidence`: the embedded AggregatedFindingsV1.findings[*] is a ReviewFindingV1,
// which carries a bare Python `float` (`confidence`). model_dump(mode="json") emits `1.0` while a JS
// number `1` emits `1`, so the repo canonicalizer (which REJECTS bare floats) can never byte-match
// that one column. The parity test strips `aggregated.findings[*].confidence` before the canonical
// diff (same pattern as aggregated_findings.v1.parity.test.ts / review_findings.v1.ts header).
//
// Field mapping:
//  - schema_version: int = 1  → z.number().int().default(1). The Python field is a PLAIN `int` with a
//    default of 1 (NOT typing.Literal[1]), so Pydantic accepts any int (e.g. 2). A z.literal(1) would
//    diverge by rejecting other ints — must use z.number().int() to preserve accept/reject parity.
//  - pr_id / installation_id / run_id / review_id: uuid.UUID → z.string().uuid() (required, no default).
//    UUIDs are spelled lowercase in fixtures so Pydantic's lowercasing-on-dump matches Zod's
//    pass-through.
//  - aggregated: AggregatedFindingsV1  → AggregatedFindingsV1 (required, no default).
//  - policy_bundle: ResolvedGuidanceBundleV1 | None = None
//                                      → ResolvedGuidanceBundleV1.nullable().default(null).
//  - precomputed_metadata: tuple[FindingPolicyMetadataV1, ...] | None = None
//                                      → z.array(FindingPolicyMetadataV1).nullable().default(null).
//    Optional-tuple-of-submodel: None is a distinct sentinel from an empty tuple (); the field defaults
//    to None, so the absent / null wire value re-emits as null on both sides.
export const PersistReviewFindingsInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    pr_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    aggregated: AggregatedFindingsV1,
    run_id: z.string().uuid(),
    review_id: z.string().uuid(),
    policy_bundle: ResolvedGuidanceBundleV1.nullable().default(null),
    precomputed_metadata: z.array(FindingPolicyMetadataV1).nullable().default(null),
  })
  .strict();
export type PersistReviewFindingsInputV1 = z.infer<typeof PersistReviewFindingsInputV1>;
