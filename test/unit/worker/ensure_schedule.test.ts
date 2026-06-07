import { ScheduleAlreadyRunning, ScheduleOverlapPolicy } from "@temporalio/client";
import type { ScheduleOptions } from "@temporalio/client";
import { describe, expect, it } from "vitest";

import {
  ensureCronSchedule,
  ensureIntervalSchedule,
  type ScheduleCreatingClient,
} from "#backend/worker/ensure_schedule.js";

// Unit test for the shared Temporal Schedule-bootstrap seam (ADR-0074). A mock client records the
// `schedule.create` options so we can assert the cron spec + overlap=SKIP + startWorkflow action, and
// simulate the idempotency (ScheduleAlreadyRunning swallowed) + fail-open (other errors re-thrown) paths.
function fakeClient(behavior?: { throwOnCreate?: unknown }): {
  created: Array<ScheduleOptions>;
  client: ScheduleCreatingClient;
} {
  const created: Array<ScheduleOptions> = [];
  const client: ScheduleCreatingClient = {
    schedule: {
      create: async (options: ScheduleOptions): Promise<{ scheduleId: string }> => {
        created.push(options);
        if (behavior?.throwOnCreate !== undefined) {
          throw behavior.throwOnCreate;
        }
        return { scheduleId: options.scheduleId };
      },
    },
  };
  return { created, client };
}

const ARGS = {
  scheduleId: "codemaster-mutex-janitor",
  workflowType: "mutexJanitorWorkflow",
  workflowId: "codemaster-mutex-janitor-workflow",
  taskQueue: "review-default",
  cronExpression: "*/5 * * * *",
};

describe("ensureCronSchedule", () => {
  it("creates a cron schedule with overlap=SKIP and a startWorkflow action", async () => {
    const { created, client } = fakeClient();
    await ensureCronSchedule(client, ARGS);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      scheduleId: ARGS.scheduleId,
      spec: { cronExpressions: [ARGS.cronExpression] },
      action: {
        type: "startWorkflow",
        workflowType: ARGS.workflowType,
        taskQueue: ARGS.taskQueue,
        workflowId: ARGS.workflowId,
        args: [],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
  });

  it("is idempotent — swallows ScheduleAlreadyRunning (never overwrites operator tuning)", async () => {
    const { client } = fakeClient({
      throwOnCreate: new ScheduleAlreadyRunning("schedule already running", ARGS.scheduleId),
    });
    await expect(ensureCronSchedule(client, ARGS)).resolves.toBeUndefined();
  });

  it("re-throws any other error (transient Temporal / RBAC) to the fail-open boot caller", async () => {
    const { client } = fakeClient({ throwOnCreate: new Error("temporal unavailable") });
    await expect(ensureCronSchedule(client, ARGS)).rejects.toThrow("temporal unavailable");
  });
});

// Wave-4 Confluence interval schedule (combined-pod, ADR-0075). The Python uses an INTERVAL cadence
// (`ScheduleIntervalSpec(every=timedelta(hours=6))`), NOT a cron expression — so the SDK `spec` is
// `{ intervals: [{ every }] }`. A numeric `every` Duration is milliseconds, so intervalSeconds × 1000.
const INTERVAL_ARGS = {
  scheduleId: "refresh-confluence-corpus",
  workflowType: "confluenceIngestWorkflow",
  workflowId: "refresh-confluence-corpus-workflow",
  taskQueue: "review-default",
  intervalSeconds: 6 * 60 * 60,
  actionInput: { schema_version: 1 },
};

describe("ensureIntervalSchedule", () => {
  it("creates an interval schedule with overlap=SKIP and a startWorkflow action", async () => {
    const { created, client } = fakeClient();
    await ensureIntervalSchedule(client, INTERVAL_ARGS);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      scheduleId: INTERVAL_ARGS.scheduleId,
      // 6h → 21600s → 21_600_000 ms (the SDK interprets a numeric `every` Duration as milliseconds).
      spec: { intervals: [{ every: INTERVAL_ARGS.intervalSeconds * 1000 }] },
      action: {
        type: "startWorkflow",
        workflowType: INTERVAL_ARGS.workflowType,
        taskQueue: INTERVAL_ARGS.taskQueue,
        workflowId: INTERVAL_ARGS.workflowId,
        // The default-constructed workflow input MUST be threaded (not []), else parse(undefined) throws.
        args: [{ schema_version: 1 }],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
  });

  it("is idempotent — swallows ScheduleAlreadyRunning (never overwrites operator tuning)", async () => {
    const { client } = fakeClient({
      throwOnCreate: new ScheduleAlreadyRunning("schedule already running", INTERVAL_ARGS.scheduleId),
    });
    await expect(ensureIntervalSchedule(client, INTERVAL_ARGS)).resolves.toBeUndefined();
  });

  it("re-throws any other error (transient Temporal / RBAC) to the fail-open boot caller", async () => {
    const { client } = fakeClient({ throwOnCreate: new Error("temporal unavailable") });
    await expect(ensureIntervalSchedule(client, INTERVAL_ARGS)).rejects.toThrow("temporal unavailable");
  });
});
