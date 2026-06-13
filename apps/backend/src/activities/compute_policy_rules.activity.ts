/**
 * `computePolicyRules` activity — workflow-callable wrapper over the deterministic A-1 → A-2 → A-3
 * chain (CLAUDE.md invariant 11 / ADR-0047).
 *
 * ## The chain
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
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047
 *
 * Takes the TYPED {@link ComputePolicyRulesInputV1} directly; the Temporal DataConverter handles
 * serialization on the wire, so the activity body never re-validates a raw dict.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. `discoverGuidelineFiles`
 * reads the cloned workspace via `node:fs` + hashes via `node:crypto`; both are permitted in an activity
 * (the check_clock_random gate scopes to clock/random, not fs/crypto). `computePolicyChain` is the pure
 * orchestration the Tier-1 parity oracle drives directly; `computePolicyRules` is the registered activity.
 */

import { setImmediate as setImmediateCb } from "node:timers";

import { discoverGuidelineFiles } from "#backend/policy/discover_repo_docs.js";
import { extractRules } from "#backend/policy/rule_extractor.js";
import { resolveGuidance } from "#backend/policy/scope_resolver.js";

import { type ExtractedRuleV1 } from "#contracts/extracted_rules.v1.js";
import {
  ComputedPolicyRulesV1,
  type ComputePolicyRulesInputV1,
} from "#contracts/policy_compute.v1.js";
import { type ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";

// ─── M9 caps (W4.4 — TS hardening divergence) ─────────────────────────────────────────────────────
// The A-1 cap bounds FILES (MAX_GUIDELINE_FILES_PER_REPO = 200), not RULES — a code-fence-confused
// or list-heavy doc set can mint rules far past anything useful — and `changed_paths` had NO cap, so
// resolution was unbounded O(changed_paths × total_rules) synchronous CPU. Both caps surface through
// the envelope's existing `truncated` flag. Sizing: 200 files × ~25 useful rules/file = 5000; 500
// changed paths matches the large-PR first-500 slice the diff side already imposes (XM10).

/** Hard ceiling on the total extracted rule count fed into per-path resolution. */
export const MAX_TOTAL_RULES = 5000;
/** Hard ceiling on the number of changed paths resolved into bundles (first-N, deterministic). */
export const MAX_CHANGED_PATHS = 500;

/** H6: resolve-loop yield cadence — between every RESOLVE_YIELD_EVERY paths the ACTIVITY yields to
 *  the macrotask queue so heartbeat timers can fire (the chain stays sync for the parity oracle). */
const RESOLVE_YIELD_EVERY = 20;

/** One macrotask-queue turn (NOT a microtask — timers must be able to fire in between). setImmediate
 *  is a scheduling primitive, not a wall-clock timer seam (the clock/random gate bans only
 *  setTimeout/setInterval/AbortSignal.timeout). */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediateCb(resolve);
  });
}

/** Dedup + sort of custom patterns (`tuple(sorted(set(...)))`; UTF-16 code-unit order matches on the
 *  ASCII pattern domain). */
