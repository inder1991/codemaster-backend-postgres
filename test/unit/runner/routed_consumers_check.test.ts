// test/unit/runner/routed_consumers_check.test.ts
//
// CS2.2 (cutover-safety plan, finding CS2 — closes audit C6/OC4): the FAIL-LOUD boot self-check that
// EVERY workflow_type the cutover routes has a CONSUMER — "never enqueue into a table nothing drains".
// The cutover's outbox port routes the mapped event workflow_types onto core.background_jobs (drained
// by the HandlerRegistry-dispatching BackgroundRunnerLoop) and `reviewPullRequest` onto
// core.review_jobs (drained by the CS2.1 REVIEW RunnerLoop). A map entry whose job_type has no
// registered handler — or a postgres-mode boot without the review loop — means routed work strands
// forever (dead-letter / 'ready' rows nothing claims). The check runs at boot, AFTER the runtime is
// built and BEFORE any loop starts, so a mis-composed runner refuses to serve instead of silently
// stranding work. Proves:
//
//   (1) the FULL consumer surface (every WORKFLOW_TYPE_TO_JOB_TYPE value registered + review loop
//       booted, postgres mode) PASSES;
//   (2) for EVERY routed map entry: a registry missing THAT job_type's handler THROWS, naming the
//       workflow_type AND its missing job_type (data-driven over the real map — stays lockstep as
//       the map widens);
//   (3) MULTIPLE missing consumers are ALL named in ONE error (boot diagnostics: one crash names
//       every gap, not a fix-one-reboot-discover-the-next loop);
//   (4) postgres mode with `reviewPullRequest` routed but the review loop NOT booted THROWS naming
//       reviewPullRequest + its consumer (the review loop);
//   (5) the DOCUMENTED SHADOW EXCEPTION: shadow omits the review loop BY DESIGN (CS2.1 — shadow
//       observes, never consumes reviews; the shadow port performs would-enqueue only), so shadow +
//       reviewLoopBooted=false PASSES — shadow boot must not falsely fail;
//   (6) the INVERSE shadow guard: shadow + reviewLoopBooted=true THROWS (a review loop composed in
//       shadow contradicts the CS1.2 no-side-effects posture);
//   (7) LOCKSTEP with the REAL composition root: buildBackgroundRunner's actual handles (DSN-less,
//       never-connected pool — the seam is pure) pass the check in BOTH modes, with reviewLoopBooted
//       derived exactly as runBackgroundRunner derives it (`handles.reviewLoop !== undefined`).
//
// Pure unit — no DB, no env. The never-connected pg Pool in (7) follows runner_dispose.test.ts.

