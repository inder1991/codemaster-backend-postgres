import { z } from "zod";

import { ResolvedGuidanceBundleV1 } from "./resolved_guidance.v1.js";

// Zod port of contracts/policy_compute/v1.py (Sprint 25 / A-5-followup-2).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in policy_compute.v1.parity.test.ts.
//
// The workflow-callable wrapper over the A-1 → A-2 → A-3 chain:
//   - ComputePolicyRulesInputV1 — input envelope for compute_policy_rules_activity.
//   - ComputedPolicyRulesV1     — output envelope; bundles keyed by changed_path.
//
// Source models / enums / constants ported (every public one):
//  - ComputePolicyRulesInputV1 (ConfigDict extra=forbid, frozen) → .strict()
//  - ComputedPolicyRulesV1     (ConfigDict extra=forbid, frozen) → .strict()
// No enums, no module-level constants, no helper functions in this module.
// No @model_validator / @field_validator on either source model — straight field port.
//
// `bundles: dict[str, ResolvedGuidanceBundleV1]` imports the already-ported sibling Zod schema
// (./resolved_guidance.v1.js) rather than redefining it. ResolvedGuidanceBundleV1 (transitively
// ExtractedRuleV1 / DedupedRuleV1) carries NO bare float / UUID / datetime fields, so the nested
// envelope byte-round-trips fully through the canonicalizer (no nested-column strip needed).

// ComputePolicyRulesInputV1 — frozen input envelope for compute_policy_rules_activity.
// Per the Temporal-activity-input JSON-safe gate, every field uses JSON-primitive types only.
// ConfigDict(extra="forbid", frozen=True) → .strict().
//  - schema_version: int = 1                       → z.number().int().default(1)
//    (plain int default, NOT Literal[1] — a literal would false-reject a future schema_version=2).
//  - workspace_path: Field(min_length=1)           → z.string().min(1) (required, no default).
//  - custom_patterns: tuple[str, ...] default_factory=tuple → z.array(z.string()).default([])
//  - knowledge_enabled: bool = True                → z.boolean().default(true)
//  - changed_paths: tuple[str, ...] default_factory=tuple → z.array(z.string()).default([])
export const ComputePolicyRulesInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    workspace_path: z.string().min(1),
    custom_patterns: z.array(z.string()).default([]),
    knowledge_enabled: z.boolean().default(true),
    changed_paths: z.array(z.string()).default([]),
  })
  .strict();
export type ComputePolicyRulesInputV1 = z.infer<typeof ComputePolicyRulesInputV1>;

// ComputedPolicyRulesV1 — frozen output envelope for compute_policy_rules_activity.
// ConfigDict(extra="forbid", frozen=True) → .strict().
//  - schema_version: int = 1                       → z.number().int().default(1)
//  - bundles: dict[str, ResolvedGuidanceBundleV1] default_factory=dict
//                                                  → z.record(z.string(), ResolvedGuidanceBundleV1).default({})
//    (JSON-safe str keys only per the Temporal-activity-input gate; keyed by changed_path).
//  - truncated: bool = False                       → z.boolean().default(false)
export const ComputedPolicyRulesV1 = z
  .object({
    schema_version: z.number().int().default(1),
    bundles: z.record(z.string(), ResolvedGuidanceBundleV1).default({}),
    truncated: z.boolean().default(false),
  })
  .strict();
export type ComputedPolicyRulesV1 = z.infer<typeof ComputedPolicyRulesV1>;
