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

  it("threads the default-constructed actionInput when present (the run_id retention TTL input)", async () => {
    // The Wave-2 run_id retention cron passes a default TTL input {prTtlDays,runTtlDays,eventTtlDays} — the
    // workflow body reads those fields with NO internal default, so the schedule MUST emit args=[input] (1:1
    // with the Python args=[7,30,90]). A 0-arg cron (mutex/reaper/partition) omits actionInput → args:[].
    const { created, client } = fakeClient();
    const actionInput = { prTtlDays: 7, runTtlDays: 30, eventTtlDays: 90 };
    await ensureCronSchedule(client, {
      scheduleId: "codemaster-run-id-retention",
      workflowType: "runIdRetentionWorkflow",
      workflowId: "codemaster-run-id-retention-workflow",
      taskQueue: "review-default",
      cronExpression: "0 3 * * *",
      actionInput,
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      scheduleId: "codemaster-run-id-retention",
      spec: { cronExpressions: ["0 3 * * *"] },
      action: {
        type: "startWorkflow",
        workflowType: "runIdRetentionWorkflow",
        taskQueue: "review-default",
        workflowId: "codemaster-run-id-retention-workflow",
        // When actionInput is present, the action emits args:[actionInput] (NOT []).
        args: [actionInput],
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

  it("emits args:[] for a 0-arg interval workflow (workspace_retention — actionInput omitted)", async () => {
    // The Wave-2 workspace-retention workflow takes NO input — the Python `ensure_workspace_retention_schedule`
    // registers `args=[]`. So the TS schedule omits actionInput and the action MUST emit args:[] (NOT
    // args:[undefined], which would hand the 0-arg workflow a spurious positional + drift from the Python).
    const { created, client } = fakeClient();
    await ensureIntervalSchedule(client, {
      scheduleId: "codemaster-workspace-retention",
      workflowType: "workspaceRetentionWorkflow",
      workflowId: "codemaster-workspace-retention-workflow",
      taskQueue: "review-default",
      intervalSeconds: 5 * 60,
      // actionInput intentionally OMITTED — 0-arg workflow.
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      scheduleId: "codemaster-workspace-retention",
      // 5min → 300s → 300_000 ms.
      spec: { intervals: [{ every: 5 * 60 * 1000 }] },
      action: {
        type: "startWorkflow",
        workflowType: "workspaceRetentionWorkflow",
        taskQueue: "review-default",
        workflowId: "codemaster-workspace-retention-workflow",
        // No actionInput → args:[] (1:1 with the Python `args=[]`).
        args: [],
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
