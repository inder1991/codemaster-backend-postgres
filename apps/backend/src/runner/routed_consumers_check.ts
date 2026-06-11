import { REVIEW_WORKFLOW_TYPE } from "#backend/ingest/github_webhook_persistence.js";

import type { HandlerRegistry } from "./handler_registry.js";
import { WORKFLOW_TYPE_TO_JOB_TYPE } from "./workflow_job_map.js";

// CS2.2 (cutover-safety plan, finding CS2 — closes audit C6/OC4): the FAIL-LOUD boot self-check
// that EVERY workflow_type the cutover routes has a CONSUMER in the booted runtime — "never
// enqueue into a table nothing drains".
//
// The cutover's outbox port (background_jobs_temporal_port.ts) routes every produced
// `temporal_workflow_start` row onto exactly one of two consumer platforms:
//
//   * the mapped event workflow_types (WORKFLOW_TYPE_TO_JOB_TYPE) → core.background_jobs rows,
//     consumed by the BackgroundRunnerLoop dispatching through the HandlerRegistry — a routed
//     job_type with NO registered handler dead-letters every row (`no handler for <job_type>`);
//   * REVIEW_WORKFLOW_TYPE (`reviewPullRequest`) → core.review_jobs rows, consumed ONLY by the
//     CS2.1 REVIEW RunnerLoop — without it the routed jobs sit 'ready' forever (the exact C6 gap:
//     pre-CS2.1 the composition routed onto the table but NOTHING drained it).
//
// runBackgroundRunner calls {@link assertRoutedWorkflowTypesHaveConsumers} AFTER building the
// runtime (buildBackgroundRunner) and BEFORE starting any loop / wiring sinks / seeding schedules,
// so a mis-composed runner (a map entry added without its handler registration; a review loop
// accidentally dropped from the composition) REFUSES TO SERVE at boot — one crash naming every gap
// — instead of silently stranding routed work in production.

/** What the self-check inspects — derived from the built {@link import("./background_runner_main.js").BackgroundRunnerHandles}. */
export type RoutedConsumersCheckArgs = {
  /** The runtime's job_type → handler dispatch seam (the background-jobs consumer surface). */
  registry: HandlerRegistry;
  /** Whether the CS2.1 REVIEW RunnerLoop was composed (`handles.reviewLoop !== undefined`) — the
   *  ONLY consumer of core.review_jobs, the table `reviewPullRequest` is routed onto. */
  reviewLoopBooted: boolean;
  /** The CS1.2 mode posture. THE DOCUMENTED SHADOW EXCEPTION: in shadow the review loop is omitted
   *  BY DESIGN (CS2.1 — the review pipeline performs heavy GitHub/LLM side effects, so shadow
   *  observes-not-consumes reviews; the shadow port performs would-enqueue only, so no real
   *  core.review_jobs row is ever produced to strand). Shadow boot therefore PASSES with
   *  `reviewLoopBooted=false` — and FAILS with `reviewLoopBooted=true` (a review loop composed in
   *  shadow contradicts the no-side-effects posture). */
  shadow: boolean;
};

/**
 * Assert every routed workflow_type has a consumer; THROW (aggregating ALL gaps into one error)
 * when any routed workflow_type would enqueue into a table nothing drains. Pure — no I/O.
 */
export function assertRoutedWorkflowTypesHaveConsumers(args: RoutedConsumersCheckArgs): void {
  const problems: Array<string> = [];

  // The mapped event workflow_types: consumer = a registered HandlerRegistry handler per job_type.
  for (const [workflowType, jobType] of Object.entries(WORKFLOW_TYPE_TO_JOB_TYPE)) {
    if (args.registry.get(jobType) === undefined) {
      problems.push(
        `routed workflow_type '${workflowType}' has NO consumer: its job_type '${jobType}' is not ` +
          `registered in the HandlerRegistry — every enqueued core.background_jobs row would ` +
          `dead-letter as 'no handler for ${jobType}'`,
      );
    }
  }

  // REVIEW_WORKFLOW_TYPE: consumer = the CS2.1 REVIEW RunnerLoop over core.review_jobs.
  if (!args.reviewLoopBooted && !args.shadow) {
    problems.push(
      `routed workflow_type '${REVIEW_WORKFLOW_TYPE}' has NO consumer: the cutover routes it onto ` +
        `core.review_jobs, whose ONLY consumer is the REVIEW RunnerLoop (CS2.1), and the review ` +
        `loop is NOT booted — every enqueued review job would sit 'ready' forever and stuck rows ` +
        `would never be reaped`,
    );
  } else if (args.reviewLoopBooted && args.shadow) {
    problems.push(
      `shadow mode must NOT boot the REVIEW RunnerLoop, but reviewLoopBooted=true — CS1.2/CS2.1: ` +
        `shadow omits the review loop entirely (the review pipeline performs heavy GitHub/LLM side ` +
        `effects; shadow observes routed reviews, never consumes them)`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `cutover boot self-check FAILED (CS2.2 — audit C6/OC4: never enqueue into a table nothing ` +
        `drains). ${problems.length} routed consumer gap(s); REFUSING to start the loops:` +
        problems.map((p) => `\n  * ${p}`).join(""),
    );
  }
}
