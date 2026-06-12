// Boot composition (post-Temporal-teardown): CODEMASTER_RUNTIME_MODE selects the Postgres runtime.
// Temporal is gone — the mode vocabulary is now { postgres (default), shadow }; a stale
// CODEMASTER_RUNTIME_MODE=temporal REFUSES boot naming the removal; the two removed cutover booleans
// (CODEMASTER_RUN_BACKGROUND_RUNNER + CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS) still refuse boot when
// set. resolveBootTasks always composes EXACTLY the background runner, threading the resolved mode.

import { describe, expect, it, vi } from "vitest";

import {
  DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV,
  DEPRECATED_RUN_BACKGROUND_RUNNER_ENV,
  RUNTIME_MODE_ENV,
  parseRuntimeMode,
  resolveBootTasks,
  type BootDeps,
} from "#backend/boot_tasks.js";

/** Injected thunk that EXPLODES if invoked — resolveBootTasks must COMPOSE, never BOOT. */
function explodingDeps(): BootDeps {
  return {
    runBackgroundRunner: vi.fn(async () => {
      throw new Error("runBackgroundRunner must not be invoked by resolveBootTasks");
    }),
  };
}

/** Deps whose runner thunk RECORDS the mode it received. */
function recordingRunnerDeps(): { deps: BootDeps; receivedModes: Array<string> } {
  const receivedModes: Array<string> = [];
  return {
    deps: {
      runBackgroundRunner: async (mode) => {
        receivedModes.push(mode);
      },
    },
    receivedModes,
  };
}

describe("parseRuntimeMode", () => {
  it("unset → 'postgres' (the live runtime is the default)", () => {
    expect(parseRuntimeMode({})).toBe("postgres");
  });

  it("empty string → 'postgres' (Helm templating may render empty values)", () => {
    expect(parseRuntimeMode({ [RUNTIME_MODE_ENV]: "" })).toBe("postgres");
  });

  it.each(["postgres", "shadow"] as const)("'%s' parses to itself", (mode) => {
    expect(parseRuntimeMode({ [RUNTIME_MODE_ENV]: mode })).toBe(mode);
  });

  it("'temporal' REFUSES boot — the Temporal runtime was removed", () => {
    expect(() => parseRuntimeMode({ [RUNTIME_MODE_ENV]: "temporal" })).toThrow(/REMOVED/);
    expect(() => parseRuntimeMode({ [RUNTIME_MODE_ENV]: "temporal" })).toThrow(/postgres/);
  });

  it.each(["true", "1", "Postgres", " postgres", "both", "none"])(
    "garbage '%s' REFUSES boot, naming the env var AND the valid values",
    (raw) => {
      expect(() => parseRuntimeMode({ [RUNTIME_MODE_ENV]: raw })).toThrow(RUNTIME_MODE_ENV);
      expect(() => parseRuntimeMode({ [RUNTIME_MODE_ENV]: raw })).toThrow(/postgres\|shadow/);
    },
  );

  it.each(["true", "1", "false", "0", "banana"])(
    "DEPRECATED CODEMASTER_RUN_BACKGROUND_RUNNER='%s' REFUSES boot naming the replacement — even alongside a VALID mode",
    (raw) => {
      const env = { [RUNTIME_MODE_ENV]: "postgres", [DEPRECATED_RUN_BACKGROUND_RUNNER_ENV]: raw };
      expect(() => parseRuntimeMode(env)).toThrow(DEPRECATED_RUN_BACKGROUND_RUNNER_ENV);
      expect(() => parseRuntimeMode(env)).toThrow(RUNTIME_MODE_ENV);
    },
  );

  it.each(["true", "1", "false", "0", "banana"])(
    "DEPRECATED CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS='%s' REFUSES boot naming the replacement",
    (raw) => {
      const env = { [DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV]: raw };
      expect(() => parseRuntimeMode(env)).toThrow(DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV);
      expect(() => parseRuntimeMode(env)).toThrow(RUNTIME_MODE_ENV);
    },
  );

  it("deprecated vars unset or empty are tolerated (absent stale config is fine)", () => {
    expect(
      parseRuntimeMode({
        [DEPRECATED_RUN_BACKGROUND_RUNNER_ENV]: "",
        [DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV]: "",
      }),
    ).toBe("postgres");
  });
});

describe("resolveBootTasks", () => {
  it("mode UNSET (the default) → EXACTLY [background-runner], threading mode='postgres'", async () => {
    const { deps, receivedModes } = recordingRunnerDeps();
    const tasks = resolveBootTasks({}, deps);
    expect(tasks.map((t) => t.name)).toEqual(["background-runner"]);
    await tasks[0]!.run();
    expect(receivedModes).toEqual(["postgres"]);
  });

  it("mode 'postgres' → EXACTLY [background-runner]; invoking its thunk threads mode='postgres'", async () => {
    const { deps, receivedModes } = recordingRunnerDeps();
    const tasks = resolveBootTasks({ [RUNTIME_MODE_ENV]: "postgres" }, deps);
    expect(tasks.map((t) => t.name)).toEqual(["background-runner"]);
    await tasks[0]!.run();
    expect(receivedModes).toEqual(["postgres"]);
  });

  it("mode 'shadow' → EXACTLY [background-runner]; invoking its thunk threads mode='shadow'", async () => {
    const { deps, receivedModes } = recordingRunnerDeps();
    const tasks = resolveBootTasks({ [RUNTIME_MODE_ENV]: "shadow" }, deps);
    expect(tasks.map((t) => t.name)).toEqual(["background-runner"]);
    await tasks[0]!.run();
    expect(receivedModes).toEqual(["shadow"]);
  });

  it("resolveBootTasks NEVER invokes the dep (composition only — main.ts owns when tasks run)", () => {
    const deps = explodingDeps();
    resolveBootTasks({}, deps);
    resolveBootTasks({ [RUNTIME_MODE_ENV]: "postgres" }, deps);
    resolveBootTasks({ [RUNTIME_MODE_ENV]: "shadow" }, deps);
    expect(deps.runBackgroundRunner).not.toHaveBeenCalled();
  });

  it("'temporal' / garbage mode REFUSES boot (fail-loud; never a silent default)", () => {
    expect(() => resolveBootTasks({ [RUNTIME_MODE_ENV]: "temporal" }, explodingDeps())).toThrow(
      /REMOVED/,
    );
    expect(() => resolveBootTasks({ [RUNTIME_MODE_ENV]: "yes" }, explodingDeps())).toThrow(
      /postgres\|shadow/,
    );
  });

  it("a removed cutover boolean still set REFUSES boot naming the replacement", () => {
    expect(() =>
      resolveBootTasks({ [DEPRECATED_RUN_BACKGROUND_RUNNER_ENV]: "true" }, explodingDeps()),
    ).toThrow(RUNTIME_MODE_ENV);
    expect(() =>
      resolveBootTasks({ [DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV]: "true" }, explodingDeps()),
    ).toThrow(RUNTIME_MODE_ENV);
  });
});
