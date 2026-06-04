import { z } from "zod";

import { ReviewFindingV1 } from "./review_findings.v1.js";

// NEW typed-input envelope introduced DURING the Python→TS port — there is NO Python Pydantic
// counterpart to diff against. The frozen Python `AggregateFindingsActivity.aggregate_findings`
// (vendor/codemaster-py/codemaster/review/aggregate_activity.py) dispatches with TWO positional
// arguments — `(findings: tuple[ReviewFindingV1, ...], policy_revision: int)` — which violates
// CLAUDE.md invariant 11 / ADR-0047 ("every Temporal activity takes EXACTLY ONE positional argument
// typed as a Pydantic v2 BaseModel"). The Python carries this as the only known live violation
// (head-of-eng-audit-2 R-14). The TS port CLOSES that violation: the activity's single positional
// input is this `AggregateFindingsInputV1` envelope.
//
// Because there is no Python contract for this envelope, the parity test only covers round-trip /
// validation (accepts a valid {findings, policy_revision}; `.strict()` rejects unknown keys) — there
// is no source-of-truth to byte-diff against.
//
// `findings: z.array(ReviewFindingV1)` reuses the already-ported sibling Zod schema rather than
// redefining the finding shape. `policy_revision` mirrors the Python `int` positional that the
// activity threads straight into `AggregatedFindingsV1.policy_revision` (which itself is `Field(ge=0)`);
// we keep the bound here lenient (`z.number().int()`, no `.gte(0)`) so the envelope mirrors the loose
// Python positional and the ge-0 enforcement stays single-sourced on the OUTPUT contract.

export const AggregateFindingsInputV1 = z
  .object({
    // Python `int = 1` schema_version default → z.number().int().default(1) (NOT z.literal(1):
    // a literal would false-reject a future schema_version=2 wire payload). Mirrors the
    // aggregated_findings.v1 envelope's schema_version handling.
    schema_version: z.number().int().default(1),
    // tuple[ReviewFindingV1, ...] positional → z.array(...) of the ported sibling schema.
    findings: z.array(ReviewFindingV1),
    // int positional → z.number().int(). No .gte(0) here (see header): the ge-0 invariant is enforced
    // single-sourced on AggregatedFindingsV1.policy_revision.
    policy_revision: z.number().int(),
  })
  .strict();
export type AggregateFindingsInputV1 = z.infer<typeof AggregateFindingsInputV1>;
