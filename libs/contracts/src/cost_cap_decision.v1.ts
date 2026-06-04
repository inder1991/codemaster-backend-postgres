import { z } from "zod";

// Zod port of codemaster/cost/enforcer.py::CostCapDecision (frozen Python, Sprint 0 / S0.2).
//
// Pydantic source:
//   class CostCapDecision(BaseModel):
//       model_config = ConfigDict(extra="ignore")
//       schema_version: Literal[1] = 1
//       allowed: bool
//       refused_reason: str | None = None
//       refused_scope: Literal["kill_switch", "global", "per_org"] | None = None
//       cents_spent_today_global: int = Field(..., ge=0)
//       cents_spent_today_org: int = Field(..., ge=0)
//       cents_estimated: int = Field(..., ge=0)
//
// Field-by-field parity:
//  - model_config extra="ignore"      → .strip() (drop unknown keys, mirror Pydantic ignore)
//  - schema_version: Literal[1] = 1   → z.literal(1).default(1)
//      (Literal[1], NOT a plain int — the decision contract is a fixed v1 shape; an unexpected
//       schema_version must reject, unlike the *input* envelopes ported elsewhere.)
//  - allowed: bool                    → z.boolean() (required, no default)
//  - refused_reason: str | None = None        → z.string().nullable().default(null)
//  - refused_scope: Literal[...] | None = None → z.enum([...]).nullable().default(null)
//  - cents_spent_today_global: int ge=0 → z.number().int().nonnegative()
//  - cents_spent_today_org: int ge=0    → z.number().int().nonnegative()
//  - cents_estimated: int ge=0          → z.number().int().nonnegative()
//
// All three cent fields are non-negative INTEGER cents — the int-cents arithmetic invariant of the
// cost spine. .int() rejects any fractional value the way Pydantic's `int` annotation does.
export const CostCapDecisionV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    allowed: z.boolean(),
    refused_reason: z.string().nullable().default(null),
    refused_scope: z.enum(["kill_switch", "global", "per_org"]).nullable().default(null),
    cents_spent_today_global: z.number().int().nonnegative(),
    cents_spent_today_org: z.number().int().nonnegative(),
    cents_estimated: z.number().int().nonnegative(),
  })
  .strip();
export type CostCapDecisionV1 = z.infer<typeof CostCapDecisionV1>;
