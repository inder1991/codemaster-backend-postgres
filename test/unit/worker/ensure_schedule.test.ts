import { ScheduleAlreadyRunning, ScheduleOverlapPolicy } from "@temporalio/client";
import type { ScheduleOptions } from "@temporalio/client";
import { describe, expect, it } from "vitest";

import {
  ensureCronSchedule,
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
