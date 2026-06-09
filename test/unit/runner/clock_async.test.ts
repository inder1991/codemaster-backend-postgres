import { describe, expect, it } from "vitest";
import { WallClock } from "#platform/clock.js";
import { cancellableSleep } from "#backend/runner/clock_async.js";
describe("cancellableSleep", () => {
  it("resolves immediately when the signal aborts", async () => {
    const ac = new AbortController(); const t = Date.now();
    const p = cancellableSleep(new WallClock(), 10, ac.signal); // 10s sleep, but...
    ac.abort();                                                 // ...aborted now
    await p; expect(Date.now() - t).toBeLessThan(500);
  });
});
