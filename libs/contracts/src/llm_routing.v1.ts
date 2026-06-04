import { z } from "zod";

// Zod port of contracts/llm_routing/v1.py (frozen Python).
//
// ADR-0060 A: the ModelRouter / bedrock_routing_policy mechanism was retired (model selection moved
// to purpose→model via core.llm_purpose_model). The KNOWN_MODELS allow-list, SizeRule,
// RoutingPolicyV1 and RoutingDecisionV1 types were removed with it. Only LlmPurposeV1 survives — it
// names the per-call purposes consumed by the purpose→model resolver
// (codemaster/integrations/llm/purpose_model.py → ported to #backend/llm/model_router.ts) and the
// catalog.
//
// Python `class LlmPurposeV1(StrEnum)` → z.enum over the .value strings. Membership semantics:
// `LlmPurposeV1(value)` returns the member for a valid value and raises ValueError otherwise; the
// z.enum parses valid → the string and throws on invalid, matching byte-for-byte (see
// test/contracts/llm_routing.v1.parity.test.ts). Order preserved to match the frozen declaration
// order so any vocabulary drift is caught by the snapshot assertion.

export const LLM_PURPOSE_LITERALS = [
  "review_summary",
  "review_finding",
  "chat_reply",
  "walkthrough",
  "redaction_check",
  "cost_estimate",
  // S17.X-tool-dispatch — AnalysisCurator's Haiku promotion call. Lives separately from
  // `review_finding` so the purpose→model mapping can pin a cheaper model for the curator without
  // affecting chunk reviews. Cost-cap reporting / dashboards filter on this purpose.
  "analysis_curator",
  // fix-prompt cross-cutting theme synthesis — lightweight; pinned to a cheaper model than the
  // walkthrough it used to borrow. Cost-cap dashboards filter on this purpose.
  "fix_prompt",
] as const;

export const LlmPurposeV1 = z.enum(LLM_PURPOSE_LITERALS);
export type LlmPurposeV1 = z.infer<typeof LlmPurposeV1>;
