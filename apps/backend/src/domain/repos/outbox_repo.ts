// Canonical write surface for `core.outbox` — Layer-2 typed producer repo. 1:1 port of
// vendor/codemaster-py/codemaster/domain/repos/outbox_repo.py (PostgresOutboxRepo / OutboxRepoPort).
//
// Three typed factory methods — one per workflow-causality class (ADR-0053). The method SIGNATURE is the
// enforcement layer (what SQL CHECK cannot express):
//   - appendReviewDispatch(runId, …)   — runId REQUIRED by signature; the type system refuses null.
//   - appendNonReviewDispatch(workflowType, …) — NO runId parameter (bootstrap sinks: sync_code_owners,
//     refresh_semantic_docs, …). A producer-drift WARN fires if a review workflowType is passed here.
//   - appendReconcile(…)               — NO runId / installationId (the installation_reconcile schema
//     exemption: ck_outbox_installation_id_required permits NULL installation_id only for that sink).
//
// Stateless — methods take the executor (a Kysely or a Transaction) so the INSERT joins the caller's
// transaction (the webhook persistence writes audit + idempotency + run-allocation + outbox atomically).

import { type Kysely, sql } from "kysely";

import { SystemRandom } from "#platform/randomness.js";

// ─── uuid4 minter (via the platform randomness seam — the clock/random gate bans raw crypto.randomUUID
//     outside the seam; mint v4 from tokenBytes(16), the sanctioned CSPRNG entry point). 1:1 shape with
//     the Python `uuid.uuid4()`. ───
const RANDOM = new SystemRandom();
function uuid4(): string {
  const b = Buffer.from(RANDOM.tokenBytes(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The `core.outbox.sink` values (Python `OutboxSink`). */
export const OUTBOX_SINK_TEMPORAL_WORKFLOW_START = "temporal_workflow_start";
export const OUTBOX_SINK_INSTALLATION_RECONCILE = "installation_reconcile";

/** Payload schema-version constants (Python contracts/outbox_row/v1.py). */
export const OUTBOX_PAYLOAD_SCHEMA_VERSION = 2;
export const RECONCILE_PAYLOAD_SCHEMA_VERSION = 1;

/** Review workflow types — dispatching one of these via {@link PostgresOutboxRepo.appendNonReviewDispatch}
 *  is producer drift. The TS review workflow type is `reviewPullRequest` (the registered Temporal type). */
export const REVIEW_WORKFLOW_TYPES: ReadonlySet<string> = new Set(["reviewPullRequest"]);

/** A Kysely instance or an open Transaction — the executor the raw `sql` INSERT runs on. */
type Executor = Kysely<unknown>;

export class PostgresOutboxRepo {
  /** Append a review-workflow dispatch row. `runId` is required by signature. */
  public async appendReviewDispatch(args: {
    db: Executor;
    runId: string;
    payload: unknown;
    schemaVersion: number;
    installationId: string;
    deliveryId?: string | null;
    traceContext?: unknown;
  }): Promise<void> {
    await this.#insert({
      db: args.db,
      sink: OUTBOX_SINK_TEMPORAL_WORKFLOW_START,
      payload: args.payload,
      schemaVersion: args.schemaVersion,
      runId: args.runId,
      installationId: args.installationId,
      deliveryId: args.deliveryId ?? null,
      traceContext: args.traceContext ?? null,
    });
  }

  /** Append a non-review (bootstrap-sink) dispatch row — NO runId. Fires a producer-drift WARN if a review
   *  workflow type is passed (the safety net for what SQL cannot constrain). */
  public async appendNonReviewDispatch(args: {
    db: Executor;
    workflowType: string;
    payload: unknown;
    schemaVersion: number;
    installationId: string;
    deliveryId?: string | null;
    traceContext?: unknown;
  }): Promise<void> {
    if (REVIEW_WORKFLOW_TYPES.has(args.workflowType)) {
      console.warn(
        JSON.stringify({ event: "outbox_producer_drift", workflow_type: args.workflowType }),
      );
    }
    await this.#insert({
      db: args.db,
      sink: OUTBOX_SINK_TEMPORAL_WORKFLOW_START,
      payload: args.payload,
      schemaVersion: args.schemaVersion,
      runId: null,
      installationId: args.installationId,
      deliveryId: args.deliveryId ?? null,
      traceContext: args.traceContext ?? null,
    });
  }

  /** Append an installation-reconcile row — NO runId / installationId (the sink's schema exemption). */
  public async appendReconcile(args: {
    db: Executor;
    payload: unknown;
    schemaVersion: number;
    deliveryId?: string | null;
    traceContext?: unknown;
  }): Promise<void> {
    await this.#insert({
      db: args.db,
      sink: OUTBOX_SINK_INSTALLATION_RECONCILE,
      payload: args.payload,
      schemaVersion: args.schemaVersion,
      runId: null,
      installationId: null,
      deliveryId: args.deliveryId ?? null,
      traceContext: args.traceContext ?? null,
    });
  }

  /** Single canonical INSERT — every column bound (Python `_insert`). `created_at` / `attempts` / `state`
   *  use the schema DEFAULTs (server clock / 0 / 'pending'). */
  async #insert(args: {
    db: Executor;
    sink: string;
    payload: unknown;
    schemaVersion: number;
    runId: string | null;
    installationId: string | null;
    deliveryId: string | null;
    traceContext: unknown;
  }): Promise<void> {
    const payloadJson = JSON.stringify(args.payload);
    const traceJson = args.traceContext !== null ? JSON.stringify(args.traceContext) : null;
    await sql`
      INSERT INTO core.outbox
        (id, sink, payload, schema_version, run_id, trace_context, delivery_id, installation_id)
      VALUES (
        ${uuid4()}, ${args.sink}, CAST(${payloadJson} AS JSONB),
        ${args.schemaVersion}, ${args.runId},
        CAST(${traceJson} AS JSONB), ${args.deliveryId}, ${args.installationId}
      )
    `.execute(args.db);
  }
}
