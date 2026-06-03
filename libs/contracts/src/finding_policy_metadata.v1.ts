import { z } from "zod";

// Zod port of contracts/finding_policy_metadata/v1.py::FindingPolicyMetadataV1 (frozen Python).
// Per-finding policy-filter outcome metadata (Sprint 25 / A-6-b post-filter); persists into
// core.review_findings.policy_metadata. Pydantic ConfigDict(extra="forbid", frozen=True) →
// .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in finding_policy_metadata.v1.parity.test.ts.
//
// Field mapping:
//  - schema_version: int = 1  → z.number().int().default(1). The Python field is a PLAIN `int` with a
//    default of 1 (NOT typing.Literal[1]), so Pydantic accepts any int (e.g. 2). A z.literal(1) would
//    diverge by rejecting other ints — must use z.number().int() to preserve accept/reject parity.
//  - invariant_violation_attempted: bool  → z.boolean() (required, no default).
//  - invariants_fired: tuple[str, ...]  → z.array(z.string()) (REQUIRED — no default_factory on the
//    Python field, so an absent value is a validation error on both sides).
export const FindingPolicyMetadataV1 = z
  .object({
    schema_version: z.number().int().default(1),
    invariant_violation_attempted: z.boolean(),
    invariants_fired: z.array(z.string()),
  })
  .strict();

export type FindingPolicyMetadataV1 = z.infer<typeof FindingPolicyMetadataV1>;
