import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { MutexJanitorResultV1 } from "#contracts/mutex_janitor_result.v1.js";

afterAll(() => shutdownRef());

// Contract parity for the RETURN contract of `mutex_janitor_activity` (frozen Python,
// codemaster/activities/mutex_janitor.py:32-37). `ConfigDict(extra="forbid")` → `.strict()`; the int
// fields carry NO `ge=` constraint, so a negative value is ACCEPTED by both (the activity never emits
// one — counts are loop-incremented from 0). Round-trip the same payload through Pydantic (oracle) and
// Zod, diff canonical JSON; accept/reject must agree.
const PY = "codemaster.activities.mutex_janitor";

describe("MutexJanitorResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = { schema_version: 1, scanned: 3, swept: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: "MutexJanitorResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(MutexJanitorResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same default (schema_version=1) when omitted", async () => {
    const payload = { scanned: 0, swept: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "MutexJanitorResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(MutexJanitorResultV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).schema_version).toBe(1);
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { scanned: 1, swept: 1, bogus: 9 };
    const r = await pyRef({ pyModule: PY, pyCallable: "MutexJanitorResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => MutexJanitorResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (scanned)", async () => {
    const bad = { swept: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "MutexJanitorResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => MutexJanitorResultV1.parse(bad)).toThrow();
  }, 30_000);
});
