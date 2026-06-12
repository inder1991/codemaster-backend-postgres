/**
 * Cost-journal reconcile window — de-Temporal Phase 0 checklist #3.
 *
 * An orphaned reservation is a `reserve` row whose call never settled (the process died / the
 * attempt was hard-aborted between the cost-cap reservation and the post-call accounting). The
 * reconciler may only declare a reserve orphaned once NO legitimate settle can still arrive — and
 * the latest a settle can legitimately land is bounded by the runner's retry ENVELOPE for the paid
 * call, not by a single attempt: `runOneJob`'s hard ceiling frees the worker slot on timeout but
 * the abandoned handler promise keeps running (v4 #3), so its late `recordCallCost` can land any
 * time before the whole `runWithRetry` envelope closes.
 *
 * The window is therefore DERIVED from `RETRY_POLICIES.reviewChunk` (the paid call's policy — the
 * spec's "≈6 min for reviewChunk") via {@link worstCaseWallTimeSeconds}, not hard-coded: a future
 * policy edit moves the window automatically, and the strict `"Ns"` duration parser fails LOUD if
 * the policy format ever changes shape (a silently-zeroed window would release still-live reserves
 * — a cap-headroom corruption, the one failure mode this module must never have).
 *
 * Envelope math (mirrors `run_with_retry.ts` exactly):
 *   worst case = maxAttempts × startToClose  +  Σ_{i=1..maxAttempts−1} min(initial × backoff^(i−1),
 *                maxInterval) × {@link RETRY_ENVELOPE_JITTER_MAX}
 * For reviewChunk (90s × 4; 5s initial, 60s cap, 2.0 backoff): 360 + 1.25×(5+10+20) = 403.75s.
 * The shipped {@link RECONCILE_WINDOW_SECONDS} applies a ×2 safety factor (writer-vs-reconciler
 * clock skew, the client's lock-timeout-retry tail, scheduling latency of the late settle itself):
 * ceil(2 × 403.75) = 808s ≈ 13.5 min.
 *
 * (The spec's alternative gate — the Phase-2 in-flight-ledger lease expiry — is itself specced as
 * "lease TTL > worst-case + heartbeat", i.e. derived from the SAME policy constant; deriving here
 * directly is the non-circular choice.)
 */

import { type Kysely, sql } from "kysely";

import { type Clock, WallClock } from "#platform/clock.js";
import { tenantKysely } from "#platform/db/database.js";

import { type RetryActivityOptions, RETRY_POLICIES } from "#backend/review/pipeline/activity_ports.js";

/**
 * The upper bound of `run_with_retry.ts`'s sleep jitter — `random.uniform(0.75, 1.25)`. A worst
 * case must take the slowest draw on every sleep.
 */
export const RETRY_ENVELOPE_JITTER_MAX = 1.25;

/**
 * Parse a RETRY_POLICIES duration. STRICT: only the `"Ns"` seconds shape the transcribed policies
 * use is accepted — anything else (minutes, garbage, a missing unit) throws, because silently
 * mis-parsing a duration would silently shrink the reconcile window (see the module header).
 */
function parseSecondsStrict(duration: string): number {
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored; the optional `(?:\.\d+)?` tail consumes a literal `.` + ≥1 digit so no overlap with the preceding `\d+`, no nested/ambiguous quantifiers, no catastrophic backtracking (heuristic false positive)
  const m = /^(\d+(?:\.\d+)?)s$/.exec(duration);
  if (m === null) {
    throw new Error(
      `cost_journal_reconciler: cannot parse RETRY_POLICIES duration ${JSON.stringify(duration)} ` +
        `— only the "Ns" seconds shape is supported (a format change must be handled here EXPLICITLY)`,
    );
  }
  return Number(m[1]);
}

