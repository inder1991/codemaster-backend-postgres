// Purpose→model resolver — single source of truth (ADR-0060, step 0).
//
// NOTE the subsystem name: the class-based ModelRouter / RoutingPolicyV1 / RoutingDecisionV1 mechanism
// was RETIRED by ADR-0060 A (see libs/contracts/src/llm_routing.v1.ts). Model selection now lives in
// this purpose→model resolver. The file is named model_router.ts to match the requested subsystem path.
//
// Before this module, "which Claude model serves which job" lived as three scattered hardcoded
// constants (review_finding → sonnet, walkthrough → opus, analysis_curator → haiku). The configured
// llm_provider_settings.model_id did NOT drive these calls — the hardcodes won. This module
// centralizes those choices into one seeded mapping and a resolver. Behavior is unchanged: the seed
// equals the prior hardcodes.
//
// The DB-backed async read-side (PurposeModelCache / resolve_model_for_purpose in the Python) reads
// core.llm_purpose_model and merges DB rows over the seed (DB wins, fail-open to the seed). That path
// requires a live SQLAlchemy session and is OUT OF SCOPE here (no-database guardrail). The pure sync
// resolver below IS the unconfigured / seed-only behavior those variants fall back to.

import { LLM_PURPOSE_LITERALS } from "#contracts/llm_routing.v1.js";

/** Conservative mid-tier fallback for any purpose without an explicit choice. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * The seed == today's hardcodes (do not change without a cost/quality review).
 *
 * Keyed by the LlmPurposeV1 `.value` strings. Only four of the eight purposes carry an explicit pin;
 * the rest resolve to DEFAULT_MODEL via the dict-miss fallback in modelForPurpose. Modeled as a
 * ReadonlyMap (not an object) so the resolver's lookup is a Map.get — no dynamic object-index
 * injection sink.
 */
export const PURPOSE_MODEL_SEED: ReadonlyMap<string, string> = new Map<string, string>([
  ["review_finding", "claude-sonnet-4-6"],
  ["walkthrough", "claude-opus-4-7"],
  ["analysis_curator", "claude-haiku-4-5-20251001"],
  ["fix_prompt", "claude-sonnet-4-6"],
]);

/**
 * Return the model id assigned to `purpose`.
 *
 * Permissive: an out-of-vocabulary string does NOT raise — it falls through to DEFAULT_MODEL. Today:
 * the seeded default. ADR-0060 step 1 swaps the body to read core.llm_purpose_model first and fall
 * back to this seed.
 */
export function modelForPurpose(purpose: string): string {
  // Map.get yields the pinned model for a seeded purpose or undefined on a miss → fall through to
  // DEFAULT_MODEL. A Map keeps the lookup off a dynamic object index (no injection sink) and narrows
  // cleanly under noUncheckedIndexedAccess.
  return PURPOSE_MODEL_SEED.get(purpose) ?? DEFAULT_MODEL;
}

/**
 * The full set of documented LLM-call purposes (re-exported for callers that want to iterate the
 * vocabulary). The per-purpose model is resolved via modelForPurpose, not by reading this list.
 */
export const LLM_PURPOSES: ReadonlyArray<string> = LLM_PURPOSE_LITERALS;
