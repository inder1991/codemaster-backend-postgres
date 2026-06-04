/**
 * Unit tests for `withMutexTransaction`'s rollback safety (no DB — fake `pg` client).
 *
 * The behaviour under test: when the wrapped work throws AND the subsequent `ROLLBACK` also throws,
 * the ORIGINAL work error must propagate — a failing rollback must not mask the real cause. The
 * rollback failure is logged separately and swallowed.
 */
import { describe, expect, it, vi } from "vitest";

import { withMutexTransaction } from "#backend/concurrency/pr_mutex.js";

import type { Pool, PoolClient } from "pg";

/** A `pg.Pool` whose `connect()` hands back the supplied fake client. */
function fakePool(client: Partial<PoolClient>): Pool {
  return { connect: async (): Promise<PoolClient> => client as PoolClient } as unknown as Pool;
}

describe("withMutexTransaction — rollback safety", () => {
  it("preserves the ORIGINAL error when ROLLBACK also fails (does not mask it)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const release = vi.fn();
    const workError = new Error("work failed — the real cause");
    const client: Partial<PoolClient> = {
      query: (async (sql: string): Promise<unknown> => {
        if (sql === "ROLLBACK") throw new Error("rollback failed — must NOT surface");
        return undefined;
      }) as unknown as PoolClient["query"],
      release: release as unknown as PoolClient["release"],
    };

    await expect(
      withMutexTransaction(fakePool(client), () => Promise.reject(workError)),
    ).rejects.toBe(workError);

    // The rollback failure was logged separately, and the client was still released.
    expect(consoleError).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("rolls back and re-throws the work error when ROLLBACK succeeds", async () => {
    const queries: Array<string> = [];
    const client: Partial<PoolClient> = {
      query: (async (sql: string): Promise<unknown> => {
        queries.push(sql);
        return undefined;
      }) as unknown as PoolClient["query"],
      release: (() => {}) as unknown as PoolClient["release"],
    };
    const err = new Error("boom");

    await expect(withMutexTransaction(fakePool(client), () => Promise.reject(err))).rejects.toBe(err);
    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("commits and returns the result on success", async () => {
    const queries: Array<string> = [];
    const client: Partial<PoolClient> = {
      query: (async (sql: string): Promise<unknown> => {
        queries.push(sql);
        return undefined;
      }) as unknown as PoolClient["query"],
      release: (() => {}) as unknown as PoolClient["release"],
    };

    const result = await withMutexTransaction(fakePool(client), () => Promise.resolve(42));
    expect(result).toBe(42);
    expect(queries).toEqual(["BEGIN", "COMMIT"]);
  });
});
