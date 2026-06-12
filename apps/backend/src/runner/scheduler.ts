import { type Kysely, sql } from "kysely";
import type { z } from "zod";
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
//     ({@link computeNextRun} throws — e.g. an operator-inserted "30 5 1 * *"; the M12 vocabulary
//     expansion made "*/5 * * * *"-class specs VALID, so the poison class is now non-* fields 3-5
//     and malformed atoms) is SKIPPED, not
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
 *   * `cron` (M12 / W3.8 — the common-subset vocabulary): the 5-field shape `"m h * * *"` where the
 *     MINUTE and HOUR fields each take a comma-list of atoms — a bare value (`30`), the wildcard
 *     (`*`), a step (`*\/5`), a range (`9-17`), or a stepped range (`0-30/10`) — evaluated as the
 *     next UTC minute boundary strictly after `after` whose minute AND hour are in the parsed sets
 *     (wall-ALIGNED, unlike the drifting `interval` re-encoding the Temporal `*\/N` schedules got).
 *     Fields 3-5 (day-of-month / month / day-of-week) must stay the literal `*`, and ANY malformed
 *     atom (out-of-range value, inverted range, zero step, step on a bare value, wrong field count)
 *     THROWS — we still extend the vocabulary deliberately instead of half-parsing it; the
 *     per-schedule isolation (W4a.2 + CS7) contains a poison spec to its own row.
 */
export function computeNextRun(cadenceKind: CadenceKind, cadenceSpec: string, after: Date): Date {
  if (cadenceKind === "interval") {
    if (!/^\d+$/.test(cadenceSpec) || Number(cadenceSpec) < 1) {
      throw new Error(`unsupported interval spec: ${cadenceSpec} (expected a positive integer number of seconds)`);
    }
    return new Date(after.getTime() + Number(cadenceSpec) * 1000);
  }
  if (cadenceKind === "cron") {
    const fields = cadenceSpec.split(" ");
    if (fields.length !== 5) throw badCronSpec(cadenceSpec);
    if (fields[2] !== "*" || fields[3] !== "*" || fields[4] !== "*") throw badCronSpec(cadenceSpec);
    const minutes = parseCronField(fields[0]!, 0, 59, cadenceSpec);
    const hours = parseCronField(fields[1]!, 0, 23, cadenceSpec);
    // Scan forward from the minute boundary at/below `after`: candidate i ≥ 1 is the i-th boundary
    // AFTER it, so every candidate is strictly after `after` by construction. Both sets are
    // non-empty and every day matches (fields 3-5 are `*`), so a match exists within 24h + 1min;
    // the 2×1440 ceiling is pure fail-loud paranoia against an arithmetic regression.
    const baseMs = Date.UTC(
      after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(),
      after.getUTCHours(), after.getUTCMinutes(), 0, 0,
    );
    for (let i = 1; i <= 2 * 1440; i++) {
      const candidate = new Date(baseMs + i * 60_000);
      if (minutes.has(candidate.getUTCMinutes()) && hours.has(candidate.getUTCHours())) {
        return candidate;
      }
    }
    throw new Error(`unsupported cron spec: ${cadenceSpec} (internal: no matching instant within 48h)`);
  }
  // ck_scheduled_jobs_cadence_kind makes this unreachable from DB rows; fail loud on contract drift.
  throw new Error(`unsupported cadence_kind: ${String(cadenceKind)}`);
}

/** The single deliberate-extension error every malformed cron shape throws (M12). */
function badCronSpec(spec: string): Error {
  return new Error(
    `unsupported cron spec: ${spec} (minute/hour fields take N, *, */S, A-B, A-B/S and ` +
      `comma-lists of those; fields 3-5 must be *)`,
  );
}

/**
 * Parse ONE cron field (minute or hour) into its matching value set. Atom grammar (the M12 common
 * subset): `*` | `N` | `*\/S` | `A-B` | `A-B/S`, comma-combined. Steps require a `*` or range base
 * (standard cron: a step on a bare value is meaningless); ranges must not invert; every value must
 * sit in [min, max]. PURE and total over strings — anything else throws {@link badCronSpec}.
 */
