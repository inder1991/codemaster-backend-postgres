// Outbox sink registry — 1:1 with the registry portion of codemaster/activities/outbox.py.
//
// A sink is a named handler that delivers an outbox row's payload to its destination (e.g.
// `temporal_workflow_start` starts a workflow, `vault_credential_write` writes a secret). Sink modules
// register their handler at startup; the dispatcher looks them up by the row's `sink` column and invokes
// them. A module-level singleton registry (mirrors the Python module-global `_SINK_REGISTRY`).

/** Context the dispatcher threads to a sink handler alongside the row payload. */
export type SinkContext = {
  deliveryId: string | null;
  installationId: string | null;
  runId: string | null;
  /** W3.2 (RM2): the dispatching `core.outbox` row id — the canonical DESTINATION-SIDE idempotency
   *  key. The outbox is at-least-once by construction (a crash between a successful sink dispatch
   *  and `markDispatched` re-dispatches the SAME row after lease expiry), so every sink destination
   *  must be able to deduplicate on this key even after a prior execution SETTLED. See the
   *  at-least-once contract note on {@link SinkHandler}. */
  outboxRowId: string;
};

/** A sink handler: deliver `payload` to the sink's destination. Throw {@link RetryableSinkError} for a
 *  transient failure (the dispatcher retries) or {@link PermanentSinkError} to dead-letter immediately.
 *
 *  ## The at-least-once contract (W3.2 / RM2)
 *  A handler MAY be invoked more than once for the same outbox row (crash-between-dispatch-and-
 *  markDispatched redrive; an RM1 timeout whose abandoned dispatch later succeeded). Destinations
 *  must therefore be idempotent on the dispatch identity. Current posture per destination:
 *    * review route (`reviewPullRequest` → core.review_jobs): idempotent on run_id/delivery_id —
 *      the CS4.1 (H9/RT3) enqueue coalesces a redrive onto the existing job.
 *    * event route (workflow_type → core.background_jobs): coalesces on dedup_key=workflow_id ONLY
 *      while a holder is ACTIVE; a re-dispatch after the first job settled enqueues a second
 *      execution. {@link SinkContext.outboxRowId} is threaded to this boundary as the persistent
 *      key; consuming it inside the enqueue path (persistent uniqueness on the row id) is the
 *      W1.9e/W3.2 enqueue-path slice owned with the background-jobs platform.
 *    * Temporal route (RealTemporalClient): deterministic workflow ids + reuse/conflict policies
 *      coalesce by design. */
export type SinkHandler = (args: { payload: unknown; context: SinkContext }) => Promise<void>;

/** A handler is already registered for this sink name. */
export class SinkAlreadyRegisteredError extends Error {
  public constructor(name: string) {
    super(name);
    this.name = "SinkAlreadyRegisteredError";
  }
}

/** No handler is registered for this sink name. */
export class UnknownSinkError extends Error {
  public constructor(name: string) {
    super(name);
    this.name = "UnknownSinkError";
  }
}

/** A sink handler raised this — the dispatcher should RETRY the row. */
export class RetryableSinkError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RetryableSinkError";
  }
}

/** A sink handler raised this — the dispatcher should NOT retry; mark the row dead. */
export class PermanentSinkError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PermanentSinkError";
  }
}

const REGISTRY = new Map<string, SinkHandler>();

/** Register a sink handler (called at startup by sink modules). Throws if `name` is already registered. */
export function registerSink(name: string, handler: SinkHandler): void {
  if (REGISTRY.has(name)) {
    throw new SinkAlreadyRegisteredError(name);
  }
  REGISTRY.set(name, handler);
}

/** Look up a registered sink handler. Throws {@link UnknownSinkError} if none is registered for `name`. */
export function getSink(name: string): SinkHandler {
  const handler = REGISTRY.get(name);
  if (handler === undefined) {
    throw new UnknownSinkError(name);
  }
  return handler;
}

/** Test-only: clear the registry so each test starts fresh. */
export function resetRegistryForTesting(): void {
  REGISTRY.clear();
}

/** The currently-registered sink names, sorted. */
export function registeredSinks(): Array<string> {
  return [...REGISTRY.keys()].sort();
}
