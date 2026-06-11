import { type Kysely, sql } from "kysely";
import type { Clock } from "#platform/clock.js";
import { CadenceKind } from "#contracts/scheduled_job.v1.js";
import type { EnqueueArgs } from "./background_jobs_repo.js";
import { cancellableSleep } from "./clock_async.js";
import { recordSchedulerScheduleError } from "./runner_metrics.js";

// Phase 3a W3: the Postgres scheduler/poller replacing Temporal Schedules (de-Temporal full-removal
// program). One pass ({@link pollAndEnqueue}) reads the due core.scheduled_jobs rows (migration 0040)
// and enqueues a core.background_jobs row per schedule; {@link SchedulerLoop} repeats the pass on a
// fixed cadence (the RunnerLoop idiom: cancellableSleep + stop()).
//
// ## Concurrent pollers are SAFE — no singleton election needed
// Three independent mechanisms compose so N pollers behave like one:
//   1. The due-SELECT takes `FOR UPDATE SKIP LOCKED` row locks — two simultaneous passes partition
//      the due set instead of double-processing a row.
//   2. Each processed row's `next_run_at` is advanced INSIDE the same transaction that locked it —
//      once a pass commits, the row is no longer due, so a later pass skips it.
//   3. Even when a pass crashes between the enqueue (autocommitted on the repo's own connection) and
//      the `next_run_at` advance (rolled back), the retrying pass's enqueue lands on the dedup
//      partial-unique index `uq_background_jobs_dedup_active` (`dedup_key = schedule_id`) and returns
//      the EXISTING active job — at-least-once delivery, exactly-one ACTIVE job.
//
// ## overlap=SKIP falls out of the dedup key
// `dedup_key = schedule_id` means at most ONE ACTIVE ('ready'|'leased') background job can exist per
// schedule: while a prior tick's job is still unconsumed/running, a due poll re-enqueues onto the
// SAME row (BackgroundJobsRepo.enqueue's ON CONFLICT DO NOTHING + re-SELECT) instead of stacking a
// second run — Temporal's `overlapPolicy: SKIP` semantics with zero scheduler-side bookkeeping. The
// schedule's cadence still advances on every due poll (the skip is on the JOB, not the cadence).
//
// ## Operational notes
//   * core.scheduled_jobs is PLATFORM-GLOBAL (no installation_id column — schedules are operator-
//     owned platform cadences, not tenant data), so no tenancy filter applies to its queries.
//   * The repo's enqueue runs on its OWN pool connection while the poll transaction holds another —
//     the shared pool must allow ≥ 2 concurrent connections per poller.
//   * PER-SCHEDULE ISOLATION (Phase 4a W4a.2): a row whose cadence_spec cannot be computed
//     ({@link computeNextRun} throws — e.g. an operator-inserted "*/5 * * * *") is SKIPPED, not
//     pass-fatal: pollAndEnqueue WARN-logs the schedule_id + error, bumps the bounded counter
//     codemaster_runner_scheduler_schedule_errors_total, leaves the row UNADVANCED (it stays due —
//     re-attempted next poll, still isolated), and continues to the next schedule. A permanently-bad
//     spec therefore logs on EVERY poll until an operator fixes or disables it, but can never halt
//     the healthy schedules (pre-W4a.2 it rejected the whole pass and ALL schedules stopped firing).
//     The spec is validated BEFORE the enqueue side effect, so a poison schedule enqueues NOTHING.
//     Pass-LEVEL errors (the due-SELECT / txn machinery) still propagate out of
//     {@link SchedulerLoop.run} — fail-loud, same posture as RunnerLoop.run, where a claim() DB
//     error also propagates. Supervision/restart is the composition root's job.

/**
 * Compute the next scheduled instant STRICTLY after `after`. PURE — no clock read happens here; the
 * `after` instant is threaded in by the caller ({@link pollAndEnqueue} passes clock.now()), so the
 * function is deterministic and exhaustively unit-testable.
 *
 *   * `interval`: cadence_spec is a positive integer number of SECONDS → `after` + that many seconds.
 *   * `cron`: ONLY the daily 5-field shape `"M H * * *"` (M = minute 0-59, H = hour 0-23, fields 3-5
 *     the literal `*`) is supported → the next UTC instant at H:M strictly after `after` (today if
 *     H:M is still ahead of `after` today, else tomorrow; `Date.UTC` day-overflow normalization
 *     carries month/year/leap rollovers). ANY other cron shape (lists, ranges, steps, non-* in
 *     fields 3-5, wrong field count, out-of-range M/H) THROWS so we extend the vocabulary
 *     deliberately instead of half-parsing it.
 */