/**
 * The worst-case WALL time of one `runWithRetry` envelope for `policy`: every attempt burns its
 * full `startToCloseTimeout`, every inter-attempt sleep draws the maximum jitter, and the backoff
 * curve is capped at `maximumInterval` (uncapped when absent). `backoffCoefficient` defaults to 2.0
 * (the Temporal default the transcribed policies inherit when they omit it).
 */
export function worstCaseWallTimeSeconds(policy: RetryActivityOptions): number {
  if (policy.startToCloseTimeout === undefined) {
    throw new Error(
      "cost_journal_reconciler: policy carries no startToCloseTimeout — no envelope to derive from",
    );
  }
  const startToCloseS = parseSecondsStrict(policy.startToCloseTimeout);
  const attempts = policy.retry?.maximumAttempts ?? 1;
  if (attempts < 1) {
    throw new Error(`cost_journal_reconciler: maximumAttempts must be >= 1 (got ${attempts})`);
  }
  if (attempts === 1) {
    return startToCloseS;
  }
  const initial = policy.retry?.initialInterval;
  if (initial === undefined) {
    throw new Error(
      "cost_journal_reconciler: a multi-attempt policy carries no retry.initialInterval",
    );
  }
  const initialS = parseSecondsStrict(initial);
  const maxIntervalS =
    policy.retry?.maximumInterval !== undefined
      ? parseSecondsStrict(policy.retry.maximumInterval)
      : Number.POSITIVE_INFINITY;
  const backoff = policy.retry?.backoffCoefficient ?? 2.0;

  let sleepS = 0;
  let interval = initialS;
  for (let gap = 1; gap < attempts; gap++) {
    sleepS += Math.min(interval, maxIntervalS);
    interval = interval * backoff;
  }
  return attempts * startToCloseS + sleepS * RETRY_ENVELOPE_JITTER_MAX;
}

/**
 * The shipped reconcile window: a reserve with no settle older than this is an orphan the
 * reconciler may heal. ×2 safety factor over the reviewChunk worst-case envelope (module header).
 */
export const RECONCILE_WINDOW_SECONDS: number = Math.ceil(
  2 * worstCaseWallTimeSeconds(RETRY_POLICIES.reviewChunk),
);

// ─── The reconciler ────────────────────────────────────────────────────────────────────────────────

/**
 * Appends compensating `release` rows for orphaned reserves — the healing half of the Phase-0
 * compensating journal. APPEND-ONLY by construction: the single statement below only ever INSERTs
 * into `telemetry.cost_journal`; it never UPDATEs/DELETEs journal rows and never writes the
 * `telemetry.cost_daily` aggregate (whose enforcer keeps its known orphan leak until cutover — the
 * post-heal delta between journal SUM and aggregate total is exactly what the divergence seam
 * reports, quantifying what the cutover fixes).
 *
 * Pairing is COUNT-based per `call_id` (the ADR-0068 key legitimately recurs across attempt pairs):
 * a call is orphan-bearing when `count(reserve) > count(settle) + count(release)` AND its NEWEST
 * reserve is older than the window — a fresh reserve means a retry is live, so the whole call
 * waits (releasing its old orphan early would be correct sum-wise but ambiguous against the racing
 * settle; conservative reading: defer until the envelope closes). The `n_open` oldest reserve rows
 * not already closed by a release get one release each: `amount = −reserve.amount_cents`, same
 * `call_id`/`installation_id`/`today` (healing the same day's SUM the reserve inflated),
 * `closes_journal_id` = the reserve. The partial unique index `uq_cost_journal_closes` is the
 * idempotency arbiter: a re-run finds no open count; a RACING pass conflicts on the same reserve
 * and `ON CONFLICT … DO NOTHING`s — at most one release per reserve, ever.
 *
 * Clock: the cutoff is `clock.now() − olderThanSeconds` with `created_at` authored by the SAME
 * injected-clock discipline on the write side — no DB `now()` mixing, no wall-clock reads
 * (clock_random gate), and FakeClock tests can age orphans deterministically.
 *
 * NOT scheduled in Phase 0 (the Phase-3 scheduler wiring is runner surface — out of scope); the
 * cutover flip wires `releaseOrphanedReserves` as a scheduled job.
 */
