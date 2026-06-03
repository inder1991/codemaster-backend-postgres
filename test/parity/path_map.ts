// Pairs each TS module with its Python original in the frozen submodule. Logic is 1:1; only the
// package path differs (v9 repackaging). The parity oracle routes through this map.
//
// IN-SCOPE SPINE ONLY (Phase −1 + Phase 1–2). Background pools (Confluence, learnings, eval,
// retention, analytics) are Phase 3 and intentionally absent.
//
// Only modules VERIFIED to import against `migration-source-freeze` (2026-06-03) are listed here.
// The remaining spine modules are added — with their Python path confirmed — by their own tasks
// (see the TODO block) so this map never carries a guessed/wrong route.
export const PATH_MAP: Record<string, { pyModule: string }> = {
  // Redaction — text redactor (the detector module name is confirmed in Task 1.1)
  "backend/redact/output_redaction": { pyModule: "codemaster.security.output_redaction" },

  // File classification (Magika ML — Tier-B impure)
  "backend/classify": { pyModule: "codemaster.files.magika_classifier" },

  // Chunking — markdown splitting
  "backend/chunking": { pyModule: "codemaster.chunking.markdown_chunker" },

  // Policy — category/intent/rules heuristics (Tier-A pure)
  "backend/policy/rule_classifier": { pyModule: "codemaster.policy.rule_classifier" },
  "backend/policy/rule_extractor": { pyModule: "codemaster.policy.rule_extractor" },

  // Output safety — LLM coercion + parser guards
  "backend/security/output_safety": { pyModule: "codemaster.security.output_safety" },

  // Tenancy — ORM-layer installation_id filtering
  "backend/security/tenancy": { pyModule: "codemaster.security.tenancy" },

  // Cost — per-user daily cap enforcement (Tier-B impure: DB + locks)
  "backend/cost": { pyModule: "codemaster.cost.enforcer" },

  // Review activities (in-scope core-loop subset)
  "backend/review/activities": { pyModule: "codemaster.review.activities" },

  // Post-review activity
  "backend/activities/post_review_results": { pyModule: "codemaster.activities.post_review_results" },

  // TODO — add with verified Python paths in their tasks (the plan's guesses did NOT resolve at freeze):
  //   model_router (Task 1.8)        — file is codemaster/llm/model_router.py; confirm import seam
  //   redact secret detector (1.1)   — detection likely lives within security.output_redaction
  //   trust-tier assembly (1.10)     — module path TBD
  //   workflows (2.2)                — actual workflow module name TBD
  //   contracts (0.5)                — pattern is `contracts.<name>.vN` (top-level `contracts`, 228 entries)
  //   per-activity routes (2.1)      — clone/classify/redact/chunk/bedrock_review_chunk/aggregate_findings
};
