import { randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { BedrockBudgetExceededError } from "#backend/cost/enforcer.js";
import { PostgresCostJournal } from "#backend/cost/cost_journal.js";
import { PostgresCostCapEnforcer } from "#backend/cost/postgres_enforcer.js";

import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// de-Temporal Phase 0 checklist #5 — PARITY: the SAME call sequences driven through the aggregate
// `PostgresCostCapEnforcer` (checkOrRaise/recordCallCost over telemetry.cost_daily) and the
// journal's deciding twin (cap checked against SUM(telemetry.cost_journal)) must produce IDENTICAL
// cap decisions — same admit/refuse at the same step, same CostCapDecision fields, same error
// class/scope/scopeId/REASON STRING on refusals — and identical persisted totals after EVERY step
// (asserted through divergenceFromAggregate === [], so the dual-read seam itself is the invariant
// checker). This is the acceptance gate that makes the cutover flip a like-for-like swap.
//
// Note the one deliberate write-shape divergence under test in the zero-diff sequence: the
// aggregate early-returns on diff==0 while the journal appends a 0-amount settle row — the parity
// claim is about DECISIONS and SUMS, and a zero row moves neither.

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-01-01T00:00:00.000Z") });

let pool: Pool;
let db: Kysely<unknown>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy();
});

/** A unique YYYY-MM-DD-shaped date string so each sequence owns its own day in BOTH tables. */
function uniqueToday(): string {
  const n = (parseInt(randomUUID().replace(/-/g, "").slice(0, 8), 16) % 3000) + 1;
  const base = Date.UTC(2050, 0, 1) + n * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

async function cleanupToday(today: string): Promise<void> {
  await sql`DELETE FROM telemetry.cost_journal WHERE today = ${today}`.execute(db);
  await sql`DELETE FROM telemetry.cost_daily WHERE today = ${today}`.execute(db);
}

// ─── the sequence driver ───────────────────────────────────────────────────────────────────────────

type Step =
  | { op: "check"; callId: string; installationId: string; estimatedCents: number }
  | {
      op: "record";
      callId: string;
      installationId: string;
      costCents: number;
      estimatedCents?: number;
    };

/** A comparable outcome: the parsed decision on admit, the (class, scope, scopeId, reason) on refusal. */
type Outcome =
  | { ok: true; decision: Record<string, unknown> }
  | { ok: false; errName: string; scope: string; scopeId: string | null; reason: string }
  | { ok: true; recorded: true };

async function captureOutcome(run: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof BedrockBudgetExceededError) {
      return { ok: false, errName: err.name, scope: err.scope, scopeId: err.scopeId, reason: err.reason };
    }
    throw err; // anything else (lock timeout, SQL error) is a test failure, not an outcome
  }
}

/**
 * Drive `steps` through BOTH implementations under identical constructor caps; after EVERY step
 * assert (1) outcome identity and (2) total identity via an empty divergence report.
 */
async function runParitySequence(args: {
  today: string;
  globalCapCents: number;
  perOrgCapCents: number;
  steps: ReadonlyArray<Step>;
}): Promise<void> {
  const { today, globalCapCents, perOrgCapCents, steps } = args;
  const enforcer = new PostgresCostCapEnforcer({ db, clock: FIXED_CLOCK, globalCapCents, perOrgCapCents });
  const journal = new PostgresCostJournal({ db, clock: FIXED_CLOCK, globalCapCents, perOrgCapCents });

  for (const [i, step] of steps.entries()) {
    const aggregate = await captureOutcome(async () => {
      if (step.op === "check") {
        const d = await enforcer.checkOrRaise({
          installationId: step.installationId,
          estimatedCents: step.estimatedCents,
          today,
        });
        return { ok: true, decision: d };
      }
      await enforcer.recordCallCost({
        installationId: step.installationId,
        costCents: step.costCents,
        today,
        ...(step.estimatedCents !== undefined ? { estimatedCents: step.estimatedCents } : {}),
      });
      return { ok: true, recorded: true };
    });
    const journaled = await captureOutcome(async () => {
      if (step.op === "check") {
        const d = await journal.checkOrRaise({
          callId: step.callId,
          installationId: step.installationId,
          estimatedCents: step.estimatedCents,
          today,
        });
        return { ok: true, decision: d };
      }
      await journal.recordCallCost({
        callId: step.callId,
        installationId: step.installationId,
        costCents: step.costCents,
        today,
        ...(step.estimatedCents !== undefined ? { estimatedCents: step.estimatedCents } : {}),
      });
      return { ok: true, recorded: true };
    });

    // (1) IDENTICAL decision — admit/refuse, decision fields, error class/scope/scopeId/reason.
    expect(journaled, `step ${i} (${step.op} ${step.callId}) decisions must match`).toEqual(aggregate);
    // (2) IDENTICAL totals after the step — the dual-read seam reports no divergence.
    expect(
      await journal.divergenceFromAggregate({ today }),
      `step ${i} (${step.op} ${step.callId}) totals must match`,
    ).toEqual([]);
  }
}

