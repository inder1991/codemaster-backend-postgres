import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `ArbitrationIntentV1(**payload).model_dump(mode="json")`) and
// through Zod (`ArbitrationIntentV1.parse(payload)`), then diff canonical JSON. Accept/reject agree.
// confidence is carried as a CANONICAL decimal STRING (Pydantic Decimal → JSON string), so a
// well-formed string round-trips byte-for-byte through both sides.
const PY = "contracts.arbitration_intent.v1";
const UUID = "12345678-1234-5678-1234-567812345678";

describe("ArbitrationIntentV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 1,
      target_finding_id: UUID,
      action: "SUPPRESS",
      confidence: "0.5",
      reason: "looks like a false positive",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationIntentV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ArbitrationIntentV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version/action defaults when omitted", async () => {
    const payload = { target_finding_id: UUID, confidence: "1", reason: "x" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationIntentV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ArbitrationIntentV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("preserves trailing zeros in the confidence decimal string", async () => {
    const payload = { target_finding_id: UUID, confidence: "0.250", reason: "borderline" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationIntentV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ArbitrationIntentV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("normalizes an uppercase UUID to lowercase identically (both sides)", async () => {
    const payload = { target_finding_id: UUID.toUpperCase(), confidence: "0", reason: "x" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationIntentV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ArbitrationIntentV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT confidence out of [0, 1] range (1.5)", async () => {
    const bad = { target_finding_id: UUID, confidence: "1.5", reason: "x" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationIntentV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => ArbitrationIntentV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT confidence with >3 decimal places (0.1234)", async () => {
    const bad = { target_finding_id: UUID, confidence: "0.1234", reason: "x" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationIntentV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ArbitrationIntentV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty reason (min_length=1)", async () => {
    const bad = { target_finding_id: UUID, confidence: "0.5", reason: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationIntentV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ArbitrationIntentV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-UUID target_finding_id", async () => {
    const bad = { target_finding_id: "not-a-uuid", confidence: "0.5", reason: "x" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationIntentV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ArbitrationIntentV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { target_finding_id: UUID, confidence: "0.5", reason: "x", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationIntentV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ArbitrationIntentV1.parse(bad)).toThrow();
  }, 30_000);
});
