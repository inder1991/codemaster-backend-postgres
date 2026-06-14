// Phase 4c W4c.2 review blocker #10 — DISPOSABLE lazy clients + the runner's dispose phase.
//
// The bug: _confluence_page_sync.ts::makeLazyConfluenceChunkClient starts the ConfluenceTokenProvider
// refresh loop (a LIVE WallClock.sleep timer — a raw un-unref'd setTimeout) on first use, and
// runBackgroundRunner had NO dispose handle: after SIGTERM stopped the three loops, the still-running
// refresh loop kept the event loop alive and the process hung instead of exiting promptly.
//
// Proves:
//   (1) the lazy builder is STILL lazy: constructing it builds nothing, and dispose() before first
//       use is a clean no-op that does NOT trigger the deferred-Vault construction;
//   (2) the first client call starts the refresh loop; an UNDISPOSED run leaves the loop running
//       (the bug shape — observable on the recording fake provider); dispose() stops it, and a
//       second dispose() is an idempotent no-op;
//   (3) DisposableRegistry.disposeAll runs EVERY registered dispose in registration order and is
//       error-safe (a throwing dispose is logged + skipped, never aborts the rest — it is the
//       shutdown path; nothing useful can react to a throw);
//   (4) buildBackgroundRunner registers the two default lazy Confluence clients (confluence_ingest
//       cron + trigger_page_resync event) on the SHARED registry it returns, and disposing a
//       never-used runner is a clean no-op (no Vault/Confluence construction on the exit path).
//
// Uses a fake/recording token provider — NO real Vault/Confluence (the task's test contract).

import { describe, expect, it, vi } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { FakeClock } from "#platform/clock.js";

import { DisposableRegistry } from "#backend/runner/disposables.js";
import {
  makeLazyConfluenceChunkClient,
  type ConfluenceTokenProviderLike,
} from "#backend/runner/handlers/_confluence_page_sync.js";
import {
  buildBackgroundRunner,
  type BackgroundRunnerConfig,
} from "#backend/runner/background_runner_main.js";

/** Recording fake of the narrow ConfluenceTokenProvider slice the lazy builder drives. getToken
 *  THROWS so the triggering client call fails fast at the token seam — construction (and the
 *  refresh-loop start) has already happened by then, and no HTTP fetch is ever attempted. */
class FakeTokenProvider implements ConfluenceTokenProviderLike {
  public startCalls = 0;
  public stopCalls = 0;
  public loopRunning = false;
  public readonly baseUrl = "https://confluence.test/wiki";
  public readonly authEmail: string | null = null;

  public startRefreshLoop(): void {
    this.startCalls += 1;
    this.loopRunning = true;
  }

  public async stop(): Promise<void> {
    this.stopCalls += 1;
    this.loopRunning = false;
  }

  public async getToken(): Promise<string> {
    throw new Error("fake-token-unavailable (unit test: no network past the token seam)");
  }
}