function dedupSortPatterns(patterns: ReadonlyArray<string>): Array<string> {
  return [...new Set(patterns)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Append `rules` onto `all` under MAX_TOTAL_RULES; returns true when the cap clipped anything. */
function appendRulesCapped(all: Array<ExtractedRuleV1>, rules: ReadonlyArray<ExtractedRuleV1>): boolean {
  const remaining = MAX_TOTAL_RULES - all.length;
  if (remaining <= 0) {
    return rules.length > 0;
  }
  if (rules.length > remaining) {
    all.push(...rules.slice(0, remaining));
    return true;
  }
  all.push(...rules);
  return false;
}

/** First-N changed-paths slice under MAX_CHANGED_PATHS. */
function cappedChangedPaths(
  changedPaths: ReadonlyArray<string>,
): { paths: ReadonlyArray<string>; capped: boolean } {
  if (changedPaths.length <= MAX_CHANGED_PATHS) {
    return { paths: changedPaths, capped: false };
  }
  return { paths: changedPaths.slice(0, MAX_CHANGED_PATHS), capped: true };
}

/**
 * The A-1 → A-2 → A-3 chain (short-circuit + dedup/sort + discover + flatMap-extract + per-path
 * resolve). Pure orchestration over the three ported helpers — exported so the Tier-1 parity oracle
 * drives the same chain the activity runs.
 *
 * Returns the `ComputedPolicyRulesV1` envelope. When `knowledge_enabled` is false it short-circuits to
 * empty bundles WITHOUT walking the workspace (no `discoverGuidelineFiles` call).
 */
export function computePolicyChain(input: ComputePolicyRulesInputV1): ComputedPolicyRulesV1 {
  // Step 2: short-circuit on the customer opt-out — no workspace walk.
  if (!input.knowledge_enabled) {
    return ComputedPolicyRulesV1.parse({ schema_version: 1, bundles: {}, truncated: false });
  }

  // Step 3: dedup + sort the custom patterns.
  const customPatterns = dedupSortPatterns(input.custom_patterns);

  // Step 4: A-1 discovery walk.
  const discovered = discoverGuidelineFiles({
    workspace: input.workspace_path,
    customPatterns,
  });

  // Step 5: A-2 extraction over every discovered file, flattened in file order — bounded by
  // MAX_TOTAL_RULES (M9).
  const allRules: Array<ExtractedRuleV1> = [];
  let rulesCapped = false;
  for (const gf of discovered.files) {
    rulesCapped = appendRulesCapped(allRules, extractRules(gf)) || rulesCapped;
    if (allRules.length >= MAX_TOTAL_RULES) break;
  }

  // Step 6: A-3 per-changed-path resolution — bounded by MAX_CHANGED_PATHS (M9). One bundle per
  // resolved path; insertion order preserved (the bundles map is keyed by changed_path, looked up
  // O(1) by the workflow per chunk).
  const { paths, capped: pathsCapped } = cappedChangedPaths(input.changed_paths);
  const bundles: Record<string, ResolvedGuidanceBundleV1> = {};
  for (const cp of paths) {
    // eslint-disable-next-line security/detect-object-injection -- write-only into a fresh local object; `cp` is a repo-relative changed-file path from the typed input, used purely as a string key (no prototype-chain read)
    bundles[cp] = resolveGuidance({ changedPath: cp, extractedRules: allRules });
  }

  // Step 7: `truncated` = A-1's file-cap hit OR either M9 cap.
  return ComputedPolicyRulesV1.parse({
    schema_version: 1,
    bundles,
    truncated: discovered.files_cap_hit || rulesCapped || pathsCapped,
  });
}

/**
 * The registered activity. Takes the single typed {@link ComputePolicyRulesInputV1} envelope
 * (invariant 11 / ADR-0047). No internal dict re-validation — the DataConverter has already produced
 * the typed input.
 *
 * ## H6 (W4.4) — the cooperative-yield slice
 *
 * The chain used to run ENTIRELY synchronously inside `Promise.resolve(...)`: the runner's
 * `setTimeout`-based hard-timeout and the lease heartbeat CANNOT fire while a synchronous burst
 * holds the loop, so a big repo's policy compute could starve the heartbeat into a lease lapse
 * (duplicate review) and stall every co-tenant job on the pod. This activity now runs the SAME
 * steps as {@link computePolicyChain} (same helpers, same caps — the per-step cap logic lives once)
 * but yields to the MACROTASK queue between extracted files and every {@link RESOLVE_YIELD_EVERY}
 * resolved paths. The full worker_threads offload (a real preemptive timeout race) stays the
 * tracked L-effort follow-up; threading an AbortSignal INTO the compute is W4.1 (RT5).
 */
export async function computePolicyRules(
  input: ComputePolicyRulesInputV1,
): Promise<ComputedPolicyRulesV1> {
  if (!input.knowledge_enabled) {
    return ComputedPolicyRulesV1.parse({ schema_version: 1, bundles: {}, truncated: false });
  }
  const customPatterns = dedupSortPatterns(input.custom_patterns);
  const discovered = discoverGuidelineFiles({
    workspace: input.workspace_path,
    customPatterns,
  });

  const allRules: Array<ExtractedRuleV1> = [];
  let rulesCapped = false;
  for (const gf of discovered.files) {
    rulesCapped = appendRulesCapped(allRules, extractRules(gf)) || rulesCapped;
    if (allRules.length >= MAX_TOTAL_RULES) break;
    await yieldToEventLoop(); // H6: heartbeat/timer turn between files
  }

  const { paths, capped: pathsCapped } = cappedChangedPaths(input.changed_paths);
  const bundles: Record<string, ResolvedGuidanceBundleV1> = {};
  for (let i = 0; i < paths.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bounded numeric loop index into a local ReadonlyArray slice, not an attacker-controlled object key
    const cp = paths[i]!;
    // eslint-disable-next-line security/detect-object-injection -- write-only into a fresh local object; `cp` is a repo-relative changed-file path from the typed input, used purely as a string key (no prototype-chain read)
    bundles[cp] = resolveGuidance({ changedPath: cp, extractedRules: allRules });
    if ((i + 1) % RESOLVE_YIELD_EVERY === 0) {
      await yieldToEventLoop(); // H6: heartbeat/timer turn between path batches
    }
  }

  return ComputedPolicyRulesV1.parse({
    schema_version: 1,
    bundles,
    truncated: discovered.files_cap_hit || rulesCapped || pathsCapped,
  });
}