export function computeNextRun(cadenceKind: CadenceKind, cadenceSpec: string, after: Date): Date {
  if (cadenceKind === "interval") {
    if (!/^\d+$/.test(cadenceSpec) || Number(cadenceSpec) < 1) {
      throw new Error(`unsupported interval spec: ${cadenceSpec} (expected a positive integer number of seconds)`);
    }
    return new Date(after.getTime() + Number(cadenceSpec) * 1000);
  }
  if (cadenceKind === "cron") {
    const bad = (): Error => new Error(`unsupported cron spec: ${cadenceSpec} (only "M H * * *" daily supported)`);
    const fields = cadenceSpec.split(" ");
    if (fields.length !== 5) throw bad();
    if (fields[2] !== "*" || fields[3] !== "*" || fields[4] !== "*") throw bad();
    const m = fields[0]!;
    const h = fields[1]!;
    if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) throw bad(); // pure integers only — no lists/ranges/steps/wildcards
    const minute = Number(m);
    const hour = Number(h);
    if (minute > 59 || hour > 23) throw bad();
    const todayAtMs = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), hour, minute, 0, 0);
    if (todayAtMs > after.getTime()) return new Date(todayAtMs); // today's H:M is still STRICTLY ahead
    // Else tomorrow — Date.UTC normalizes day overflow across month/year/leap boundaries.
    return new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate() + 1, hour, minute, 0, 0));
  }
  // ck_scheduled_jobs_cadence_kind makes this unreachable from DB rows; fail loud on contract drift.
  throw new Error(`unsupported cadence_kind: ${String(cadenceKind)}`);
}

/** The narrow enqueue seam the scheduler depends on — BackgroundJobsRepo satisfies it structurally. */
export type SchedulerEnqueuePort = {
  enqueue(a: EnqueueArgs): Promise<string>;
};

/** The columns one poll pass reads off a due core.scheduled_jobs row. */
type DueScheduleRow = {
  schedule_id: string;
  job_type: string;
  cadence_kind: string;
  cadence_spec: string;
  input: Record<string, unknown>;
};

/**
 * ONE scheduler pass: SELECT the due schedules (`enabled AND next_run_at <= clock.now()`) with
 * `FOR UPDATE SKIP LOCKED`; for each, enqueue a background job (`payload` = the schedule's `input`,
 * `dedup_key` = the schedule_id → overlap=SKIP, see module doc) and advance `next_run_at` via
 * {@link computeNextRun} + stamp `last_enqueued_at` (and the app-maintained `updated_at` — 0040
 * ships no touch-trigger, mirroring the 0039 repo's discipline). Returns the number of SUCCESSFULLY
 * enqueued schedules (a dedup'd enqueue still counts — the tick happened; it landed on the existing
 * active job; an ISOLATED failure does not — module doc "PER-SCHEDULE ISOLATION").
 *
 * Per-schedule isolation (W4a.2): ONE schedule's failure (poison cadence_spec, enqueue error, UPDATE
 * error) is caught, WARN-logged with its schedule_id, counted on the bounded
 * `codemaster_runner_scheduler_schedule_errors_total`, and SKIPPED — its `next_run_at` stays
 * unadvanced (re-attempted next poll, still isolated) while the pass continues over the rest. The
 * dominant poison class ({@link computeNextRun} throwing on a bad spec) is pure JS, so it cannot
 * abort the surrounding Postgres transaction; a failed UPDATE statement DOES poison the txn (later
 * advances roll back at commit), but the enqueues already landed on the repo's own connection and the
 * next pass's re-enqueues dedup onto them — at-least-once, exactly-one-ACTIVE, never a halted pass.
 */
