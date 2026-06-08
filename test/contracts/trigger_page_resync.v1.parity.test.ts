import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  TriggerPageResyncInputV1,
  TriggerPageResyncOutputV1,
} from "#contracts/trigger_page_resync.v1.js";

afterAll(() => shutdownRef());

// Contract parity for the single-page resync workflow I/O (frozen Python
// contracts/workflows/trigger_page_resync/v1.py). ConfigDict(extra="forbid", frozen=True) -> .strict().
// triggered_by_user_id: uuid.UUID | None = None -> optional + nullable, defaulting to null (present in dump).
const PY = "contracts.workflows.trigger_page_resync.v1";
const UUID_A = "12345678-1234-1234-1234-1234567890ab";

describe("TriggerPageResyncInputV1 parity (Pydantic <-> Zod)", () => {
  it("defaults triggered_by_user_id=null when omitted", async () => {
    const payload = { space_key: "ENG", page_id: "123" };
    const r = await pyRef({ pyModule: PY, pyCallable: "TriggerPageResyncInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(TriggerPageResyncInputV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).triggered_by_user_id).toBeNull();
  }, 30_000);

  it("carries a provided triggered_by_user_id", async () => {
    const payload = { space_key: "ENG", page_id: "123", triggered_by_user_id: UUID_A };
    const r = await pyRef({ pyModule: PY, pyCallable: "TriggerPageResyncInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(TriggerPageResyncInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an empty space_key (min_length=1)", async () => {
    const bad = { space_key: "", page_id: "123" };
    const r = await pyRef({ pyModule: PY, pyCallable: "TriggerPageResyncInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => TriggerPageResyncInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a page_id over 64 chars (max_length=64)", async () => {
    const bad = { space_key: "ENG", page_id: "x".repeat(65) };
    const r = await pyRef({ pyModule: PY, pyCallable: "TriggerPageResyncInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => TriggerPageResyncInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("TriggerPageResyncOutputV1 parity (Pydantic <-> Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = { space_key: "ENG", page_id: "123", resync_complete: true };
    const r = await pyRef({ pyModule: PY, pyCallable: "TriggerPageResyncOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(TriggerPageResyncOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a missing resync_complete", async () => {
    const bad = { space_key: "ENG", page_id: "123" };
    const r = await pyRef({ pyModule: PY, pyCallable: "TriggerPageResyncOutputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => TriggerPageResyncOutputV1.parse(bad)).toThrow();
  }, 30_000);
});
