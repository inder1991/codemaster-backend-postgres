import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../../../test/parity/canonical.js";
import { pyRef, shutdownRef } from "../../../test/parity/oracle.js";
import { PolicyCitationContextV1 } from "./policy_citation.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `PolicyCitationContextV1(**payload).model_dump(mode="json")`) and
// through Zod (`PolicyCitationContextV1.parse(payload)`), then diff canonical JSON. Accept/reject
// must also agree. Follows the markdown_chunk.v1 template (Task 0.5).
const PY = "contracts.policy_citation.v1";

describe("PolicyCitationContextV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 1,
      valid_rule_ids: ["rule-a", "rule-b", "rule-c"],
      enforcement: "enforce",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PolicyCitationContextV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PolicyCitationContextV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (valid_rule_ids=[], enforcement='observe', schema_version=1) when omitted", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "PolicyCitationContextV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PolicyCitationContextV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("dumps an empty valid_rule_ids tuple identically", async () => {
    const payload = { valid_rule_ids: [], enforcement: "observe" };
    const r = await pyRef({ pyModule: PY, pyCallable: "PolicyCitationContextV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PolicyCitationContextV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an out-of-enum enforcement value", async () => {
    const bad = { enforcement: "drop" };
    const r = await pyRef({ pyModule: PY, pyCallable: "PolicyCitationContextV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError (not a Literal member)
    expect(() => PolicyCitationContextV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { enforcement: "observe", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PolicyCitationContextV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PolicyCitationContextV1.parse(bad)).toThrow();
  }, 30_000);
});
