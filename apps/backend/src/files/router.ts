// 1:1 port of vendor/codemaster-py/codemaster/files/router.py::decide_route (frozen Python).
//
// decide_route — file routing for the review pipeline.
//
// Phase B (2026-05-16) — return type promoted from "review" | "sandbox" | "skip" to a SET of those
// buckets so code files can route to BOTH "review" (LLM / Tier 2) AND "sandbox" (static analysis /
// Tier 1). Sequential ordering across the two tiers is enforced by the orchestrator, not the router.
//
// Decision tree (first match wins — identical order to the frozen Python):
//
//   1. is_generated              → {"skip"}              (lock files, vendor, build artifacts)
//   2. is_binary                 → {"skip"}              (no LLM benefit; sandbox can't help either)
//   3. magika_label === "empty"  → {"skip"}
//   4. language ∈ SANDBOX_LANGUAGES → {"review", "sandbox"}
//        (JS / TS / Python / Go — both tiers; Tier 1 runs static analysis, Tier 2 runs the LLM
//        review with Tier 1 findings as prompt context)
//   5. otherwise                 → {"review"}            (markdown, configs, dockerfiles, novel types)
//
// Unknown magika labels fall through to {"review"} — the safe default ensures we don't silently skip
// novel file types.
//
// The Python `RoutingBucket = Literal["review", "sandbox", "skip"]` and
// `RoutingDecision = frozenset[RoutingBucket]` are module-level type aliases in router.py (NOT in a
// contract package), so they are ported here verbatim rather than reusing libs/contracts. The
// frozenset is represented as a ReadonlySet<RoutingBucket> — the set semantics (membership, no order)
// match Python's frozenset exactly; callers that need a stable wire form sort the members.
import type { FileClassificationV1 } from "#contracts/file_classification.v1.js";

export type RoutingBucket = "review" | "sandbox" | "skip";
export type RoutingDecision = ReadonlySet<RoutingBucket>;

// Languages that the Tier-1 static-analysis sandbox supports today.
// Widening this set requires an ADR (see CLAUDE.md SANDBOX_LANGUAGES pin).
export const SANDBOX_LANGUAGES: ReadonlySet<string> = new Set<string>([
  "javascript",
  "typescript",
  "python",
  "go",
]);

/**
 * Route a classified file into one or more pipeline buckets.
 *
 * Returns a set of buckets:
 *   - {"skip"}                — generated, binary, empty
 *   - {"review"}              — non-code text (markdown, config, dockerfiles, novel file types)
 *   - {"review", "sandbox"}   — code (Python / JS / TS / Go) — both Tier 1 (static analysis) and
 *                               Tier 2 (LLM review)
 *
 * Sequential ordering: code files appear in BOTH buckets; the orchestrator runs Tier 1 (sandbox)
 * FIRST, then Tier 2 (review) with the Tier 1 findings as prompt context. The router stays free of
 * orchestration concerns.
 */
export function decideRoute(c: FileClassificationV1): RoutingDecision {
  if (c.is_generated) {
    return new Set<RoutingBucket>(["skip"]);
  }
  if (c.is_binary) {
    return new Set<RoutingBucket>(["skip"]);
  }
  if (c.magika_label === "empty") {
    return new Set<RoutingBucket>(["skip"]);
  }
  if (c.language !== null && SANDBOX_LANGUAGES.has(c.language)) {
    return new Set<RoutingBucket>(["review", "sandbox"]);
  }
  return new Set<RoutingBucket>(["review"]);
}
