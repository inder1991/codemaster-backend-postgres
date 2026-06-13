import { z } from "zod";

import { ScoredKnowledgeChunkV1 } from "./knowledge_chunks.v1.js";
import { DedupedRuleV1 } from "./resolved_guidance.v1.js";

// Zod port of contracts/assembled_prompt/v1.py (Sprint 26 / B-4).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in assembled_prompt.v1.parity.test.ts.
//
// Output of `codemaster.review.prompt_assembler.assemble_prompt`: the budget-enforced + ranked
// composition of policy rules (Subsystem A's `<policy>` blocks) and knowledge chunks (Subsystem B's
// `<knowledge>` blocks) for a single review chunk. No rule is rendered partially — either fully kept
// (policy_blocks) or dropped wholesale (dropped_policy_rules + dropped_policy_count).
//
// Source models / enums / constants ported (every public one):
//  - AssembledPromptV1 (ConfigDict extra=forbid, frozen, __contract_internal__) → .strict()
// `__contract_internal__ = True` is a contract-lint marker (the version moves with the parent
// envelope); it has no wire/runtime effect, so there is nothing to mirror on the Zod side.
// No @model_validator / @field_validator on the source model — straight field port.
//
// Cross-contract refs IMPORT the already-ported sibling Zod schemas rather than redefining them:
//  - policy_blocks / dropped_policy_rules / forced_rules : tuple[DedupedRuleV1, ...]
//        → DedupedRuleV1 (./resolved_guidance.v1.js → embeds ExtractedRuleV1; NO bare floats).
//  - knowledge_blocks : tuple[ScoredKnowledgeChunkV1, ...]
//        → ScoredKnowledgeChunkV1 (./knowledge_chunks.v1.js). This sibling carries a BARE float
//          `score` AND a nested KnowledgeChunkV1.age_days bare float, so the parity test strips
//          those nested float columns before the canonical diff (see assembled_prompt.v1.parity.test.ts).
//
// `schema_version` is a plain `int` default 1, NOT a Literal: z.number().int().default(1) so a future
// schema_version bump is not false-rejected (matching the knowledge_chunks / resolved_guidance ports).
//
// Counter fields (dropped_policy_count, knowledge_dropped_count, forced_include_count, policy_tokens,
// knowledge_tokens, total_tokens) are all `int = Field(default=0, ge=0)` → z.number().int().gte(0).default(0).

// AssembledPromptV1 — budget-enforced composition of policy + knowledge blocks.
// ConfigDict(extra="forbid", frozen=True) → .strict().
export const AssembledPromptV1 = z
  .object({
    schema_version: z.number().int().default(1),

    // Kept (rendered into the prompt).
    policy_blocks: z.array(DedupedRuleV1).default([]),
    knowledge_blocks: z.array(ScoredKnowledgeChunkV1).default([]),

    // Dropped (excluded due to budget).
    dropped_policy_rules: z.array(DedupedRuleV1).default([]),
    dropped_policy_count: z.number().int().gte(0).default(0),
    knowledge_dropped_count: z.number().int().gte(0).default(0),

    // Forced-include (over-budget safety override). forced_include_count = number of rules that would
    // have dropped but were kept anyway because they're intent="forbid" or category="security".
    // forced_rules = explicit per-rule list captured at append time (R-25).
    forced_include_count: z.number().int().gte(0).default(0),
    forced_rules: z.array(DedupedRuleV1).default([]),

    // Totals. policy_tokens + knowledge_tokens split (R-25) so the per-half counters emit the correct
    // values; total_tokens retained for back-compat as policy_tokens + knowledge_tokens.
    policy_tokens: z.number().int().gte(0).default(0),
    knowledge_tokens: z.number().int().gte(0).default(0),
    total_tokens: z.number().int().gte(0).default(0),
  })
  .strict();
export type AssembledPromptV1 = z.infer<typeof AssembledPromptV1>;
