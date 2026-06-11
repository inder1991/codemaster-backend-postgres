// The 4 OutboxDispatcherWorkflow activities (1:1 with the @activity.defn functions in
// vendor/codemaster-py/codemaster/activities/outbox.py: claim_pending_rows / dispatch_row /
// mark_dispatched / mark_attempt_failed). Bundled in one collaborator-injected holder (Shape B) —
// buildOutboxActivities constructs it once at worker boot and registers the four arrow-property methods.
// Phase 3c / RC7 adds a 5th, LOOP-ONLY method (markPermanentlyFailed — the immediate dead-letter for
// non-retryable sink failures); it has no Python counterpart and is NOT Temporal-registered: only the
// Temporal-free OutboxDispatcherLoop consumes it.
//
// Activities run in the NORMAL Node runtime (NOT the workflow V8-isolate sandbox), so they freely touch
// Postgres + the injected Clock. Each registered method takes exactly ONE typed input (CLAUDE.md
// invariant 11); the #guardTransitionAndIngest helper is private (not registered), so its multi-arg shape
// is fine.

import { type Kysely, sql, type Transaction } from "kysely";

import type { OutboxRow, PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";
import { assertCurrentRun, StaleWriteError } from "#backend/domain/stale_write_guard.js";
import { TransitionOutcome, transitionRun } from "#backend/domain/transition_run.js";
import { emitWorkflowEvent } from "#backend/ingest/_workflow_events_repository.js";
import { PendingEmits } from "#backend/infra/post_commit_emit.js";
import { getSink, type SinkContext } from "#backend/outbox/sink_registry.js";

import { type Clock } from "#platform/clock.js";

import {
  ClaimPendingRowsInputV1,
  DispatchRowInputV1,
  MarkAttemptFailedInputV1,
  MarkDispatchedInputV1,
  MarkPermanentlyFailedInputV1,
} from "#contracts/outbox_dispatch.v1.js";

// Sprint 14.5 / S14.5.D — lease-heartbeat tunables (1:1 with vendor/codemaster-py/codemaster/activities/
// outbox.py: HEARTBEAT_INTERVAL_SECONDS / HEARTBEAT_LEASE_SECONDS). The default claim lease is 10s; the
// heartbeat fires every 2s so a multi-second sink handler keeps the lease fresh. A db blip on the heartbeat
// is logged at WARN and NOT propagated — the lease itself is the safety net (it expires; another pod
// re-claims; the handler's eventual write either commits cleanly or surfaces a CHECK violation).
const HEARTBEAT_INTERVAL_SECONDS = 2;
const HEARTBEAT_LEASE_SECONDS = 10;
/** W3.2 (RM3): the maximum TOTAL lease lifetime one dispatch's heartbeat may sustain — the old
 *  Temporal `startToCloseTimeout` (60s), paired with the drain loop's RM1 per-dispatch bound.
 *  Pre-RM3 the heartbeat re-extended `leased_until` for the entire life of the handler, so a
 *  live-but-stuck sink kept its row un-reclaimable FOREVER (the lease safety net only fired for
 *  the crashed case, not the hung case). Past this cap the heartbeat stops (one structured WARN)
 *  and the lease expires on its own — another drainer can reclaim, and a zombie handler that
 *  outlived the loop's RM1 timeout can no longer fight the backoff lease markAttemptFailed set. */
const HEARTBEAT_MAX_TOTAL_SECONDS = 60;

export type OutboxDispatchActivitiesOptions = {
  repo: PostgresOutboxRepo;
  /** The dispatcher's own connection (its own pool; ADR-0062 cached engine). */
  db: Kysely<unknown>;
  clock: Clock;
  /** `cfg.max_attempts` — the dead-letter threshold the markAttemptFailed activity injects (default 5). */
  maxAttempts: number;
};

export class OutboxDispatchActivities {
  readonly #repo: PostgresOutboxRepo;
  readonly #db: Kysely<unknown>;
  readonly #clock: Clock;
  readonly #maxAttempts: number;

  public constructor(o: OutboxDispatchActivitiesOptions) {
    // 1:1 with the Python configure() ValueError, hardened against an env-sourced NaN (Number("abc")):
    // `NaN < 1` is false, so a plain `< 1` check would let a non-dead-lettering threshold through.
    if (!Number.isInteger(o.maxAttempts) || o.maxAttempts < 1) {
      throw new Error(`max_attempts must be an integer >= 1; got ${String(o.maxAttempts)}`);
    }
    this.#repo = o.repo;
    this.#db = o.db;
    this.#clock = o.clock;
    this.#maxAttempts = o.maxAttempts;
  }

  /** `claim_pending_rows` — lease a batch of pending rows for the dispatcher loop. */
  public readonly claimPendingRows = async (input: ClaimPendingRowsInputV1): Promise<Array<OutboxRow>> => {
    const v = ClaimPendingRowsInputV1.parse(input); // boundary validation (parity with the Python data-converter)
    return this.#repo.claimPending({
      db: this.#db,
      batchSize: v.batch_size,
      leaseSeconds: v.lease_seconds,
    });
  };

  /**
   * `dispatch_row` — resolve the sink + invoke it. For review-causal rows (run_id && review_id present) the
   * AD-4 stale-write guard + PENDING→RUNNING lifecycle transition + INGESTED milestone run FIRST in one
   * transaction (a superseded run cannot drive the downstream durable mutation). Bootstrap-sink rows
   * (installation_reconcile / sync_code_owners, whose review_id is null) skip the guard block entirely.
   */
  public readonly dispatchRow = async (
    input: DispatchRowInputV1,
    // W1.9e — the dispatching OUTBOX ROW's delivery_id, threaded by the Postgres drain loop as a
    // RUNTIME-ONLY 2nd argument: DispatchRowInputV1 is parity-locked to the frozen Python model
    // (which carries no delivery_id field), so the wire contract stays byte-identical while the
    // sinks gain the independent identity source for the destination-side cross-check. The
    // Temporal proxy path never passes it → null, 1:1 with the frozen Python's SinkContext.
    // DEFAULTED (not `?:`) so Function.length stays 1 — the worker-registration arity pin
    // (invariant 11: single-typed-input activities) holds on the Temporal-registered surface.
    extras: { deliveryId?: string | null } = {},
  ): Promise<void> => {
    // Boundary validation FIRST — restores the DispatchRowInputV1.superRefine tagged-union guard
    // (installation_id null IFF orphan_reason set) that the Python pydantic_data_converter re-runs on
    // activity-side deserialization. The TS stock JSON converter does not, so without this the BF-3
    // NULL-tenant-column invariant would be enforced nowhere at runtime.
    const v = DispatchRowInputV1.parse(input);

    const handler = getSink(v.sink); // throws UnknownSinkError BEFORE any DB work (1:1 with Python)

    if (v.run_id !== null && v.review_id !== null) {
      await this.#guardTransitionAndIngest(v, v.run_id, v.review_id);
    }

    const context: SinkContext = {
      deliveryId: extras.deliveryId ?? null, // the wire contract carries no delivery_id (doc above)
      installationId: v.installation_id,
      runId: v.run_id,
      // W3.2 (RM2): the destination-side idempotency key — the dispatching outbox row id. A
      // re-dispatch of the same row (the at-least-once redrive) presents the SAME key, so a
      // destination that dedupes on it is effectively-once even after a prior execution settled.
      outboxRowId: v.row_id,
    };

    // Lease-heartbeat (S14.5.D — 1:1 with the Python dispatch_row _heartbeat closure). A background loop
    // extends `leased_until` by HEARTBEAT_LEASE_SECONDS (10s) every HEARTBEAT_INTERVAL_SECONDS (2s) for the
    // life of the handler, so a sink that runs close to the 10s claim lease (up to the 60s start-to-close
    // timeout) does not lose its lease and get double-dispatched by another pod. A heartbeat extendLease
    // failure is logged at WARN and NOT propagated (fail-open) — the lease itself is the safety net (it
    // expires; another pod re-claims). The loop is stopped in `finally` so a zombie task can't keep writing
    // after the handler returns.
    const heartbeat = this.#startLeaseHeartbeat(v.row_id);
    try {
      // SEAM (trace-restore — DEFER §E): OTel trace-context restore is not ported. `v.trace_context` is
      // carried through the contract but not bound to the OTel context here (fail-open — Python's
      // bind_trace_context({}) is a no-op for empty context). Activate by binding it around this call.
      await handler({ payload: v.payload, context });
    } finally {
      heartbeat.stop();
    }
  };

  /**
   * `mark_dispatched` — final pending→dispatched transition (idempotent; redrive → repo returns null). The
   * dispatch-to-done histogram from the returned timing is deferred with the OTel surface (§D5).
   */
  public readonly markDispatched = async (input: MarkDispatchedInputV1): Promise<void> => {
    const v = MarkDispatchedInputV1.parse(input);
    await this.#repo.markDispatched({ db: this.#db, id: v.row_id });
    // SEAM (OTel — DEFER §D5): on a non-null return, record the dispatch-to-done histogram from the timing.
  };

  /**
   * `mark_attempt_failed` — atomic increment + dead-letter at `maxAttempts` (R-6 redrive-safe via the
   * input's expected_attempts). Emits the canonical `outbox.dead_letter` signal EXACTLY ONCE when the row
   * crosses into 'dead' (the repo's `null` on a redrive suppresses a duplicate signal).
   */
  public readonly markAttemptFailed = async (input: MarkAttemptFailedInputV1): Promise<void> => {
    const v = MarkAttemptFailedInputV1.parse(input);
    const result = await this.#repo.markAttemptFailed({
      db: this.#db,
      id: v.row_id,
      error: v.error,
      maxAttempts: this.#maxAttempts,
      expectedAttempts: v.expected_attempts,
    });
    if (result?.state === "dead") {
      // SEAM (OTel — DEFER §D5): OUTBOX_DEAD_LETTER_COUNTER.add(1, { sink: result.sink }). The structured
      // log is the live signal SREs page off until the OTel counter is wired.
      console.error(
        JSON.stringify({
          event: "outbox.dead_letter",
          row_id: v.row_id,
          sink: result.sink,
          error: v.error,
        }),
      );
    }
  };

  /**
   * `markPermanentlyFailed` (Phase 3c / RC7 — NO Python counterpart; NOT registered on the Temporal
   * worker): the IMMEDIATE terminal settle for a NON-RETRYABLE dispatch failure. The
   * OutboxDispatcherLoop classifies PermanentSinkError / UnknownSinkError in its per-row catch and
   * routes them here instead of {@link markAttemptFailed} — same fenced atomic UPDATE (attempts+1 +
   * last_error recorded; the R-6 expected_attempts fence suppresses duplicate settlement) but routed
   * STRAIGHT to 'dead' so a permanent failure never burns maxAttempts backoff cycles. Emits the SAME
   * canonical `outbox.dead_letter` signal exactly once (the fence's `null` on a duplicate suppresses
   * a second emit), tagged `classification: "permanent"` to distinguish it from attempts-exhausted.
   */
  public readonly markPermanentlyFailed = async (input: MarkPermanentlyFailedInputV1): Promise<void> => {
    const v = MarkPermanentlyFailedInputV1.parse(input);
    const result = await this.#repo.markAttemptFailed({
      db: this.#db,
      id: v.row_id,
      error: v.error,
      maxAttempts: this.#maxAttempts,
      expectedAttempts: v.expected_attempts,
      permanent: true,
    });
    if (result?.state === "dead") {
      // SEAM (OTel — DEFER §D5): OUTBOX_DEAD_LETTER_COUNTER.add(1, { sink: result.sink }) — same seam
      // as markAttemptFailed's emit above.
      console.error(
        JSON.stringify({
          event: "outbox.dead_letter",
          row_id: v.row_id,
          sink: result.sink,
          error: v.error,
          classification: "permanent",
        }),
      );
    }
  };

  /**
   * The guard + lifecycle + INGESTED block (1:1 with the Python dispatch_row guard, outbox.py:633-721).
   * One transaction: the AD-4 stale-write guard (in a raw SAVEPOINT so its forensic STALE_WRITE_BLOCKED
   * row survives the re-raise), then PENDING→RUNNING, then the INGESTED milestone gated on APPLIED (a
   * Temporal retry observes ALREADY_APPLIED → no duplicate milestone). `pending` collects the post-commit
   * OTel emits, drained only after a successful commit.
   */
  async #guardTransitionAndIngest(input: DispatchRowInputV1, runId: string, reviewId: string): Promise<void> {
    const pending = new PendingEmits();

    await this.#db.transaction().execute(async (txTyped) => {
      // The cross-subsystem seams accept a schema-agnostic Transaction<unknown> (they run raw `sql` + do
      // their own `instanceof Transaction` check). Widen once; the runtime handle is the same.
      const tx = txTyped as unknown as Transaction<unknown>;

      // FIRST: the AD-4 guard in a raw SAVEPOINT. RELEASE (not ROLLBACK TO) on a StaleWriteError merges the
      // guard's forensic INSERT into the outer transaction (1:1 with Python's begin_nested + sp.commit()),
      // then the re-raise propagates out of .execute() → outer rollback (no partial state).
      await sql`SAVEPOINT sp_outbox_stale_write_guard`.execute(tx);
      try {
        await assertCurrentRun({
          tx,
          runId,
          reviewId,
          site: "outbox_dispatcher.dispatch_row",
          pending,
          clock: this.#clock,
        });
      } catch (err) {
        if (err instanceof StaleWriteError) {
          await sql`RELEASE SAVEPOINT sp_outbox_stale_write_guard`.execute(tx);
        }
        throw err;
      }
      await sql`RELEASE SAVEPOINT sp_outbox_stale_write_guard`.execute(tx);

      // THEN: advance PENDING → RUNNING. transitionRun raises StateDrift if the run drifted (e.g. CANCELLED
      // via operator-supersede) → propagates → the sink is NOT invoked. Returns ALREADY_APPLIED on retry.
      const outcome = await transitionRun({
        tx,
        runId,
        fromState: "PENDING",
        toState: "RUNNING",
        activity: "outbox_dispatcher.dispatch_row",
        attempt: 1,
        pending,
        clock: this.#clock,
      });

      // THEN: the INGESTED milestone, gated on APPLIED so a Temporal at-least-once retry (ALREADY_APPLIED)
      // does not duplicate it. provider falls back to "github" only defensively (the JOIN resolves it).
      if (outcome === TransitionOutcome.APPLIED) {
        const ingestedPayload: Record<string, unknown> = { outbox_id: input.row_id, sink: input.sink };
        if (input.orphan_reason !== null) {
          ingestedPayload.orphan_reason = input.orphan_reason; // forward-compat with the orphan runtime guard
        }
        await emitWorkflowEvent({
          dbOrTx: tx,
          provider: input.provider ?? "github",
          runId,
          reviewId,
          eventType: "INGESTED",
          payload: ingestedPayload,
          deliveryId: null,
          installationId: input.installation_id,
          clock: this.#clock,
        });
      }
    });

    // After COMMIT: fire the queued OTel emits (e.g. the guard's stale-write counter — none on the happy
    // path). On rollback we never reach here, so they're dropped (BF-15 commit-aligned semantics).
    pending.drain();
  }

  /**
   * Lease-heartbeat loop (1:1 with the Python `_heartbeat` closure in dispatch_row). Spawns a fire-and-forget
   * background loop that, until {@link stop} is called, sleeps HEARTBEAT_INTERVAL_SECONDS on the injected
   * Clock then extends the row's lease by HEARTBEAT_LEASE_SECONDS. An extendLease failure is logged at WARN
   * and swallowed (fail-open: the lease itself is the safety net — Python catches `Exception` and continues).
   * `stop()` flips a flag so the loop exits after its current sleep (the Python `finally` cancels the task).
   *
   * W3.2 (RM3): the loop is CAPPED at {@link HEARTBEAT_MAX_TOTAL_SECONDS} of monotonic lifetime.
   * Past the cap it stops extending (one structured WARN — `outbox.lease_heartbeat_capped`) and
   * exits; the lease then expires within at most one HEARTBEAT_LEASE_SECONDS window, so a
   * live-but-stuck handler's row becomes reclaimable instead of being pinned forever. The handler
   * itself is NOT interrupted here — bounding the dispatch is the drain loop's RM1 watchdog.
   */
  #startLeaseHeartbeat(rowId: string): { stop(): void } {
    let stopped = false;
    const loop = async (): Promise<void> => {
      const capDeadline = this.#clock.monotonic() + HEARTBEAT_MAX_TOTAL_SECONDS;
      while (!stopped) {
        await this.#clock.sleep(HEARTBEAT_INTERVAL_SECONDS);
        if (stopped) {
          break;
        }
        if (this.#clock.monotonic() >= capDeadline) {
          // RM3: max total lease lifetime reached — STOP heartbeating and let the lease expire so
          // the row is reclaimable. WARN once: a handler still running at the cap is a stuck/slow
          // sink the operator should see (the RM1 timeout settles its row on the loop side).
          console.warn(
            JSON.stringify({
              event: "outbox.lease_heartbeat_capped",
              row_id: rowId,
              max_total_seconds: HEARTBEAT_MAX_TOTAL_SECONDS,
              posture: "heartbeat stopped; lease will expire and the row becomes reclaimable (RM3)",
            }),
          );
          break;
        }
        try {
          await this.#repo.extendLease({ db: this.#db, id: rowId, leaseSeconds: HEARTBEAT_LEASE_SECONDS });
        } catch (e) {
          console.warn(
            JSON.stringify({
              event: "outbox.lease_heartbeat_failed",
              row_id: rowId,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      }
    };
    void loop();
    return {
      stop(): void {
        stopped = true;
      },
    };
  }
}