describe("makeLazyConfluenceChunkClient — disposable lazy client (#10)", () => {
  it("(1) stays lazy: nothing is built at construction, and dispose() before first use never constructs", async () => {
    const fake = new FakeTokenProvider();
    let built = 0;
    const lazy = makeLazyConfluenceChunkClient({
      makeTokenProvider: async () => {
        built += 1;
        return fake;
      },
    });

    expect(built).toBe(0); // construction deferred (the ADR-0075 dev posture)
    await lazy.dispose(); // dispose of a never-used client: clean no-op
    expect(built).toBe(0); // dispose MUST NOT itself trigger the deferred construction
    expect(fake.startCalls).toBe(0);
    expect(fake.stopCalls).toBe(0);
  });

  it("(2) first use starts the refresh loop; undisposed it KEEPS RUNNING (the bug); dispose() stops it idempotently", async () => {
    const fake = new FakeTokenProvider();
    let built = 0;
    const lazy = makeLazyConfluenceChunkClient({
      makeTokenProvider: async () => {
        built += 1;
        return fake;
      },
    });

    // First use triggers the deferred construction → the refresh loop STARTS. The call itself fails
    // at the fake's token seam (no network), which is irrelevant to the lifecycle under test.
    await expect(lazy.client.listPages({ spaceKey: "ENG" })).rejects.toThrow(
      /fake-token-unavailable/,
    );
    expect(built).toBe(1);
    expect(fake.startCalls).toBe(1);

    // THE BUG SHAPE: without a dispose phase the loop is still live after the loops stop — under a
    // WallClock this is a pending un-unref'd setTimeout that keeps the process from exiting.
    expect(fake.loopRunning).toBe(true);
    expect(fake.stopCalls).toBe(0);

    // A second use re-uses the memo (no second construction / second loop).
    await expect(lazy.client.getPage({ pageId: "123" })).rejects.toThrow(/fake-token-unavailable/);
    expect(built).toBe(1);
    expect(fake.startCalls).toBe(1);

    // THE FIX: dispose() stops the refresh loop so the process can exit promptly.
    await lazy.dispose();
    expect(fake.stopCalls).toBe(1);
    expect(fake.loopRunning).toBe(false);

    // Idempotent: a second dispose is a no-op (no double-stop).
    await lazy.dispose();
    expect(fake.stopCalls).toBe(1);
  });
});

describe("DisposableRegistry (#10)", () => {
  it("(3) disposeAll runs every registered dispose in order and survives a throwing one", async () => {
    const reg = new DisposableRegistry();
    const calls: Array<string> = [];
    reg.register({ name: "a", dispose: async () => void calls.push("a") });
    reg.register({
      name: "boom",
      dispose: async () => {
        throw new Error("boom");
      },
    });
    reg.register({ name: "b", dispose: async () => void calls.push("b") });

    expect(reg.registeredNames()).toEqual(["a", "boom", "b"]);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await reg.disposeAll(); // MUST NOT throw — the shutdown path
    } finally {
      consoleError.mockRestore();
    }
    expect(calls).toEqual(["a", "b"]); // 'boom' was caught; the REST still ran
  });
});

describe("buildBackgroundRunner — the shared dispose registry (#10)", () => {
  const TEST_CONFIG: BackgroundRunnerConfig = {
    owner: "w4c2-dispose-test",
    leaseS: 2,
    heartbeatS: 0.2,
    maxRuntimeS: 60,
    idleS: 30,
    pollIntervalS: 600,
    outboxIdleS: 600,
    outboxMaxAttempts: 5,
  };

  it("(4) registers ONE SHARED lazy Confluence client injected into both handler sets (F14/P2-18); disposing a never-used runner is a clean no-op", async () => {
    // buildBackgroundRunner performs NO I/O (the pg pool is lazy) — a never-connected pool suffices.
    const pool = new Pool({ connectionString: "postgresql://unused:unused@127.0.0.1:1/unused" });
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    try {
      const handles = buildBackgroundRunner({ db, clock: new FakeClock(), config: TEST_CONFIG });

      expect(handles.disposables).toBeInstanceOf(DisposableRegistry);
      // F14 / P2-18: ONE shared lazy chunk client (a single token-refresh loop + Vault reader) is built at
      // the composition root and injected into BOTH registerCronHandlers + registerEventHandlers — so there
      // is exactly ONE registered dispose, not one per handler (which doubled the loops + Vault cadence).
      expect(handles.disposables.registeredNames()).toEqual(["confluence.shared_chunk_client"]);

      // The DISPOSE PHASE on an idle runner (no job ever built the lazy clients) must resolve
      // cleanly WITHOUT constructing anything (no Vault env vars exist in this unit test — a
      // construction attempt would throw out of disposeAll's catch-all into the console, but more
      // importantly the memo-stays-undefined contract is pinned by test (1) above).
      await handles.disposables.disposeAll();
    } finally {
      await db.destroy();
    }
  });
});