import { describe, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { FakeClock } from "#platform/clock.js";

import { REVIEW_WORKFLOW_TYPE } from "#backend/ingest/github_webhook_persistence.js";
import {
  buildBackgroundRunner,
  type BackgroundRunnerConfig,
} from "#backend/runner/background_runner_main.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { assertRoutedWorkflowTypesHaveConsumers } from "#backend/runner/routed_consumers_check.js";
import { WORKFLOW_TYPE_TO_JOB_TYPE } from "#backend/runner/workflow_job_map.js";

/** Every routed (workflow_type → job_type) pair from the REAL map — the data-driven test surface. */
const ROUTED_ENTRIES = Object.entries(WORKFLOW_TYPE_TO_JOB_TYPE);

/** A registry with a no-op handler for every routed job_type EXCEPT `omit` (Set-deduped so a future
 *  two-workflow_types-one-job_type map entry can't trip the duplicate-registration throw). */
function registryWithAllRoutedHandlersExcept(omit: ReadonlySet<string> = new Set()): HandlerRegistry {
  const registry = new HandlerRegistry();
  for (const jobType of new Set(Object.values(WORKFLOW_TYPE_TO_JOB_TYPE))) {
    if (!omit.has(jobType)) {
      registry.register(jobType, async () => {});
    }
  }
  return registry;
}

describe("assertRoutedWorkflowTypesHaveConsumers (CS2.2 — every routed workflow_type has a consumer)", () => {
  it("(1) full consumer surface passes: all routed job_types registered + review loop booted (postgres)", () => {
    expect(ROUTED_ENTRIES.length).toBeGreaterThan(0); // the map is non-empty — the loop below is live
    expect(() =>
      assertRoutedWorkflowTypesHaveConsumers({
        registry: registryWithAllRoutedHandlersExcept(),
        reviewLoopBooted: true,
        shadow: false,
      }),
    ).not.toThrow();
  });

  it("(2) EVERY routed entry: a registry missing that job_type's handler throws naming workflow_type + job_type", () => {
    for (const [workflowType, jobType] of ROUTED_ENTRIES) {
      const registry = registryWithAllRoutedHandlersExcept(new Set([jobType]));
      const run = (): void =>
        assertRoutedWorkflowTypesHaveConsumers({ registry, reviewLoopBooted: true, shadow: false });
      expect(run).toThrow(workflowType); // names the routed workflow_type ...
      expect(run).toThrow(jobType); // ... AND its missing consumer (the unregistered job_type)
    }
  });

  it("(3) multiple missing consumers are ALL named in one error", () => {
    const [first, second] = ROUTED_ENTRIES;
    if (first === undefined || second === undefined) {
      throw new Error("test precondition: WORKFLOW_TYPE_TO_JOB_TYPE must have >= 2 entries");
    }
    const registry = registryWithAllRoutedHandlersExcept(new Set([first[1], second[1]]));
    const run = (): void =>
      assertRoutedWorkflowTypesHaveConsumers({ registry, reviewLoopBooted: true, shadow: false });
    expect(run).toThrow(first[0]);
    expect(run).toThrow(second[0]);
  });

  it("(4) postgres mode with the review loop NOT booted throws naming reviewPullRequest + its consumer", () => {
    const run = (): void =>
      assertRoutedWorkflowTypesHaveConsumers({
        registry: registryWithAllRoutedHandlersExcept(),
        reviewLoopBooted: false,
        shadow: false,
      });
    expect(run).toThrow(REVIEW_WORKFLOW_TYPE); // names the routed workflow_type ...
    expect(run).toThrow(/review/i); // ... and its missing consumer (the REVIEW RunnerLoop)
    expect(run).toThrow(/RunnerLoop|review loop/i);
  });

  it("(5) the DOCUMENTED SHADOW EXCEPTION: shadow + review loop not booted PASSES (observed-not-consumed)", () => {
    expect(() =>
      assertRoutedWorkflowTypesHaveConsumers({
        registry: registryWithAllRoutedHandlersExcept(),
        reviewLoopBooted: false,
        shadow: true,
      }),
    ).not.toThrow();
  });

  it("(6) the INVERSE shadow guard: shadow + review loop booted throws (contradicts the no-side-effects posture)", () => {
    expect(() =>
      assertRoutedWorkflowTypesHaveConsumers({
        registry: registryWithAllRoutedHandlersExcept(),
        reviewLoopBooted: true,
        shadow: true,
      }),
    ).toThrow(/shadow/i);
  });

  it("(7) LOCKSTEP: the REAL buildBackgroundRunner handles pass the check in BOTH modes", async () => {
    // buildBackgroundRunner performs NO I/O (the pg pool is lazy) — a never-connected pool suffices
    // (the runner_dispose.test.ts idiom). This pins (a) every WORKFLOW_TYPE_TO_JOB_TYPE value has a
    // REAL registered handler at the composition root, and (b) the shadow exception matches the real
    // shadow composition (reviewLoop omitted), so the boot-time call can never falsely fail.
    const config: BackgroundRunnerConfig = {
      owner: "cs2_2-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300, idleS: 30,
      pollIntervalS: 600, outboxIdleS: 600, outboxMaxAttempts: 5,
    };
    const pool = new Pool({ connectionString: "postgresql://unused:unused@127.0.0.1:1/unused" });
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    try {
      for (const shadow of [false, true]) {
        const handles = buildBackgroundRunner({ db, clock: new FakeClock(), config, shadow });
        // Derived EXACTLY as the runBackgroundRunner call site derives it.
        const reviewLoopBooted = handles.reviewLoop !== undefined;
        expect(reviewLoopBooted).toBe(!shadow); // CS2.1: composed iff non-shadow
        expect(() =>
          assertRoutedWorkflowTypesHaveConsumers({ registry: handles.registry, reviewLoopBooted, shadow }),
        ).not.toThrow();
      }
    } finally {
      // Never-connected: destroy() alone suffices (no disposePool — this test owns its own pool).
      await db.destroy();
    }
  });
});
