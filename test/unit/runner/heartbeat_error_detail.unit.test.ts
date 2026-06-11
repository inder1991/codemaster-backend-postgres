/**
 * W4.6 [L13] — heartbeat-loop failures must not be swallowed with a BARE catch: the counters fire
 * (`codemaster_runner_heartbeat_failures_total` covers a REFUSED heartbeat, not a THROWN one) but the
 * underlying error was discarded, so a recurring fault (pool exhaustion, DNS, a driver bug) was
 * countable but un-diagnosable. Both runners must WARN-log a structured record carrying the
 * `error_class` (+ a bounded message) BEFORE aborting the handler.
 *
 * Same deterministic harness as orphan_handler_timeout.unit.test.ts: a controllable clock fires the
 * heartbeat sleep on demand; the repo's `heartbeat()` REJECTS with a typed error; the handler honors
 * `work.signal`. test/ is OUT of the clock/random gate's scope.
 */
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterEach, describe, expect, it, vi } from "vitest";

import { runOneJob } from "#backend/runner/review_job_runner.js";
import { runOneBackgroundJob } from "#backend/runner/background_runner.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import type { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import type { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import type { Clock } from "#platform/clock.js";

class ControllableClock implements Clock {
  private monotonicSeconds = 0;
  private readonly pending = new Map<number, Array<() => void>>();
  public now(): Date {
    return new Date("2026-01-01T00:00:00.000Z");
  }
  public monotonic(): number {
    return this.monotonicSeconds;
  }
  public sleep(seconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const list = this.pending.get(seconds) ?? [];
      list.push(resolve);
      this.pending.set(seconds, list);
    });
  }
  public fireSleep(seconds: number): void {
    this.monotonicSeconds += seconds;
    const list = this.pending.get(seconds) ?? [];
    this.pending.delete(seconds);
    for (const resolve of list) resolve();
  }
}

/** The typed failure the heartbeat loop must surface by NAME in its structured WARN record. */
class FakePoolExhaustedError extends Error {
  public constructor() {
    super("connection pool exhausted (fake)");
    this.name = "FakePoolExhaustedError";
  }
}

/** A handler that honors `signal`: pending until abort, then rejects with the abort reason. */
function signalHonoringHandler(signal: AbortSignal): Promise<void> {
  return new Promise<void>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  });
}

/** Parse every console.warn line that is JSON and matches the given event name. */
function warnedRecords(spy: ReturnType<typeof vi.spyOn>, event: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    const first = call[0];
    if (typeof first !== "string") continue;
    try {
      const parsed = JSON.parse(first) as Record<string, unknown>;
      if (parsed["event"] === event) out.push(parsed);
    } catch {
      /* not JSON — not ours */
    }
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("heartbeat-loop error detail (L13)", () => {
  it("review runner: a THROWN heartbeat WARN-logs a structured record with error_class before aborting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const clock = new ControllableClock();
    const jobId = randomUUID();
    const repo = {
      claim: async () => ({
        job_id: jobId, run_id: randomUUID(), review_id: randomUUID(), installation_id: randomUUID(),
        state: "leased", priority: 0, attempts: 1, max_attempts: 3, attempt_token: randomUUID(),
      }),
      heartbeat: async () => {
        throw new FakePoolExhaustedError();
      },
      markDone: async () => ({ applied: true }),
      markFailed: async () => ({ applied: true, terminal: false }),
      terminalSettle: async () => ({ applied: true }),
    } as unknown as ReviewJobsRepo;

    const run = runOneJob({
      repo, clock, owner: "l13-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300,
      handler: (_job, signal) => signalHonoringHandler(signal),
    });
    await Promise.resolve(); // let the claim + hb loop wire up
    clock.fireSleep(5);      // heartbeat tick → repo.heartbeat() throws
    const r = await run;
    expect(r.outcome).toBe("failed"); // the abort settled the attempt as a failure

    const records = warnedRecords(warn, "runner.heartbeat_loop_error");
    expect(records).toHaveLength(1);
    expect(records[0]!["error_class"]).toBe("FakePoolExhaustedError");
    expect(records[0]!["job_id"]).toBe(jobId);
  });

  it("background runner: a THROWN heartbeat WARN-logs the same structured record", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const clock = new ControllableClock();
    const jobId = randomUUID();
    const repo = {
      claim: async () => ({
        job_id: jobId, job_type: "l13_test", payload: {}, payload_sha256: "0".repeat(64),
        state: "leased", priority: 0, attempts: 1, max_attempts: 3, attempt_token: randomUUID(),
      }),
      verifyPayload: () => ({}),
      heartbeat: async () => {
        throw new FakePoolExhaustedError();
      },
      markDone: async () => ({ applied: true }),
      markFailed: async () => ({ applied: true, terminal: false }),
      terminalSettle: async () => ({ applied: true }),
    } as unknown as BackgroundJobsRepo;
    const registry = new HandlerRegistry();
    registry.register("l13_test", (_payload, signal) => signalHonoringHandler(signal));

    const run = runOneBackgroundJob({
      repo, registry, clock, owner: "l13-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300,
    });
    await Promise.resolve();
    clock.fireSleep(5);
    const r = await run;
    expect(r.outcome).toBe("failed");

    const records = warnedRecords(warn, "runner.heartbeat_loop_error");
    expect(records).toHaveLength(1);
    expect(records[0]!["error_class"]).toBe("FakePoolExhaustedError");
    expect(records[0]!["job_id"]).toBe(jobId);
  });
});
