// Unit tests for the combined-entrypoint boot composition (Phase 4d review blocker #6): the
// PURE resolveBootTasks(env, deps) seam decides WHICH long-running tasks join main.ts's fail-loud
// Promise.all — WITHOUT booting anything (deps are injected thunks; nothing here touches HTTP,
// Temporal, or Postgres).
//
// The flag under test: CODEMASTER_RUN_BACKGROUND_RUNNER (default OFF). OFF → the task list is
// byte-identical to the pre-flag boot (Temporal worker + Temporal outbox dispatcher; NO background
// runner). ON ("true"/"1") → the background runner joins the list. The flag MUST stay OFF while the
// Temporal worker (with its Temporal Schedules) also runs — booting both double-runs the crons; it
// flips ON only at the Phase-4 cutover when the Temporal worker is removed from the boot.

import { describe, expect, it, vi } from "vitest";

import {
  RUN_BACKGROUND_RUNNER_ENV,
  resolveBootTasks,
  type BootDeps,
} from "#backend/boot_tasks.js";

/** Injected thunks that EXPLODE if invoked — resolveBootTasks must COMPOSE, never BOOT. */
function explodingDeps(): BootDeps {
  return {
    runWorker: vi.fn(async () => {
      throw new Error("runWorker must not be invoked by resolveBootTasks");
    }),
    runOutboxDispatcherWorker: vi.fn(async () => {
      throw new Error("runOutboxDispatcherWorker must not be invoked by resolveBootTasks");
    }),
    runBackgroundRunner: vi.fn(async () => {
      throw new Error("runBackgroundRunner must not be invoked by resolveBootTasks");
    }),
  };
}

describe("resolveBootTasks", () => {
  it("flag UNSET (the default) → Temporal worker + outbox dispatcher ONLY; NO background runner", () => {
    const deps = explodingDeps();
    const tasks = resolveBootTasks({}, deps);
    expect(tasks.map((t) => t.name)).toEqual(["temporal-worker", "temporal-outbox-dispatcher"]);
  });

  it.each(["false", "0", ""])("flag '%s' → byte-identical to unset (no background runner)", (raw) => {
    const deps = explodingDeps();
    const tasks = resolveBootTasks({ [RUN_BACKGROUND_RUNNER_ENV]: raw }, deps);
    expect(tasks.map((t) => t.name)).toEqual(["temporal-worker", "temporal-outbox-dispatcher"]);
  });

  it.each(["true", "1"])("flag '%s' → the background runner JOINS the concurrent boot", (raw) => {
    const deps = explodingDeps();
    const tasks = resolveBootTasks({ [RUN_BACKGROUND_RUNNER_ENV]: raw }, deps);
    expect(tasks.map((t) => t.name)).toEqual([
      "temporal-worker",
      "temporal-outbox-dispatcher",
      "background-runner",
    ]);
  });

  it("the composed task thunks ARE the injected deps (identity — no wrapping, no early invocation)", () => {
    const deps = explodingDeps();
    const tasks = resolveBootTasks({ [RUN_BACKGROUND_RUNNER_ENV]: "true" }, deps);
    expect(tasks[0]?.run).toBe(deps.runWorker);
    expect(tasks[1]?.run).toBe(deps.runOutboxDispatcherWorker);
    expect(tasks[2]?.run).toBe(deps.runBackgroundRunner);
  });

  it("resolveBootTasks NEVER invokes any dep (composition only — main.ts owns when tasks run)", () => {
    const deps = explodingDeps();
    resolveBootTasks({}, deps);
    resolveBootTasks({ [RUN_BACKGROUND_RUNNER_ENV]: "true" }, deps);
    expect(deps.runWorker).not.toHaveBeenCalled();
    expect(deps.runOutboxDispatcherWorker).not.toHaveBeenCalled();
    expect(deps.runBackgroundRunner).not.toHaveBeenCalled();
  });

  it.each(["yes", "TRUE", "on", "2"])(
    "garbage flag value '%s' → throws (fail-loud; a typo'd cutover flag must refuse boot)",
    (raw) => {
      const deps = explodingDeps();
      expect(() => resolveBootTasks({ [RUN_BACKGROUND_RUNNER_ENV]: raw }, deps)).toThrow(
        /CODEMASTER_RUN_BACKGROUND_RUNNER/,
      );
    },
  );
});
