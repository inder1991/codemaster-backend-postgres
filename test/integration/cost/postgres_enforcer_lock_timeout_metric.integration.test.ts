// W2.1 (XC4) — the cost-cap lock_timeout ALERT METRIC: when a cost_daily statement waits past
// `SET LOCAL lock_timeout` (SQLSTATE 55P03) the enforcer must emit
// `codemaster_cost_cap_lock_timeout_total` (bounded label `op` ∈ {reserve, settle}) so the residual
// contention on the hot global row is observable — the master-hardening-plan W2.1 line item
// ("Alert on cost-cap lock_timeout rate").
//
// COUNTER-TIMING GOTCHA (same as llm_client_prompt_cache_telemetry.test.ts): the enforcer caches its
// Counter instrument at MODULE scope, so the in-memory MeterProvider is registered in beforeAll and
// postgres_enforcer.js is DYNAMICALLY imported afterwards — a static import would bind the counter
// to the no-op meter. `#backend/cost/enforcer.js` (the error classes) does NOT import the enforcer
// module, so its static import is safe, and the dynamic module resolves the SAME enforcer.js, so
// `instanceof CostCapLockTimeoutError` keeps class identity.

import { randomUUID } from "node:crypto";

import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { CostCapLockTimeoutError } from "#backend/cost/enforcer.js";

import { FakeClock, type Clock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const FIXED_CLOCK = new FakeClock({ now: new Date("2099-01-01T00:00:00.000Z") });

/** Structural slice of the dynamically-imported enforcer this test drives. */
type EnforcerLike = {
  checkOrRaise(args: {
    installationId: string;
    estimatedCents: number;
    today: string;
  }): Promise<unknown>;
  recordCallCost(args: {
    installationId: string;
    costCents: number;
    today: string;
    estimatedCents?: number;
  }): Promise<void>;
};
type EnforcerCtor = new (args: {
  db: Kysely<unknown>;
  clock?: Clock;
  globalCapCents?: number;
  perOrgCapCents?: number;
}) => EnforcerLike;

let exporter: InMemoryMetricExporter;
let provider: MeterProvider;
let pool: Pool;
let db: Kysely<unknown>;
let PostgresCostCapEnforcerClass: EnforcerCtor;
let LOCK_TIMEOUT_TOTAL_NAME: string;

beforeAll(async () => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 2_147_483_647,
  });
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  // Dynamic import AFTER provider registration so the module-scope counter binds to the real meter.
  const mod = (await import("#backend/cost/postgres_enforcer.js")) as unknown as {
    PostgresCostCapEnforcer: EnforcerCtor;
    COST_CAP_LOCK_TIMEOUT_TOTAL_NAME: string;
  };
  PostgresCostCapEnforcerClass = mod.PostgresCostCapEnforcer;
  LOCK_TIMEOUT_TOTAL_NAME = mod.COST_CAP_LOCK_TIMEOUT_TOTAL_NAME;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy();
  await provider?.shutdown();
  metrics.disable();
});

beforeEach(async () => {
  // Drain uncollected deltas, then clear — each test asserts exactly its own adds.
  await provider?.forceFlush();
  exporter?.reset();
});

/** A unique YYYY-MM-DD-shaped date string so each test owns its own global + per-org rows. */
function uniqueToday(): string {
  const n = (parseInt(randomUUID().replace(/-/g, "").slice(0, 8), 16) % 3000) + 1;
  const base = Date.UTC(2070, 0, 1) + n * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

async function cleanupToday(today: string): Promise<void> {
  await sql`DELETE FROM telemetry.cost_daily WHERE today = ${today}`.execute(db);
}

/** Collect the points for `name` from the flushed batches (flush ONCE per test — DELTA temporality). */
function pointsFor(name: string): Array<DataPoint<number>> {
  const out: Array<DataPoint<number>> = [];
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === name) {
          out.push(...(m.dataPoints as Array<DataPoint<number>>));
        }
      }
    }
  }
  return out;
}

/** Hold a FOR UPDATE lock on the day's GLOBAL row from a separate connection while `body` runs. */
async function withHeldGlobalLock(today: string, body: () => Promise<void>): Promise<void> {
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT 1 FROM telemetry.cost_daily WHERE today = $1 AND scope = 'global' FOR UPDATE",
      [today],
    );
    await body();
    await holder.query("ROLLBACK");
  } finally {
    holder.release();
  }
}

describeDb("cost-cap lock_timeout alert metric (W2.1 — SQLSTATE 55P03 observability)", () => {
  it("exposes the Grafana-stable counter name verbatim", () => {
    expect(LOCK_TIMEOUT_TOTAL_NAME).toBe("codemaster_cost_cap_lock_timeout_total");
  });

  it("a reserve blocked past lock_timeout emits op=reserve alongside CostCapLockTimeoutError", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcerClass({ db, clock: FIXED_CLOCK });
    try {
      // Seed both rows so the contention lands on the EXISTING global row's gate UPDATE.
      await enforcer.checkOrRaise({ installationId, estimatedCents: 0, today });

      await withHeldGlobalLock(today, async () => {
        await expect(
          enforcer.checkOrRaise({ installationId, estimatedCents: 1, today }),
        ).rejects.toThrow(CostCapLockTimeoutError);
      });

      await provider.forceFlush();
      const points = pointsFor(LOCK_TIMEOUT_TOTAL_NAME);
      const reservePoints = points.filter((p) => p.attributes["op"] === "reserve");
      expect(reservePoints.length).toBe(1);
      expect(reservePoints[0]?.value).toBe(1);
    } finally {
      await cleanupToday(today);
    }
  }, 15_000);

  it("a settle blocked past lock_timeout emits op=settle alongside CostCapLockTimeoutError", async () => {
    const today = uniqueToday();
    const installationId = randomUUID();
    const enforcer = new PostgresCostCapEnforcerClass({ db, clock: FIXED_CLOCK });
    try {
      await enforcer.checkOrRaise({ installationId, estimatedCents: 0, today });

      await withHeldGlobalLock(today, async () => {
        // diff = 5 − 0 ≠ 0 → the settle UPDATE runs and queues behind the held global lock.
        await expect(
          enforcer.recordCallCost({ installationId, costCents: 5, estimatedCents: 0, today }),
        ).rejects.toThrow(CostCapLockTimeoutError);
      });

      await provider.forceFlush();
      const points = pointsFor(LOCK_TIMEOUT_TOTAL_NAME);
      const settlePoints = points.filter((p) => p.attributes["op"] === "settle");
      expect(settlePoints.length).toBe(1);
      expect(settlePoints[0]?.value).toBe(1);
    } finally {
      await cleanupToday(today);
    }
  }, 15_000);
});
