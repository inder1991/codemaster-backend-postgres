import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { ReviewRunReaperResultV1 } from "#contracts/review_run_reaper_result.v1.js";

afterAll(() => shutdownRef());

// Contract parity for the RETURN contract of `review_run_reaper_activity` (frozen Python,
// codemaster/activities/review_run_reaper.py:41-46). `ConfigDict(extra="forbid")` → `.strict()`; the int
// fields carry NO `ge=` constraint. Round-trip the same payload through Pydantic (oracle) and Zod, diff
// canonical JSON; accept/reject must agree.
const PY = "codemaster.activities.review_run_reaper";

describe("ReviewRunReaperResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = { schema_version: 1, scanned: 5, reaped: 4 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewRunReaperResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ReviewRunReaperResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same default (schema_version=1) when omitted", async () => {
    const payload = { scanned: 0, reaped: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewRunReaperResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(ReviewRunReaperResultV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).schema_version).toBe(1);
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { scanned: 1, reaped: 1, bogus: 9 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewRunReaperResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewRunReaperResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (reaped)", async () => {
    const bad = { scanned: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewRunReaperResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewRunReaperResultV1.parse(bad)).toThrow();
  }, 30_000);
});
