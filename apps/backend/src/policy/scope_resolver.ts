// scope_resolver — guidance resolution by changed-file ancestry (Sprint 25 / A-3).
//
// Pure function `resolveGuidance({ changedPath, extractedRules })` returns the rules that apply to a
// changed file path, deduped by `normalized_hash` and sorted by precedence. Deterministic: same inputs
// → byte-identical bundle.
//
// Algorithm (per the frozen module docstring):
//   1. Walk ancestors of `changed_path` → the in-scope set. "src/backend/api/refund.py" →
//      {"", "src", "src/backend", "src/backend/api"}. "" = repo root (matches any file).
//   2. Filter rules: keep those whose `scope_dir` is in scope.
//   3. Dedup by `normalized_hash`: collapse same-hash rules to one DedupedRuleV1 whose `rule` is the
//      canonical (highest priority, then nearest-ancestor, then first-encountered) and `sources` carries
//      every contributing rule in FIRST-ENCOUNTERED order.
//   4. Sort deduped rules by: nearest-ancestor primary (longest `rule.scope_dir`), priority desc,
//      `rule.rule_id` alphabetical.
//   5. Build a human-readable explanation per rule.
//
// Ordering invariants (load-bearing for determinism):
//   - `argMinStable` never replaces the incumbent on an equal key — first-encountered wins ties.
//   - JS `Map` preserves insertion order, so dedup-group iteration order is stable.
//   - `.sort` is spec-mandated stable, so equal precedence-keys preserve dedup-group-insertion order.
//   - Sort keys are compared lexicographically over 3 fields (mirrors tuple comparison).

import {
  DedupedRuleV1,
  type ResolvedGuidanceBundleV1,
} from "#contracts/resolved_guidance.v1.js";

import { type ExtractedRuleV1 } from "#contracts/extracted_rules.v1.js";

/**
 * The set of ancestor directory paths a rule's `scope_dir` must match for the rule to apply.
 * "src/backend/api/refund.py" → {"", "src", "src/backend", "src/backend/api"}. Empty string = repo
 * root (matches any file).
 */
function walkAncestors(changedPath: string): ReadonlySet<string> {
  const parts = changedPath.split("/").slice(0, -1); // drop the file basename
  const ancestors = new Set<string>([""]);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    ancestors.add(current);
  }
  return ancestors;
}

/**
 * Canonical-selection key within a dedup group (lower is better):
 *   1. -priority (highest priority wins)
 *   2. -len(scope_dir) (nearest-ancestor wins on tie)
 *   3. rule_id (alphabetical first-encountered tiebreak)
 */
function canonicalSortKey(rule: ExtractedRuleV1): readonly [number, number, string] {
  return [-rule.priority, -rule.scope_dir.length, rule.rule_id];
}

/**
 * Final precedence ordering of deduped rules (lower is better):
 *   1. -len(scope_dir) (nearest-ancestor primary)
 *   2. -priority (priority secondary)
 *   3. rule_id (alphabetical tertiary tie-break)
 */
function precedenceSortKey(deduped: DedupedRuleV1): readonly [number, number, string] {
  const rule = deduped.rule;
  return [-rule.scope_dir.length, -rule.priority, rule.rule_id];
}

/** Lexicographic compare of two (int, int, str) sort-key tuples. */
function compareKey(
  a: readonly [number, number, string],
  b: readonly [number, number, string],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] < b[2]) return -1;
  if (a[2] > b[2]) return 1;
  return 0;
}

/**
 * Stable arg-min: return the element with the lexicographically-smallest key, FIRST-WINS on ties.
 * The incumbent is only replaced when a STRICTLY smaller key is seen, preserving first-encountered
 * ordering on ties.
 */
function argMinStable(rules: ReadonlyArray<ExtractedRuleV1>): ExtractedRuleV1 {
  let best = rules[0]!;
  let bestKey = canonicalSortKey(best);
  for (let idx = 1; idx < rules.length; idx += 1) {
    const candidate = rules[idx]!;
    const key = canonicalSortKey(candidate);
    if (compareKey(key, bestKey) < 0) {
      best = candidate;
      bestKey = key;
    }
  }
  return best;
}

/** Human-readable explanation for one applied rule. */
function explain(deduped: DedupedRuleV1, changedPath: string): string {
  const rule = deduped.rule;
  const scopeLabel = rule.scope_dir || "root";
  let precedence: string;
  if (rule.scope_dir === "") {
    precedence = "root";
  } else if (rule.scope_dir === changedPath.split("/").slice(0, -1).join("/")) {
    precedence = "nearest ancestor";
  } else {
    precedence = "ancestor";
  }
  const headingPathStr =
    rule.heading_path.length > 0 ? rule.heading_path.join(" > ") : "(no heading)";
  const sourcesNote = deduped.sources.length > 1 ? `; sources=${deduped.sources.length}` : "";
  return (
    `Applied ${rule.source_file} (${headingPathStr}) — ` +
    `scope=${scopeLabel}, precedence=${precedence}; ` +
    `category=${rule.category}, intent=${rule.intent}, ` +
    `priority=${rule.priority}${sourcesNote}`
  );
}

/**
 * Return the rules applicable to `changedPath`, deduplicated by `normalized_hash` and sorted by
 * precedence. Pure / deterministic across runs.
 */
export function resolveGuidance(args: {
  changedPath: string;
  extractedRules: ReadonlyArray<ExtractedRuleV1>;
}): ResolvedGuidanceBundleV1 {
  const { changedPath, extractedRules } = args;
  const inScope = walkAncestors(changedPath);

  // Step 1: filter rules whose scope_dir is in scope.
  const applicable = extractedRules.filter((r) => inScope.has(r.scope_dir));

  // Step 2: dedup by normalized_hash; canonical = best per canonicalSortKey; sources preserves all
  // collapsed rules in stable (first-encountered) order. Map keeps insertion order (== Python dict).
  const byHash = new Map<string, Array<ExtractedRuleV1>>();
  for (const r of applicable) {
    const group = byHash.get(r.normalized_hash);
    if (group === undefined) {
      byHash.set(r.normalized_hash, [r]);
    } else {
      group.push(r);
    }
  }

  const deduped: Array<DedupedRuleV1> = [];
  for (const sources of byHash.values()) {
    // Choose canonical without reordering `sources` (which preserves first-encountered provenance).
    const canonical = argMinStable(sources);
    deduped.push(
      DedupedRuleV1.parse({
        schema_version: 1,
        rule: canonical,
        sources,
      }),
    );
  }

  // Step 3: precedence sort (stable — preserves dedup-group insertion order on equal keys).
  deduped.sort((a, b) => compareKey(precedenceSortKey(a), precedenceSortKey(b)));

  // Step 4: build parallel explanations.
  const explanations = deduped.map((dr) => explain(dr, changedPath));

  return {
    schema_version: 1,
    changed_path: changedPath,
    applicable_rules: deduped,
    resolution_explanation: explanations,
  };
}
