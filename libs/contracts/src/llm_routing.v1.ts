import { z } from "zod";

// Zod port of contracts/llm_routing/v1.py.
//
// ADR-0060 A: the ModelRouter / bedrock_routing_policy mechanism was retired (model selection moved
// to purpose→model via core.llm_purpose_model). The KNOWN_MODELS allow-list, SizeRule,
// RoutingPolicyV1 and RoutingDecisionV1 types were removed with it. Only LlmPurposeV1 survives — it
// names the per-call purposes consumed by the purpose→model resolver
// (codemaster/integrations/llm/purpose_model.py → ported to #backend/llm/model_router.ts) and the
// catalog.
//
// `LlmPurposeV1` is a z.enum over the .value strings: it parses a valid value → the string and throws on
// invalid. The vocabulary MUST stay byte-identical to the core.llm_purpose_model CHECK constraint in
// migrations/0001_baseline.sql — a drift there silently re-introduces a 500 when the admin GET parses an
// out-of-vocabulary pin. A vocabulary-invariant unit test guards this (and the executable-subset ⊂ seed).

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
