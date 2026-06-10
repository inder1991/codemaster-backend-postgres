// Phase 4a W4a.1: the background-jobs permanent-failure signal — the platform analogue of the
// outbox's RetryableSinkError/PermanentSinkError split (apps/backend/src/outbox/sink_registry.ts).
//
// A handler throws PermanentJobError (optionally wrapping the underlying fault as `cause`) to tell
// the runner "retrying CANNOT succeed — dead-letter NOW" (auth/permission errors, contract
// violations, anything where the retry curve only burns attempts against a deterministic fault).
// The runner (background_runner.ts) classifies it at the settle seam: terminalSettle → 'dead' with
// dead_reason = the message, after ONE attempt — NOT the markFailed retry/backoff path.
//
// A bare ZodError propagating out of a handler's payload parse is classified permanent by the
// runner TOO (the stored bytes re-parse identically on every retry), so handlers that parse with
// `.parse(payload)` need no wrapping. Everything else is presumed transient and keeps the bounded
// markFailed retry/backoff curve.

/** A handler raised this — do NOT retry; the runner dead-letters the job immediately. */
export class PermanentJobError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentJobError";
  }
}
