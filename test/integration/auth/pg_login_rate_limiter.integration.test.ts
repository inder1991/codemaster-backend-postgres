// W4.7 / EM5 — Postgres-backed login rate limiter against the DISPOSABLE Postgres. The in-process
// Map limiter is defeated by a multi-replica admin-api (each pod sees < threshold) and leaks keys
// for IPs that never retry. The PG limiter shares core.login_rate_limit_failures across replicas
// (two limiter INSTANCES see each other's failures), GCs stale keys globally on each recordFailure,
// and FAILS OPEN on a broken pool (the login path itself needs the same DB, so spraying yields
// nothing while the limiter is degraded — but a limiter outage must never 500 the login route).

import {
  type DatabaseConnection,
  Kysely,
  PostgresAdapter,
  PostgresDialect,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { PostgresLoginRateLimiter } from "#backend/api/auth/rate_limit.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const KEY = "itest-rl-198.51.100.7";
const KEY_OTHER = "itest-rl-203.0.113.5";

let pool: Pool;
let db: Kysely<unknown>;

function makeLimiter(clock: FakeClock, overrides?: { maxAttempts?: number }): PostgresLoginRateLimiter {
  return new PostgresLoginRateLimiter({
    db,
    maxAttempts: overrides?.maxAttempts ?? 3,
    windowMs: 5 * 60 * 1000,
    lockoutMs: 5 * 60 * 1000,
    clock,
  });
}

function brokenKysely(): Kysely<unknown> {
  const connection: DatabaseConnection = {
    async executeQuery() {
      throw new Error("rate-limit table unreachable");
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error("rate-limit table unreachable");
    },
  };
  return new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        async init() {},
        async acquireConnection() {
          return connection;
        },
        async beginTransaction() {},
        async commitTransaction() {},
        async rollbackTransaction() {},
        async releaseConnection() {},
        async destroy() {},
      }),
      createIntrospector: (innerDb) => new PostgresIntrospector(innerDb),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await sql`DELETE FROM core.login_rate_limit_failures WHERE rl_key LIKE 'itest-rl-%'`.execute(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.login_rate_limit_failures WHERE rl_key LIKE 'itest-rl-%'`.execute(db);
  }
});

afterAll(async () => {
  await db?.destroy();
});

describeDb("W4.7/EM5 PostgresLoginRateLimiter (disposable PG)", () => {
  it("blocks the key after maxAttempts failures inside the window", async () => {
    const clock = new FakeClock({ now: NOW });
    const limiter = makeLimiter(clock);
    expect(await limiter.checkAllowed(KEY)).toBe(true);
    await limiter.recordFailure(KEY);
    await limiter.recordFailure(KEY);
    expect(await limiter.checkAllowed(KEY)).toBe(true);
    await limiter.recordFailure(KEY);
    expect(await limiter.checkAllowed(KEY)).toBe(false);
    expect(await limiter.checkAllowed(KEY_OTHER)).toBe(true); // per-key bucketing
  });

  it("MULTI-REPLICA: a second limiter instance over the same table sees the first's failures", async () => {
    const clock = new FakeClock({ now: NOW });
    const replicaA = makeLimiter(clock);
    const replicaB = makeLimiter(clock);
    await replicaA.recordFailure(KEY);
    await replicaA.recordFailure(KEY);
    await replicaB.recordFailure(KEY);
    expect(await replicaA.checkAllowed(KEY)).toBe(false);
    expect(await replicaB.checkAllowed(KEY)).toBe(false);
  });

  it("failures age out after the horizon (max(window, lockout)) — the key recovers", async () => {
    const clock = new FakeClock({ now: NOW });
    const limiter = makeLimiter(clock);
    await limiter.recordFailure(KEY);
    await limiter.recordFailure(KEY);
    await limiter.recordFailure(KEY);
    expect(await limiter.checkAllowed(KEY)).toBe(false);
    clock.advance({ seconds: 5 * 60 + 1 }); // past the 5-min horizon
    expect(await limiter.checkAllowed(KEY)).toBe(true);
  });

  it("recordSuccess clears the key's history", async () => {
    const clock = new FakeClock({ now: NOW });
    const limiter = makeLimiter(clock);
    await limiter.recordFailure(KEY);
    await limiter.recordFailure(KEY);
    await limiter.recordFailure(KEY);
    expect(await limiter.checkAllowed(KEY)).toBe(false);
    await limiter.recordSuccess(KEY);
    expect(await limiter.checkAllowed(KEY)).toBe(true);
  });

  it("GC: recordFailure prunes STALE rows globally (keys that never retry don't accumulate)", async () => {
    const clock = new FakeClock({ now: NOW });
    const limiter = makeLimiter(clock);
    await limiter.recordFailure(KEY_OTHER); // a key that never retries
    clock.advance({ seconds: 6 * 60 }); // beyond the horizon
    await limiter.recordFailure(KEY); // any later failure GCs the stale rows
    const r = await sql<{ n: string | number }>`
      SELECT COUNT(*) AS n FROM core.login_rate_limit_failures WHERE rl_key = ${KEY_OTHER}
    `.execute(db);
    expect(Number(r.rows[0]!.n)).toBe(0);
  });

  it("FAIL-OPEN: a broken pool lets the attempt proceed (warn, never throw)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const clock = new FakeClock({ now: NOW });
    const limiter = new PostgresLoginRateLimiter({
      db: brokenKysely(),
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      clock,
    });
    expect(await limiter.checkAllowed(KEY)).toBe(true);
    await expect(limiter.recordFailure(KEY)).resolves.toBeUndefined();
    await expect(limiter.recordSuccess(KEY)).resolves.toBeUndefined();
  });
});
