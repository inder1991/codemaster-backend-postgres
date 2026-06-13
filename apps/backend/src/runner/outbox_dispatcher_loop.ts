// Phase 3c (de-Temporal full-removal program): the Postgres leased drain loop replacing the
// OutboxDispatcherWorkflow's CONTINUOUS-LOOP singleton body (outbox_dispatcher.workflow.ts) in the
// Temporal-free runtime. SAME drain logic — claim a batch → dispatch + mark each row in claim order
// → idle when the batch is empty — but as a plain in-process loop over the SAME 4 proven
// Postgres-backed activities (OutboxDispatchActivities: claimPendingRows / dispatchRow /
// markDispatched / markAttemptFailed). The outbox dispatch logic itself is UNCHANGED; the Temporal
// workflow stays in place until Phase 4 deletes it, and the temporal_workflow_start sink still
// dispatches via the RealTemporalClient until Phase 3d rewires that sink.
//
// ## Temporal-only machinery deliberately DROPPED (a plain loop has no history)
//   * continueAsNew / workflowInfo().continueAsNewSuggested — the BF-12 history boundary exists
//     only because Temporal accumulates event history; this loop holds no history at all.
//   * The per-activity proxyActivities retry curves (retryDb ×5 / retryDispatch ×2). Dispatch-level
//     retry rides the ROW's durable `attempts` column instead: a TRANSIENT dispatch failure is
//     recorded via markAttemptFailed (lease deferred by the CS3c.1 backoff → re-claimable;
//     atomically dead-lettered at the threshold), so retries survive process restarts exactly as
//     they did under Temporal; a NON-RETRYABLE failure (PermanentSinkError / UnknownSinkError —
//     RC7, see drainOnce's per-row catch) dead-letters IMMEDIATELY via markPermanentlyFailed
//     instead of burning the threshold. A DB error on claim/mark propagates OUT of
//     {@link OutboxDispatcherLoop.run} — fail-loud; the composition root's restart policy is the
//     supervisor (the same posture as SchedulerLoop.run).
//   * The isCancellation re-throw in the per-row catch — Temporal injects cancellation into
//     activity awaits on worker shutdown; this runtime's stop() NEVER interrupts an in-flight
//     drain pass (it only wakes the idle sleep), so a dispatch failure here is ALWAYS a real
//     dispatch failure and is ALWAYS recorded as an attempt.
//
// ## Concurrency + ordering
// The outbox rows are LEASED: claimPendingRows takes `FOR UPDATE OF o SKIP LOCKED` row locks and
// stamps `leased_until`, so multiple concurrent drainers are SAFE (they partition the pending set;
// a crashed drainer's rows become re-claimable after the lease expires). Run ONE loop per
// deployment regardless — that preserves the original singleton-workflow intent (global
// created_at-ordered draining); N drainers would interleave batches and the cross-batch order
// guarantee degrades to per-drainer. WITHIN a batch, dispatch order is the claim order
// (`ORDER BY o.created_at`), 1:1 with the workflow body's `for (const row of rows)`.

import type { OutboxRow } from "#backend/domain/repos/outbox_repo.js";
import {
  PermanentSinkError,
  RetryableSinkError,
  UnknownSinkError,
} from "#backend/outbox/sink_registry.js";
import type {
  ClaimPendingRowsInputV1,
  DispatchRowInputV1,
  MarkAttemptFailedInputV1,
  MarkDispatchedInputV1,
  MarkPermanentlyFailedInputV1,
} from "#contracts/outbox_dispatch.v1.js";

import type { Clock } from "#platform/clock.js";

import { cancellableSleep } from "./clock_async.js";

/** The 5-activity surface the loop drains through — the arrow-property methods of
 *  OutboxDispatchActivities satisfy it structurally (buildBackgroundRunner wires them; tests
 *  substitute a recording dispatchRow). markPermanentlyFailed (RC7) is LOOP-ONLY — the Temporal
 *  workflow proxies just the first 4 (its generic catch predates the taxonomy and retires with it
 *  in Phase 4). dispatchRow's `extras` (W1.9e) is equally LOOP-ONLY: the OUTBOX ROW's delivery_id,
 *  threaded OUTSIDE the parity-locked DispatchRowInputV1 wire shape (no delivery_id field in the
 *  contract) so the sinks can run the destination-side identity cross-check. */
export type OutboxActivityFns = {
  claimPendingRows(input: ClaimPendingRowsInputV1): Promise<Array<OutboxRow>>;
  dispatchRow(input: DispatchRowInputV1, extras?: { deliveryId?: string | null }): Promise<void>;
  markDispatched(input: MarkDispatchedInputV1): Promise<void>;
  markAttemptFailed(input: MarkAttemptFailedInputV1): Promise<void>;
  markPermanentlyFailed(input: MarkPermanentlyFailedInputV1): Promise<void>;
};

