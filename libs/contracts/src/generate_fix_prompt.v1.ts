import { z } from "zod";

import { AggregatedFindingsV1 } from "./aggregated_findings.v1.js";

// Zod port of contracts/generate_fix_prompt/v1.py (frozen Python). Parity-validated in
// generate_fix_prompt.v1.parity.test.ts.
//
// GenerateFixPromptInputV1 — single typed input for generate_fix_prompt_activity
// (ADR-0047 / invariant 11). Consolidates the review identity + tenant + PR coordinates +
// the aggregated findings into one wire contract.
//
// Source models / enums / constants ported (every public one):
//  - GenerateFixPromptInputV1 (ConfigDict extra=forbid, frozen=True) → .strict()
//
// `aggregated: AggregatedFindingsV1` imports the already-ported sibling Zod schema
// (./aggregated_findings.v1.js) rather than redefining it. NOTE: that schema nests
// ReviewFindingV1 which carries a bare Python `float` (`confidence`); it cannot byte-round-trip
// through the canonicalizer — the parity test strips that nested column from the canonical diff
// (see review_findings.v1.ts header + the parity test's nested-strip helper).

// GenerateFixPromptInputV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const GenerateFixPromptInputV1 = z
  .object({
    // Python: schema_version: int = 1. Bare int default → z.number().int().default(1)
    // (NOT z.literal(1) — a literal would false-reject a future schema_version=2 wire payload).
    schema_version: z.number().int().default(1),
    // Pydantic uuid.UUID: validates UUID syntax, model_dump emits lowercase canonical form.
    review_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    installation_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    // NUMERIC GitHub-App installation id the advisory fix-prompt comment posts under (per-review routing).
    // DISTINCT from installation_id above (the internal UUID tenant FK used for the fix_prompts persist).
    // NULLABLE (faithful to the nullable workflow payload; the activity enforces presence). `.default(null)`
    // keeps the KEY required at construction so the dispatch threads the id explicitly. TS-only field, absent
    // in frozen Python; the parity test strips it.
    github_installation_id: z.number().int().gte(0).nullable().default(null),
    pr_number: z.number().int(),
    owner: z.string(),
    repo: z.string(),
    // Required sub-shape (no default) — the already-ported sibling Zod schema.
    aggregated: AggregatedFindingsV1,
  })
  .strict();
export type GenerateFixPromptInputV1 = z.infer<typeof GenerateFixPromptInputV1>;