// ─── the sequences ─────────────────────────────────────────────────────────────────────────────────

describeDb("aggregate vs journal PARITY — identical cap decisions on identical sequences (disposable PG)", () => {
  it("mixed under-cap sequence: reserves, top-up, refund, two orgs, platform scope — all admitted identically", async () => {
    const today = uniqueToday();
    const orgA = randomUUID();
    const orgB = randomUUID();
    try {
      await runParitySequence({
        today,
        globalCapCents: 10_000,
        perOrgCapCents: 5_000,
        steps: [
          { op: "check", callId: "a1", installationId: orgA, estimatedCents: 200 },
          { op: "record", callId: "a1", installationId: orgA, costCents: 350, estimatedCents: 200 }, // top-up
          { op: "check", callId: "a2", installationId: orgA, estimatedCents: 100 },
          { op: "record", callId: "a2", installationId: orgA, costCents: 40, estimatedCents: 100 }, // refund
          { op: "check", callId: "b1", installationId: orgB, estimatedCents: 500 },
          { op: "check", callId: "p1", installationId: ZERO_UUID, estimatedCents: 30 },
          { op: "record", callId: "p1", installationId: ZERO_UUID, costCents: 25, estimatedCents: 30 },
        ],
      });
    } finally {
      await cleanupToday(today);
    }
  });

  it("crossing the GLOBAL cap: identical refusal (scope/reason verbatim), identical recovery after a refund", async () => {
    const today = uniqueToday();
    const orgA = randomUUID();
    try {
      await runParitySequence({
        today,
        globalCapCents: 300,
        perOrgCapCents: 1_000_000,
        steps: [
          { op: "check", callId: "c1", installationId: orgA, estimatedCents: 200 },
          // 200 + 150 > 300 → BOTH refuse on global with the same reason string.
          { op: "check", callId: "c2", installationId: orgA, estimatedCents: 150 },
          // The refund (actual 120 vs estimated 200) walks both totals to 120 …
          { op: "record", callId: "c1", installationId: orgA, costCents: 120, estimatedCents: 200 },
          // … so the SAME 150 now fits identically (120 + 150 ≤ 300).
          { op: "check", callId: "c2", installationId: orgA, estimatedCents: 150 },
        ],
      });
    } finally {
      await cleanupToday(today);
    }
  });

  it("crossing the PER-ORG cap: identical per_org refusal carrying scopeId; a sibling org is untouched", async () => {
    const today = uniqueToday();
    const orgA = randomUUID();
    const orgB = randomUUID();
    try {
      await runParitySequence({
        today,
        globalCapCents: 1_000_000,
        perOrgCapCents: 100,
        steps: [
          { op: "check", callId: "a1", installationId: orgA, estimatedCents: 60 },
          // 60 + 50 > 100 → BOTH refuse per_org, scopeId = orgA, same reason string.
          { op: "check", callId: "a2", installationId: orgA, estimatedCents: 50 },
          // orgB's budget is independent — BOTH admit.
          { op: "check", callId: "b1", installationId: orgB, estimatedCents: 50 },
        ],
      });
    } finally {
      await cleanupToday(today);
    }
  });

  it("the zero-diff settle: the aggregate skips the write, the journal appends a 0 row — decisions AND sums stay identical", async () => {
    const today = uniqueToday();
    const orgA = randomUUID();
    try {
      await runParitySequence({
        today,
        globalCapCents: 10_000,
        perOrgCapCents: 5_000,
        steps: [
          { op: "check", callId: "z1", installationId: orgA, estimatedCents: 100 },
          // diff == 0: aggregate early-returns; journal appends its completion-proof 0 row.
          { op: "record", callId: "z1", installationId: orgA, costCents: 100, estimatedCents: 100 },
          // A follow-up check sees the SAME totals on both sides.
          { op: "check", callId: "z2", installationId: orgA, estimatedCents: 10 },
        ],
      });
      // The write-shape divergence is real (3 journal rows) even though sums/decisions matched.
      const r = await sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM telemetry.cost_journal WHERE today = ${today}
      `.execute(db);
      expect(Number(r.rows[0]!.n)).toBe(3);
    } finally {
      await cleanupToday(today);
    }
  });

  it("platform-scope (zero-UUID) sequence: per-org accounting skipped identically on both sides", async () => {
    const today = uniqueToday();
    try {
      await runParitySequence({
        today,
        globalCapCents: 150,
        perOrgCapCents: 1, // would refuse ANY org call — proving neither side consults it here
        steps: [
          { op: "check", callId: "p1", installationId: ZERO_UUID, estimatedCents: 100 },
          { op: "record", callId: "p1", installationId: ZERO_UUID, costCents: 80, estimatedCents: 100 },
          // 80 + 100 > 150 → BOTH refuse on GLOBAL (the only scope platform calls bill).
          { op: "check", callId: "p2", installationId: ZERO_UUID, estimatedCents: 100 },
          { op: "check", callId: "p3", installationId: ZERO_UUID, estimatedCents: 70 },
        ],
      });
    } finally {
      await cleanupToday(today);
    }
  });
});