// Loop tuning — 1:1 with the workflow module constants (outbox_dispatcher.workflow.ts:24-26).
// DEFAULT_OUTBOX_LEASE_SECONDS=10 is passed EXPLICITLY on every claim — it intentionally differs
// from the contract default (60); the dispatch activity's lease heartbeat re-extends to a 10s
// window, so a "simplification" that drops this would silently 6× the lease.
export const DEFAULT_OUTBOX_BATCH_SIZE = 100;
export const DEFAULT_OUTBOX_LEASE_SECONDS = 10;
export const DEFAULT_OUTBOX_DRAIN_INTERVAL_SECONDS = 2;
/** W3.2 (RM1): the per-dispatch hard bound — the old Temporal `startToCloseTimeout: '1 minute'`
 *  the plain loop dropped. A dispatch that has not settled within this bound is abandoned
 *  (classified RETRYABLE → markAttemptFailed → the CS3c.1 backoff/lease machinery), so a single
 *  black-holed sink can no longer wedge the serial drainer — and every webhook/review/knowledge
 *  event behind it — forever. */
export const DEFAULT_OUTBOX_DISPATCH_TIMEOUT_SECONDS = 60;
/** The watchdog re-checks its monotonic deadline at most every this-many seconds, so an abandoned
 *  WallClock sleep timer lingers ≤1s after the dispatch settles (never a full 60s timer per row). */
const DISPATCH_WATCHDOG_TICK_SECONDS = 1;

/** A dispatch overran the per-dispatch bound (RM1). Subclasses {@link RetryableSinkError} so the
 *  drain loop's RC7 taxonomy classifies it TRANSIENT: the row is released to the durable
 *  attempts/backoff path and re-claimed after the lease defers — exactly how the old Temporal
 *  start-to-close force-failure re-entered the retry policy. */
export class DispatchTimeoutError extends RetryableSinkError {
  public constructor(message: string) {
    super(message);
    this.name = "DispatchTimeoutError";
  }
}

/**
 * The dispatcher loop — mirrors BackgroundRunnerLoop/SchedulerLoop: drain, then `cancellableSleep`
 * for `idleS` ONLY when the claim came back empty (busy-loop on success: a drained batch
 * immediately re-claims, 1:1 with the workflow body); {@link stop} interrupts the idle sleep
 * immediately and ends the loop after the in-flight pass completes (wire to
 * `process.on('SIGTERM', () => loop.stop())`).
 */
export class OutboxDispatcherLoop {
  #stopped = false;
  readonly #stop = new AbortController();                  // wakes the idle sleep immediately on stop()
  readonly #batchSize: number;
  readonly #leaseSeconds: number;
  readonly #idleS: number;
  /** W3.2 (RM1): the per-dispatch hard bound (seconds) — see {@link #dispatchBounded}. */
  readonly #dispatchTimeoutS: number;
  /** CS1.2 SHADOW posture — see {@link drainOnce}'s top guard. */
  readonly #shadow: boolean;
  /** The shadow suppression is logged ONCE per loop instance (run() re-enters drainOnce every
   *  idleS — an unconditional log would spam every ~2s for the process lifetime). */
  #shadowLogged = false;

  public constructor(
    private o: {
      activities: OutboxActivityFns;
      clock: Clock;
      batchSize?: number;
      leaseSeconds?: number;
      idleS?: number;
      /** W3.2 (RM1): per-dispatch hard bound (seconds). Default
       *  {@link DEFAULT_OUTBOX_DISPATCH_TIMEOUT_SECONDS} (60 — the old Temporal start-to-close). */
      dispatchTimeoutS?: number;
      /** CS1.2 SHADOW posture: true → every drain pass is suppressed BEFORE the claim (see
       *  {@link drainOnce}). Default false (the production behavior). */
      shadow?: boolean;
    },
  ) {
    this.#batchSize = o.batchSize ?? DEFAULT_OUTBOX_BATCH_SIZE;
    this.#leaseSeconds = o.leaseSeconds ?? DEFAULT_OUTBOX_LEASE_SECONDS;
    this.#idleS = o.idleS ?? DEFAULT_OUTBOX_DRAIN_INTERVAL_SECONDS;
    this.#dispatchTimeoutS = o.dispatchTimeoutS ?? DEFAULT_OUTBOX_DISPATCH_TIMEOUT_SECONDS;
    this.#shadow = o.shadow ?? false;
  }

