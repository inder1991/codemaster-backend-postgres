import { z } from "zod";

// Zod port of contracts/policy_citation/v1.py::PolicyCitationContextV1.
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in policy_citation.v1.parity.test.ts.

// Python: PolicyCitationEnforcement = Literal["observe", "enforce"]
export const PolicyCitationEnforcement = z.enum(["observe", "enforce"]);
export type PolicyCitationEnforcement = z.infer<typeof PolicyCitationEnforcement>;

export const PolicyCitationContextV1 = z
  .object({
    // Python: schema_version: int = 1 (plain int default, NOT a Literal — any int accepted).
    schema_version: z.number().int().default(1),
    // Python: valid_rule_ids: tuple[str, ...] = Field(default_factory=tuple)
    valid_rule_ids: z.array(z.string()).default([]),
    // Python: enforcement: PolicyCitationEnforcement = "observe"
    enforcement: PolicyCitationEnforcement.default("observe"),
  })
  .strict();

export type PolicyCitationContextV1 = z.infer<typeof PolicyCitationContextV1>;
