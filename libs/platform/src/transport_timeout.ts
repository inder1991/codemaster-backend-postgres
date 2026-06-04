// Transport-timeout seam.
//
// HTTP clients need a per-request timeout — but a raw `setTimeout` / `AbortSignal.timeout` scattered
// through transport code is exactly what the `check_clock_random` gate bans (it defeats deterministic
// replay the same way a raw `Date.now()` does). Per CLAUDE.md "Clock and Random Protocols", the
// sanctioned home for wall-clock timers is a seam: `WallClock.sleep` (clock.ts) for delays, and THIS
// file for HTTP abort-timeouts.
//
// The gate (scripts/gates/check_clock_random.ts) allow-lists exactly this file
// (`libs/platform/src/transport_timeout.ts`) for `setTimeout` / `AbortSignal.timeout`; every other
// production source file routes its transport timeout through `transportAbortSignal`. That makes the
// policy (clock.ts docstring), the implementation (the HTTP clients), and the gate agree — closing the
// "the gate claims to enforce no-setTimeout but doesn't scan for it" gap.
//
// This is a TRANSPORT concern (it runs in activity / main-thread code that talks to the network), NOT
// workflow code — the Temporal workflow sandbox separately forbids timers, enforced at bundle time.

/**
 * An `AbortSignal` that aborts after `timeoutMs` milliseconds — the single sanctioned way to arm an
 * HTTP transport timeout. Pass it as `fetch(url, { signal })`; the timer is owned by the signal and
 * cleans up with it (no `clearTimeout` bookkeeping). A fired timeout surfaces to the caller as the
 * fetch promise rejecting with an `AbortError`, which the HTTP clients map to their retryable
 * transport-error path.
 */
export function transportAbortSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}