export class CostJournalReconciler {
  readonly #db: Kysely<unknown>;
  readonly #clock: Clock;

  public constructor(args: { db: Kysely<unknown>; clock?: Clock }) {
    this.#db = args.db;
    this.#clock = args.clock ?? new WallClock();
  }

  /** Build a reconciler over the process-wide single pool for `dsn` (ADR-0062 seam). */
  public static fromDsn(args: { dsn: string; clock?: Clock }): CostJournalReconciler {
    return new CostJournalReconciler({
      db: tenantKysely<unknown>(args.dsn),
      ...(args.clock !== undefined ? { clock: args.clock } : {}),
    });
  }

  /**
   * One healing pass. Returns the number of release rows appended. Defaults to the derived
   * {@link RECONCILE_WINDOW_SECONDS}; tests narrow it, the cutover wiring may widen it — but a
   * caller can never pass a non-positive window (that would release still-live reserves).
   */
  public async releaseOrphanedReserves(args?: { olderThanSeconds?: number }): Promise<number> {
    const olderThanSeconds = args?.olderThanSeconds ?? RECONCILE_WINDOW_SECONDS;
    if (olderThanSeconds <= 0) {
      throw new RangeError("olderThanSeconds must be > 0 (a non-positive window would release live reserves)");
    }
    const now = this.#clock.now();
    const cutoff = new Date(now.getTime() - olderThanSeconds * 1000);

    // Single INSERT…SELECT — atomic without an explicit transaction; cross-call_id (cross-tenant)
    // by design, exactly like the ledger retention sweep.
    // tenant:exempt reason=scope-discriminated-cost-journal follow_up=PERMANENT-EXEMPTION-cost-daily-scope
    const r = await sql`
      WITH open_calls AS (
        -- A call is orphan-bearing when reserves outnumber its closers (settle + release each
        -- close one reserve, count-wise) AND its newest reserve has aged past the cutoff.
        SELECT call_id,
               COUNT(*) FILTER (WHERE entry_kind = 'reserve')
             - COUNT(*) FILTER (WHERE entry_kind <> 'reserve') AS n_open
          FROM telemetry.cost_journal
         GROUP BY call_id
        HAVING COUNT(*) FILTER (WHERE entry_kind = 'reserve')
             > COUNT(*) FILTER (WHERE entry_kind <> 'reserve')
           AND MAX(created_at) FILTER (WHERE entry_kind = 'reserve') < ${cutoff}
      ),
      candidates AS (
        -- The orphan-bearing calls' reserve rows not already closed by a release, oldest-first
        -- (deterministic: created_at then journal_id — FakeClock writes can share an instant).
        SELECT j.journal_id, j.call_id, j.installation_id, j.today, j.amount_cents,
               ROW_NUMBER() OVER (PARTITION BY j.call_id ORDER BY j.created_at, j.journal_id) AS rn,
               oc.n_open
          FROM telemetry.cost_journal j
          JOIN open_calls oc ON oc.call_id = j.call_id
         WHERE j.entry_kind = 'reserve'
           AND NOT EXISTS (
             SELECT 1 FROM telemetry.cost_journal closer
              WHERE closer.closes_journal_id = j.journal_id
           )
      )
      INSERT INTO telemetry.cost_journal
          (call_id, installation_id, today, entry_kind, amount_cents, closes_journal_id, created_at)
      SELECT call_id, installation_id, today, 'release', -amount_cents, journal_id, ${now}
        FROM candidates
       WHERE rn <= n_open
      ON CONFLICT (closes_journal_id) WHERE closes_journal_id IS NOT NULL DO NOTHING
    `.execute(this.#db);
    return Number(r.numAffectedRows ?? 0n);
  }
}