export async function pollAndEnqueue(
  o: { repo: SchedulerEnqueuePort; db: Kysely<unknown>; clock: Clock;
    /** CS1.2 SHADOW posture: true → the pass OBSERVES the due set (would-enqueue logs) and
     *  performs NO side effect — no enqueue, no `next_run_at` advance, no `last_enqueued_at`
     *  stamp. Default false (the production behavior). */
    shadow?: boolean },
): Promise<number> {
  return await o.db.transaction().execute(async (trx) => {
    const now = o.clock.now();
    // core.scheduled_jobs is platform-global (no installation_id column) — no tenancy filter applies.
    const due = await sql<DueScheduleRow>`
      SELECT schedule_id, job_type, cadence_kind, cadence_spec, input
        FROM core.scheduled_jobs
       WHERE enabled AND next_run_at <= ${now}
         FOR UPDATE SKIP LOCKED`.execute(trx);
    if (o.shadow === true) {
      // CS1.2 SHADOW guard — placed BETWEEN the due-SELECT (read-only; the row locks release at
      // commit with zero writes) and the side-effecting loop below, so NOTHING can move in shadow:
      // no background job is enqueued and next_run_at is NEVER advanced (the schedule stays due and
      // is re-observed every poll — the shadow observation signal, by design). Returns 0: nothing
      // was SUCCESSFULLY enqueued (the documented return contract).
      for (const row of due.rows) {
        console.info(
          `scheduler shadow-mode: would-enqueue schedule ${row.schedule_id} ` +
            `(job_type ${row.job_type}) — suppressed: no background job enqueued, ` +
            `next_run_at NOT advanced (CS1.2 no-side-effects contract)`,
        );
      }
      return 0;
    }
    let enqueued = 0;
    for (const [i, row] of due.rows.entries()) {
      // CS7 (RT4/M13): each schedule's enqueue+advance runs in its OWN SAVEPOINT. The W4a.2 catch
      // alone contains pure-JS poisons, but a FAILED STATEMENT (a trigger/constraint rejecting the
      // advance UPDATE) aborts the whole surrounding transaction — every other schedule's advance
      // would roll back at commit and the entire due batch re-ticks next poll (cascade-retick).
      // ROLLBACK TO SAVEPOINT un-aborts the transaction so the poisoned schedule rolls back ALONE
      // and every healthy advance still commits in the same pass. (The savepoint name is derived
      // from the loop index — never from row data.)
      const savepoint = `cs7_schedule_${i}`;
      await sql.raw(`SAVEPOINT ${savepoint}`).execute(trx);
      try {
        // Validate the cadence FIRST ({@link computeNextRun} is pure — throws on a poison spec
        // BEFORE any side effect, so a bad schedule enqueues NOTHING), then enqueue (on the repo's
        // own connection — autocommits independently of this txn), then advance the cadence: a crash
        // between enqueue and advance leaves the row due, and the retrying pass's enqueue dedups
        // onto the active job (at-least-once + exactly-one-ACTIVE; module doc §3).
        const enqueuedAt = o.clock.now();
        const nextRunAt = computeNextRun(CadenceKind.parse(row.cadence_kind), row.cadence_spec, enqueuedAt);
        await o.repo.enqueue({ jobType: row.job_type, payload: row.input, dedupKey: row.schedule_id });
        await sql`UPDATE core.scheduled_jobs
            SET next_run_at = ${nextRunAt}, last_enqueued_at = ${enqueuedAt}, updated_at = ${enqueuedAt}
          WHERE schedule_id = ${row.schedule_id}`.execute(trx);
        await sql.raw(`RELEASE SAVEPOINT ${savepoint}`).execute(trx);
        enqueued += 1;
      } catch (e) {
        // PER-SCHEDULE ISOLATION (W4a.2 + CS7): un-abort the transaction, then skip THIS schedule,
        // never the pass. Left unadvanced → it stays due and is re-attempted (and re-isolated) next
        // poll; a permanently-bad spec logs on every poll until an operator fixes/disables it, but
        // never blocks the healthy schedules. (The enqueue landed on the repo's OWN connection, so
        // the savepoint rollback cannot un-enqueue it — the next pass's re-enqueue dedups onto it.)
        await sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`).execute(trx);
        recordSchedulerScheduleError();
        console.warn(
          `scheduler: schedule ${row.schedule_id} failed and was skipped (left unadvanced; ` +
            `re-attempted next poll): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return enqueued;
  });
}

/**
 * The scheduler loop — mirrors RunnerLoop/BackgroundRunnerLoop: poll, then `cancellableSleep` for
 * `pollIntervalS`; {@link stop} interrupts the sleep immediately (wire to
 * `process.on('SIGTERM', () => loop.stop())`). Concurrent pollers are SAFE (FOR UPDATE SKIP LOCKED +
 * the in-txn next_run_at advance + the enqueue dedup — module doc) so deployments need NO singleton
 * election; extra replicas just partition the due set. A rejected poll (a PASS-level DB error — the
 * due-SELECT / txn machinery) propagates out of {@link run} — fail-loud; the composition root owns
 * supervision. Per-SCHEDULE failures (poison cadence_spec etc.) are isolated inside the pass and do
 * NOT reach here (W4a.2 — module doc "PER-SCHEDULE ISOLATION").
 */
export class SchedulerLoop {
  #stopped = false;
  readonly #stop = new AbortController();                  // wakes the poll-interval sleep immediately on stop()
  constructor(
    private o: { repo: SchedulerEnqueuePort; db: Kysely<unknown>; clock: Clock; pollIntervalS: number;
      /** CS1.2 SHADOW posture, threaded straight into every {@link pollAndEnqueue} pass. */
      shadow?: boolean },
  ) {}
  stop(): void { this.#stopped = true; this.#stop.abort(); }

  async run(): Promise<void> {
    while (!this.#stopped) {
      await pollAndEnqueue(this.o);                        // an in-flight pass ALWAYS completes (drain)
      if (!this.#stopped) {
        await cancellableSleep(this.o.clock, this.o.pollIntervalS, this.#stop.signal); // stop() interrupts
      }
    }
  }
}
