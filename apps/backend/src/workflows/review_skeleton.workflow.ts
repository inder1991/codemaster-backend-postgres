/**
 * `reviewSkeleton` workflow — the thinnest real Temporal-TS workflow body: it proxies the ONE skeleton
 * activity ({@link persistReviewFindings}) and returns its result. Phase-2.0 walking skeleton; the
 * foundational workflow pattern that all of Phase 2.1+ (the real review fan-out) reuses.
 *
 * ## ADR-0065 crypto boundary (the rule this module establishes)
 *
 * This module is bundled into the Temporal V8-isolate **workflow sandbox**, which BANS `node:crypto`.
 * Therefore it imports ONLY:
 *   - `@temporalio/workflow` (the sandbox-safe workflow API surface), and
 *   - the **type-only** input/output shapes from `#contracts/persist_review_findings.v1.js`.
 *
 * The `import type { ... }` is load-bearing: with `verbatimModuleSyntax` (tsconfig) a type-only import
 * is ERASED at emit, so NO runtime edge is created to the contract module — even though
 * `persist_review_findings.v1.ts` itself is crypto-free, importing it for VALUES would pull its (and its
 * transitive contracts') runtime graph into the bundle. The two known crypto-importing contracts
 * (`diff_chunking.v1`, `retrieved_evidence.v1`) are NOT reachable from this module at all; the type-only
 * discipline keeps it that way structurally. The build-time proof is `scripts/check_workflow_bundle.ts`.
 *
 * ## Determinism
 *
 * The body does no clock / random / uuid work — it only proxies the activity. All non-deterministic work
 * (minting, hashing, DB writes, wall-clock reads) happens INSIDE the activity, in the normal Node runtime.
 * `proxyActivities` returns stubs that the SDK turns into deterministic ScheduleActivityTask commands.
 */

import { proxyActivities } from "@temporalio/workflow";

import type { PersistReviewFindingsInputV1 } from "#contracts/persist_review_findings.v1.js";

/**
 * Activity stubs for this workflow. The type parameter names exactly the activity surface this workflow
 * may call (`persistReviewFindings`), so a typo or a signature drift is a compile error. `maximumAttempts:
 * 1` keeps the skeleton single-shot (no hidden retry behaviour to reason about); `startToCloseTimeout`
 * bounds the single attempt. Grown additively in 2.1 as more activities join the surface.
 */
const acts = proxyActivities<{
  persistReviewFindings(input: PersistReviewFindingsInputV1): Promise<Array<string>>;
}>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

/**
 * The skeleton workflow: take the typed input envelope, persist via the activity, return the ordered
 * finding ids. A pure proxy — the foundational shape Phase 2.1 grows into the real review pipeline.
 */
export async function reviewSkeleton(
  input: PersistReviewFindingsInputV1,
): Promise<Array<string>> {
  return await acts.persistReviewFindings(input);
}