  public stop(): void { this.#stopped = true; this.#stop.abort(); }

  /**
   * ONE drain pass — the single-cycle drive seam (the scheduler's pollOnce idiom): claim a batch,
   * then for each row IN CLAIM ORDER dispatch + markDispatched, with the workflow body's PER-ROW
   * try/catch (a dispatch failure marks THAT row's attempt via markAttemptFailed — atomically
   * dead-lettered at the threshold — and the rest of the batch still drains). Returns the number
   * of rows claimed (0 → the caller idles).
   */
  public async drainOnce(): Promise<number> {
    if (this.#shadow) {
      // CS1.2 SHADOW guard — the WHOLE pass is suppressed, including the claim: claimPendingRows
      // stamps `leased_until` on core.outbox (a production-table mutation), and in shadow the LIVE
      // Temporal dispatcher drains the same table — a shadow lease would delay every real dispatch
      // by up to lease_seconds. So in shadow: no claim/lease, no dispatchRow (no sink fires — no
      // GitHub post, no Temporal start, no background/review enqueue), no markDispatched, no
      // markAttemptFailed. Returns 0 so run() idles (rows never settle in shadow; a >0 return
      // would hot busy-loop). Richer would-dispatch observation (read-only peek into a dedicated
      // shadow observation table) is the deferred full W0.1 shadow build — see CS1 in
      // docs/audits/2026-06-11-cutover-safety-plan.md.
      if (!this.#shadowLogged) {
        this.#shadowLogged = true;
        console.info(
          "outbox dispatcher shadow-mode: drain SUPPRESSED — no claim/lease, no dispatch, no " +
            "markDispatched/markAttemptFailed (CS1.2 no-side-effects contract; logged once)",
        );
      }
      return 0;
    }
    const rows = await this.o.activities.claimPendingRows({
      batch_size: this.#batchSize,
      lease_seconds: this.#leaseSeconds,
    });

    for (const row of rows) {
      try {
        await this.#dispatchBounded(
          {
            schema_version: 2,
            row_id: row.id,
            sink: row.sink,
            payload: row.payload,
            trace_context: row.traceContext as Record<string, string>,
            run_id: row.runId,
            review_id: row.reviewId,
            provider: row.provider,
            installation_id: row.installationId,
            // Tagged-union: a null installation_id MUST carry orphan_reason='bootstrap_sink' (the
            // DispatchRow contract validator). Review-causal rows always have a UUID installation_id
            // → orphan_reason null. (1:1 with the workflow body.)
            orphan_reason: row.installationId === null ? "bootstrap_sink" : null,
          },
          // W1.9e: the ROW's delivery_id rides OUTSIDE the parity-locked contract (type doc above)
          // → SinkContext.deliveryId → the destination identity cross-check. Forwarded THROUGH the
          // W3.2 RM1 per-dispatch bound — the two hardenings compose.
          { deliveryId: row.deliveryId },
        );
        // R-6 fence: expected_attempts = row.attempts (the claim-time snapshot) — same as markAttemptFailed
        // — so a stale pod whose row was re-claimed + failed elsewhere can't overwrite that outcome (N2).
        await this.o.activities.markDispatched({ row_id: row.id, expected_attempts: row.attempts });
      } catch (e) {
        // RC7 — sink error taxonomy (cutover-safety CS4.2; mirrors the background runner's W4a.1
        // PermanentJobError split). Classification of the dispatch failure:
        //   * NON-RETRYABLE → dead-letter IMMEDIATELY. PermanentSinkError is the sink's declared
        //     "retry CANNOT succeed" (schema-violating payload, REJECT_DUPLICATE, …);
        //     UnknownSinkError means NO handler is registered for the row's sink — a wiring bug
        //     retry cannot conjure away. Burning maxAttempts backoff cycles on these only delays
        //     the dead-letter signal operators page off. The taxonomy class name is prefixed into
        //     last_error so the one-attempt dead row is self-describing. instanceof is sound here:
        //     dispatchRow is an in-process call (no Temporal serialization boundary), so the thrown
        //     error keeps its class identity.
        //   * Everything else is presumed TRANSIENT → markAttemptFailed (the CS3c.1 exponential-
        //     backoff retry path; atomically dead-letters at the threshold).
        // Both settles share the R-6 fence: expected_attempts = row.attempts (the pre-attempt
        // snapshot from claimPendingRows) makes a duplicate settlement a rowcount-0 no-op, and the
        // lease semantics are the repo's (terminal → lease released; retry → lease DEFERRED by the
        // backoff so a failing sink is paced, not hammered).
        const permanent = e instanceof PermanentSinkError || e instanceof UnknownSinkError;
        // CS8: ONE structured WARN per failed row — pre-CS8 the error landed ONLY in the row's
        // last_error column (visible only by querying core.outbox); now the failure is in the pod
        // logs with the correlation keys + the RC7 classification. Same console-JSON idiom as the
        // activity's canonical outbox.dead_letter emit.
        console.warn(
          JSON.stringify({
            event: "outbox.dispatch_failed",
            row_id: row.id,
            sink: row.sink,
            run_id: row.runId,
            review_id: row.reviewId,
            installation_id: row.installationId,
            attempts: row.attempts,
            classification: permanent ? "permanent" : "retryable",
            error: (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 1024),
          }),
        );
        if (permanent) {
          await this.o.activities.markPermanentlyFailed({
            row_id: row.id,
            error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 1024),
            expected_attempts: row.attempts,
          });
        } else {
          await this.o.activities.markAttemptFailed({
            row_id: row.id,
            error: (e instanceof Error ? e.message : String(e)).slice(0, 1024),
            expected_attempts: row.attempts,
          });
        }
      }
    }
    return rows.length;
  }

  /**
   * W3.2 (RM1): dispatch ONE row under the per-dispatch hard bound. `Promise.race` between the
   * activity call and a Clock-driven watchdog ({@link #dispatchWatchdog}); on overrun the watchdog
   * throws {@link DispatchTimeoutError} into drainOnce's per-row catch, which routes it down the
   * EXISTING retryable path (markAttemptFailed → attempts+1, backoff-deferred lease, R-6 fence) —
   * the same recovery the old Temporal start-to-close force-failure produced. The loop then moves
   * on: a hung sink costs at most `dispatchTimeoutS` of drainer time, never the whole drainer.
   *
   * JS cannot kill the abandoned dispatch promise — it may settle later. A late SUCCESS is the
   * documented at-least-once posture (the row re-dispatches after backoff; destinations must be
   * idempotent — RM2); a late REJECTION is observed here (one structured WARN) so it can never
   * surface as an unhandled rejection, and the activity-side heartbeat cap (RM3) guarantees the
   * zombie stops refreshing the row's lease.
   */
  async #dispatchBounded(
    input: DispatchRowInputV1,
    extras: { deliveryId?: string | null }): Promise<void> {
    const standDown = new AbortController(); // settles the watchdog once the race is decided
    const dispatch = this.o.activities.dispatchRow(input, extras);
    try {
      await Promise.race([dispatch, this.#dispatchWatchdog(input.row_id, input.sink, standDown.signal)]);
    } catch (e) {
      if (e instanceof DispatchTimeoutError) {
        // The hung dispatch is ABANDONED: attach a settle-observer so its eventual rejection is a
        // WARN with correlation keys, never an unhandled-rejection process crash. (Its row was
        // already settled by the caller's markAttemptFailed; the R-6 expected_attempts fence makes
        // any late duplicate settlement a rowcount-0 no-op.)
        dispatch.catch((late: unknown) => {
          console.warn(
            JSON.stringify({
              event: "outbox.dispatch_settled_after_timeout",
              row_id: input.row_id,
              sink: input.sink,
              error: (late instanceof Error ? `${late.name}: ${late.message}` : String(late)).slice(0, 1024),
            }),
          );
        });
      }
      throw e;
    } finally {
      standDown.abort();
    }
  }

  /** The RM1 watchdog: sleeps on the injected Clock in ≤{@link DISPATCH_WATCHDOG_TICK_SECONDS}
   *  ticks until the monotonic deadline, then THROWS {@link DispatchTimeoutError}; resolves quietly
   *  when stood down (the dispatch settled first — the race is already decided). */
  async #dispatchWatchdog(rowId: string, sink: string, signal: AbortSignal): Promise<void> {
    const deadline = this.o.clock.monotonic() + this.#dispatchTimeoutS;
    for (;;) {
      if (signal.aborted) {
        return;
      }
      const remainingS = deadline - this.o.clock.monotonic();
      if (remainingS <= 0) {
        throw new DispatchTimeoutError(
          `dispatch of outbox row ${rowId} (sink ${sink}) exceeded the ${this.#dispatchTimeoutS}s ` +
            `per-dispatch bound (RM1 — the old Temporal start-to-close); the row is released to the ` +
            `attempts/backoff machinery and the drain loop moves on`,
        );
      }
      await cancellableSleep(this.o.clock, Math.min(remainingS, DISPATCH_WATCHDOG_TICK_SECONDS), signal);
    }
  }

  public async run(): Promise<void> {
    while (!this.#stopped) {
      const claimed = await this.drainOnce();              // an in-flight pass ALWAYS completes (drain)
      if (claimed === 0 && !this.#stopped) {
        // Busy-loop on success (no sleep between a drained batch and the re-claim); idle ONLY on
        // an empty claim — 1:1 with the workflow body's sleep-on-empty.
        await cancellableSleep(this.o.clock, this.#idleS, this.#stop.signal); // stop() interrupts
      }
    }
  }
}
