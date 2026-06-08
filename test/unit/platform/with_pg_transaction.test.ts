import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { withPgTransaction } from "#platform/db/database.js";

// Unit test for the generic pooled-connection BEGIN/COMMIT/ROLLBACK helper used by the cron-sweep
// activities (mutex_janitor, review_run_reaper). A fake pooled client records query SQL + release so we
// can assert the transaction bracketing, the ROLLBACK-on-throw path, and that a FAILING rollback never
// masks the original application error.
type FakeClient = {
  calls: Array<string>;
  released: boolean;
  query(sql: string): Promise<{ rows: Array<unknown> }>;
  release(): void;
};

function fakeClient(opts?: { throwOn?: string; error?: Error }): FakeClient {
  const c: FakeClient = {
    calls: [],
    released: false,
    query: async (sql: string): Promise<{ rows: Array<unknown> }> => {
      c.calls.push(sql);
      if (opts?.throwOn !== undefined && sql.startsWith(opts.throwOn)) {
        throw opts.error ?? new Error(`query failed: ${sql}`);
      }
      return { rows: [] };
    },
    release: (): void => {
      c.released = true;
    },
  };
  return c;
}

function fakePool(client: FakeClient): Pool {
  return { connect: async (): Promise<PoolClient> => client as unknown as PoolClient } as unknown as Pool;
}

describe("withPgTransaction", () => {
  it("brackets the callback with BEGIN/COMMIT and returns its result", async () => {
    const client = fakeClient();
    const result = await withPgTransaction(fakePool(client), async (c) => {
      await c.query("SELECT 1");
      return 42;
    });
    expect(result).toBe(42);
    expect(client.calls).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    expect(client.released).toBe(true);
  });

  it("ROLLBACKs and re-throws the original error when the callback throws", async () => {
    const client = fakeClient();
    const boom = new Error("callback boom");
    await expect(
      withPgTransaction(fakePool(client), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(client.calls).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.released).toBe(true);
  });

  it("preserves the ORIGINAL error even when ROLLBACK itself fails", async () => {
    const client = fakeClient({ throwOn: "ROLLBACK", error: new Error("rollback failed") });
    const boom = new Error("callback boom");
    await expect(
      withPgTransaction(fakePool(client), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom); // NOT "rollback failed" — the rollback failure is swallowed + logged
    expect(client.released).toBe(true);
  });
});
