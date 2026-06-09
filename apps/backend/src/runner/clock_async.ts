import type { Clock } from "#platform/clock.js";
export function cancellableSleep(clock: Clock, seconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return Promise.race([
    clock.sleep(seconds),
    new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
  ]);
}