function parseCronField(field: string, min: number, max: number, spec: string): ReadonlySet<number> {
  const out = new Set<number>();
  if (field === "") throw badCronSpec(spec);
  for (const atom of field.split(",")) {
    let base = atom;
    let step = 1;
    const slash = atom.indexOf("/");
    if (slash !== -1) {
      base = atom.slice(0, slash);
      const stepStr = atom.slice(slash + 1);
      if (!/^\d+$/.test(stepStr) || Number(stepStr) < 1) throw badCronSpec(spec);
      step = Number(stepStr);
      if (base !== "*" && !base.includes("-")) throw badCronSpec(spec); // step needs * or a range base
    }
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (base.includes("-")) {
      const parts = base.split("-");
      if (parts.length !== 2 || !/^\d+$/.test(parts[0]!) || !/^\d+$/.test(parts[1]!)) throw badCronSpec(spec);
      lo = Number(parts[0]);
      hi = Number(parts[1]);
      if (lo > hi) throw badCronSpec(spec); // no wrap-around ranges in the deliberate subset
    } else {
      if (!/^\d+$/.test(base)) throw badCronSpec(spec);
      lo = Number(base);
      hi = lo;
    }
    if (lo < min || hi > max) throw badCronSpec(spec);
    for (let v = lo; v <= hi; v += step) {
      out.add(v);
    }
  }
  return out;
}

/** The narrow enqueue seam the scheduler depends on — BackgroundJobsRepo satisfies it structurally. */
export type SchedulerEnqueuePort = {
  enqueue(a: EnqueueArgs): Promise<string>;
};

/**
 * W4.1 (L8): the scheduled-row envelope version this scheduler build understands
 * (core.scheduled_jobs.schema_version — migration 0045). A row stamped NEWER (rolling-deploy skew /
 * an operator pre-staging next-version config) is SKIPPED via the W4a.2 per-schedule isolation —
 * left unadvanced + WARN'd, re-attempted every poll until a scheduler that understands it polls.
 * Same two-phase bump discipline as the background-jobs envelope (background_jobs_repo.ts).
 */
export const SCHEDULED_JOB_ENVELOPE_SCHEMA_VERSION = 1;

