// Output-safety envelope v1 — 1:1 Zod port of contracts/output_safety/v1.py.
//
// The decision returned by OutputSafetyValidator.validate(). decision === "block" causes the caller
// to raise instead of returning the completion; decision === "allow" means all checks passed. Frozen
// + extra=forbid (→ .strict()) so widening requires a contract revision.

import { z } from "zod";

import { SecretFindingV1 } from "./secret_detection.v1.js";

/** Locked vocabulary of refusal reasons — each names the OutputSafetyValidator check that fired. */
export const OUTPUT_SAFETY_REASONS = [
  "length_exceeded",
  "privileged_tag_emitted",
  "secret_leaked",
  "tool_call_shape_emitted",
  "internal_claim_uncited",
] as const;

export const OutputSafetyReasonV1 = z.enum(OUTPUT_SAFETY_REASONS);
export type OutputSafetyReason = z.infer<typeof OutputSafetyReasonV1>;

/**
 * Validator decision for one LLM completion. `reasons` is empty iff `decision === "allow"`; when
 * "block", every fired check appears. `findings` carries the SecretFindingV1 span list only when
 * "block" AND `secret_leaked` ∈ reasons (downstream span-level redaction uses the offsets).
 *
 * Mirrors the Pydantic `tuple[...] = Field(default_factory=tuple)` defaults as `.default([])` (both
 * serialize to a JSON array); `schema_version` is a bare int default (NOT z.literal) per the forward-
 * compat contract policy.
 */
export const OutputSafetyDecisionV1 = z
  .object({
    schema_version: z.number().int().default(1),
    decision: z.enum(["allow", "block"]),
    reasons: z.array(OutputSafetyReasonV1).default([]),
    detail: z.string().max(512).default(""),
    findings: z.array(SecretFindingV1).default([]),
  })
  .strict();

export type OutputSafetyDecisionV1 = z.infer<typeof OutputSafetyDecisionV1>;
