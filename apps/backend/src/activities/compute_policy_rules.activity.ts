/**
 * `computePolicyRules` activity — Phase-2.1 core-loop activity #4 port. 1:1 in intent with the frozen
 * Python `@activity.defn compute_policy_rules`
 * (vendor/codemaster-py/codemaster/activities/compute_policy_rules.py): the workflow-callable wrapper
 * over the deterministic A-1 → A-2 → A-3 chain.
 *
 * ## The chain (ported EXACTLY)
 *
 *   1. validate input.
 *   2. if NOT `knowledge_enabled` → return `ComputedPolicyRulesV1{ bundles: {}, truncated: false }`
 *      (SHORT-CIRCUIT — the customer opted out via `.codemaster.yaml::knowledge.enabled=false`; NO
 *      workspace walk happens).
 *   3. `custom_patterns = sorted(unique(input.custom_patterns))` — dedup + sort defensively in case the
 *      workflow body passes duplicates (the body already merged `knowledge.file_patterns`).
 *   4. `discovered = discoverGuidelineFiles({ workspace, customPatterns })` (A-1).
 *   5. `all_rules = flatMap(discovered.files, extractRules)` (A-2; `extractRules` already ported).
 *   6. `bundles = { cp -> resolveGuidance({ changedPath: cp, extractedRules: all_rules }) }` for each
 *      `changed_path` in input (A-3).
 *   7. return `ComputedPolicyRulesV1{ bundles, truncated: discovered.files_cap_hit }`.
 *
 * O(N_files + N_rules + N_paths) — cheap on realistic repo sizes; the A-1 cap
 * (`MAX_GUIDELINE_FILES_PER_REPO = 200`) bounds the worst case. Deterministic: same workspace + inputs →
 * byte-identical envelope (no clock/random; `node:crypto` sha256 is content-addressable; fs reads are
 * sorted before the cap).
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The frozen Python activity takes `payload_dict: dict` and validates it internally
 * (`ComputePolicyRulesInputV1.model_validate(payload_dict)`) — a dict-dispatch deviation from the
 * single-typed-input invariant. This port takes the TYPED {@link ComputePolicyRulesInputV1} directly;
 * the Temporal DataConverter handles serialization on the wire, so the activity body never re-validates
 * a raw dict. That CLOSES the dict-dispatch deviation, matching the sibling ported activities
 * (`classifyFiles`, `aggregateFindings`).
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. `discoverGuidelineFiles`
 * reads the cloned workspace via `node:fs` + hashes via `node:crypto`; both are permitted in an activity
 * (the check_clock_random gate scopes to clock/random, not fs/crypto). `computePolicyChain` is the pure
 * orchestration the Tier-1 parity oracle drives directly; `computePolicyRules` is the registered activity.
 */

import { discoverGuidelineFiles } from "#backend/policy/discover_repo_docs.js";
import { extractRules } from "#backend/policy/rule_extractor.js";
import { resolveGuidance } from "#backend/policy/scope_resolver.js";

import { type ExtractedRuleV1 } from "#contracts/extracted_rules.v1.js";
import {
  ComputedPolicyRulesV1,
  type ComputePolicyRulesInputV1,
} from "#contracts/policy_compute.v1.js";
import { type ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";

/**
 * The A-1 → A-2 → A-3 chain, ported EXACTLY (short-circuit + dedup/sort + discover + flatMap-extract +
 * per-path resolve). Pure orchestration over the three ported helpers — exported so the Tier-1 parity
 * oracle drives the same chain the activity runs (mirrors the frozen Python activity body).
 *
 * Returns the `ComputedPolicyRulesV1` envelope. When `knowledge_enabled` is false it short-circuits to
 * empty bundles WITHOUT walking the workspace (no `discoverGuidelineFiles` call).
 */
export function computePolicyChain(input: ComputePolicyRulesInputV1): ComputedPolicyRulesV1 {
  // Step 2: short-circuit on the customer opt-out — no workspace walk.
  if (!input.knowledge_enabled) {
    return ComputedPolicyRulesV1.parse({ schema_version: 1, bundles: {}, truncated: false });
  }

  // Step 3: dedup + sort the custom patterns (Python `tuple(sorted(set(input.custom_patterns)))`). JS
  // default string sort is UTF-16 code-unit order; for the ASCII pattern domain this matches Python's
  // str sort.
  const customPatterns = [...new Set(input.custom_patterns)].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  // Step 4: A-1 discovery walk.
  const discovered = discoverGuidelineFiles({
    workspace: input.workspace_path,
    customPatterns,
  });

  // Step 5: A-2 extraction over every discovered file, flattened in file order.
  const allRules: Array<ExtractedRuleV1> = [];
  for (const gf of discovered.files) {
    allRules.push(...extractRules(gf));
  }

  // Step 6: A-3 per-changed-path resolution. One bundle per input path; insertion order preserved (the
  // bundles map is keyed by changed_path, looked up O(1) by the workflow per chunk).
  const bundles: Record<string, ResolvedGuidanceBundleV1> = {};
  for (const cp of input.changed_paths) {
    // eslint-disable-next-line security/detect-object-injection -- write-only into a fresh local object; `cp` is a repo-relative changed-file path from the typed input, used purely as a string key (no prototype-chain read)
    bundles[cp] = resolveGuidance({ changedPath: cp, extractedRules: allRules });
  }

  // Step 7: forward A-1's cap-hit as `truncated`.
  return ComputedPolicyRulesV1.parse({
    schema_version: 1,
    bundles,
    truncated: discovered.files_cap_hit,
  });
}

/**
 * The registered activity. Takes the single typed {@link ComputePolicyRulesInputV1} envelope
 * (invariant 11 / ADR-0047) and delegates to {@link computePolicyChain}. No internal dict re-validation —
 * the DataConverter has already produced the typed input.
 */
export function computePolicyRules(
  input: ComputePolicyRulesInputV1,
): Promise<ComputedPolicyRulesV1> {
  return Promise.resolve(computePolicyChain(input));
}