/** The columns one poll pass reads off a due core.scheduled_jobs row. */
type DueScheduleRow = {
  schedule_id: string;
  job_type: string;
  cadence_kind: string;
  cadence_spec: string;
  input: Record<string, unknown>;
  /** The instant the row became due — read for the OM11 cadence-lateness signal (the tick instant
   *  minus this is the lateness) as well as being the advance UPDATE's predecessor value. */
  next_run_at: Date;
  /** W4.1 (L8): the row's envelope version — gated against
   *  {@link SCHEDULED_JOB_ENVELOPE_SCHEMA_VERSION} before any side effect. */
  schema_version: number;
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
    shadow?: boolean;
    /** W3.8 (RM7) — the scheduler-boundary input-contract registry (job_type → the SAME Zod
     *  contract its handler parses at dispatch; production threads
     *  {@link import("./scheduled_input_contracts.js").SCHEDULED_JOB_INPUT_CONTRACTS}). When
     *  present the boundary is DEFAULT-DENY over the operator-writable `core.scheduled_jobs` row:
     *  a job_type with no registry entry, or an `input` failing its contract, is rejected BEFORE
     *  the enqueue side effect — isolated to its own row via the W4a.2 posture (WARN naming the
     *  schedule_id + bounded error counter + left UNADVANCED), never forwarded to dead-letter at
     *  handler dispatch after burning a job slot. Omitted → legacy pass-through (the seam stays
     *  injectable for harnesses that mint synthetic job_types). */
    inputContracts?: ReadonlyMap<string, z.ZodTypeAny> },
): Promise<number> {
  return await o.db.transaction().execute(async (trx) => {
    const now = o.clock.now();
    // core.scheduled_jobs is platform-global (no installation_id column) — no tenancy filter applies.
    const due = await sql<DueScheduleRow>`
      SELECT schedule_id, job_type, cadence_kind, cadence_spec, input, next_run_at, schema_version
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
        // W4.1 (L8): envelope-version gate FIRST — a row stamped newer than this build understands
        // must not be interpreted through this build's contracts at all (its input/cadence may
        // legitimately carry next-version shapes). The throw lands in the W4a.2 catch below:
        // WARN + bounded counter + left unadvanced, never the whole pass.
        if (row.schema_version > SCHEDULED_JOB_ENVELOPE_SCHEMA_VERSION) {
          throw new Error(
            `scheduled row schema_version ${row.schema_version} is newer than this scheduler ` +
              `supports (${SCHEDULED_JOB_ENVELOPE_SCHEMA_VERSION}) — skipped for a newer build ` +
              `(deploy skew / pre-staged config)`,
          );
        }
        // W3.8 (RM7): validate the UNTRUSTED row against the job_type's dispatch contract FIRST —
        // default-deny. `scheduled_jobs` is platform-global operator config with no row tenancy;
        // pre-RM7 a malformed/hostile row only failed at HANDLER dispatch (dead-letter after
        // burning a job slot, re-enqueued every tick) and ANY job_type was schedulable, including
        // the cross-tenant event-driven ones. The throw lands in the W4a.2 catch below: WARN with
        // the schedule_id, bounded counter, row left unadvanced — and NOTHING was enqueued.
        if (o.inputContracts !== undefined) {
          const contract = o.inputContracts.get(row.job_type);
          if (contract === undefined) {
            throw new Error(
              `job_type '${row.job_type}' has no scheduled input contract — ` +
                `default-deny at the scheduler boundary (RM7; scheduled_input_contracts.ts ` +
                `registers the schedulable job_types)`,
            );
          }
          const parsed = contract.safeParse(row.input);
          if (!parsed.success) {
            throw new Error(
              `input rejected by the '${row.job_type}' scheduled contract (RM7): ${parsed.error.message}`,
            );
          }
        }
        // Validate the cadence ({@link computeNextRun} is pure — throws on a poison spec
        // BEFORE any side effect, so a bad schedule enqueues NOTHING), then enqueue (on the repo's
        // own connection — autocommits independently of this txn), then advance the cadence: a crash
        // between enqueue and advance leaves the row due, and the retrying pass's enqueue dedups
        // onto the active job (at-least-once + exactly-one-ACTIVE; module doc §3).
        const enqueuedAt = o.clock.now();
        const cadenceKind = CadenceKind.parse(row.cadence_kind);
        const nextRunAt = computeNextRun(cadenceKind, row.cadence_spec, enqueuedAt);
        await o.repo.enqueue({ jobType: row.job_type, payload: row.input, dedupKey: row.schedule_id });
        await sql`UPDATE core.scheduled_jobs
            SET next_run_at = ${nextRunAt}, last_enqueued_at = ${enqueuedAt}, updated_at = ${enqueuedAt}
          WHERE schedule_id = ${row.schedule_id}`.execute(trx);
        // W3.8 (OM11) — cadence-lateness signal: a wedged/starved schedule must be visible at the
        // SCHEDULE level (pre-OM11 only downstream symptoms — leaked mutexes, stuck runs — betrayed
        // a scheduler outage / OC3 wedge). Lateness = this tick's instant minus the row's own
        // next_run_at; the threshold is ONE FULL CADENCE (the due instant → its next computed
        // instant), strictly greater — at least one whole cycle was missed, which a healthy poll
        // loop (pollIntervalS ≪ cadence) can never produce. ONE structured WARN per late tick (the
        // CS8 console-JSON idiom), emitted AFTER the tick's writes succeeded: pure observability —
        // LOGS ONLY, deliberately no OTel (the OM11 gauge/alert rides the W3.9 SLO wave); it never
        // gates the enqueue/advance, and an isolated-failed schedule warns via the W4a.2 path
        // below instead.
        const latenessMs = enqueuedAt.getTime() - row.next_run_at.getTime();
        const cadenceMs =
          computeNextRun(cadenceKind, row.cadence_spec, row.next_run_at).getTime() -
          row.next_run_at.getTime();
        if (latenessMs > cadenceMs) {
          console.warn(
            JSON.stringify({
              event: "scheduler.cadence_late",
              schedule_id: row.schedule_id,
              job_type: row.job_type,
              due_at: row.next_run_at.toISOString(),
              lateness_s: Math.round(latenessMs / 1000),
              cadence_s: Math.round(cadenceMs / 1000),
            }),
          );
        }
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
      shadow?: boolean;
      /** W3.8 (RM7) — the boundary input-contract registry, threaded straight into every
       *  {@link pollAndEnqueue} pass (see its doc for the default-deny semantics). */
      inputContracts?: ReadonlyMap<string, z.ZodTypeAny> },
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
