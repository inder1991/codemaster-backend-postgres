import type { Clock } from "#platform/clock.js";

// Resolve on the timer OR on abort. The race guarantees abort-resolution for ANY clock (incl. test
// doubles that ignore the signal); passing the signal INTO clock.sleep additionally lets WallClock CLEAR
// its underlying setTimeout on abort (F2 / P2-2 — pre-fix the orphaned timer kept the event loop alive at
// shutdown). The abort listener is removed on settle so a long-lived loop signal never accumulates listeners.
export function cancellableSleep(clock: Clock, seconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([clock.sleep(seconds, signal), aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}
