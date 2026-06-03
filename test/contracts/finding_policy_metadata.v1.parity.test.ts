import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { FindingPolicyMetadataV1 } from "#contracts/finding_policy_metadata.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `FindingPolicyMetadataV1(**payload).model_dump(mode="json")`) and
// through Zod (`FindingPolicyMetadataV1.parse(payload)`), then diff canonical JSON. Accept/reject
// must also agree. Follows the markdown_chunk.v1 template (Task 0.5).
const PY = "contracts.finding_policy_metadata.v1";

describe("FindingPolicyMetadataV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = {
      schema_version: 1,
      invariant_violation_attempted: true,
      invariants_fired: ["no-approve-event", "advisory-only"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FindingPolicyMetadataV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FindingPolicyMetadataV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = { invariant_violation_attempted: false, invariants_fired: [] };
    const r = await pyRef({ pyModule: PY, pyCallable: "FindingPolicyMetadataV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FindingPolicyMetadataV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("round-trips an empty invariants_fired tuple identically", async () => {
    const payload = {
      schema_version: 1,
      invariant_violation_attempted: true,
      invariants_fired: [],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FindingPolicyMetadataV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FindingPolicyMetadataV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a wrong-typed value (invariant_violation_attempted given a list)", async () => {
    // NB: Pydantic v2 lax-mode bool COERCES bool-like strings ("yes"/"no"/"1"/"0"…), so a string is
    // NOT a clean cross-side rejection. A list is uncoercible to bool on both sides.
    const bad = {
      invariant_violation_attempted: ["nope"],
      invariants_fired: ["x"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FindingPolicyMetadataV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => FindingPolicyMetadataV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-string element in invariants_fired", async () => {
    const bad = {
      invariant_violation_attempted: true,
      invariants_fired: [123],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FindingPolicyMetadataV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FindingPolicyMetadataV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (invariants_fired omitted)", async () => {
    const bad = { invariant_violation_attempted: true };
    const r = await pyRef({ pyModule: PY, pyCallable: "FindingPolicyMetadataV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FindingPolicyMetadataV1.parse(bad)).toThrow();
  }, 30_000);

  it("both ACCEPT a non-default schema_version (plain int field, not Literal[1])", async () => {
    // The Python field is `schema_version: int = 1` (plain int with a default), so Pydantic accepts
    // any int — the Zod port mirrors with z.number().int().default(1). A non-1 int must round-trip
    // on both sides, NOT reject.
    const payload = {
      schema_version: 2,
      invariant_violation_attempted: true,
      invariants_fired: [],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FindingPolicyMetadataV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FindingPolicyMetadataV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      invariant_violation_attempted: true,
      invariants_fired: [],
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FindingPolicyMetadataV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FindingPolicyMetadataV1.parse(bad)).toThrow();
  }, 30_000);
});
