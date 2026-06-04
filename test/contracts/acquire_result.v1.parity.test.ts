import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { AcquireResultV1 } from "#contracts/acquire_result.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// `AcquireResult` class — which lives inside the frozen `codemaster.concurrency.pr_mutex` module,
// NOT a contracts/ package — via the oracle as `AcquireResult(**payload).model_dump(mode="json")`)
// and through Zod (`AcquireResultV1.parse(payload)`), then diff canonical JSON. Accept / reject must
// also agree. Follows the posted_review.v1.parity / markdown_chunk.v1.parity template.
const PY = "codemaster.concurrency.pr_mutex";
const CALLABLE = "AcquireResult";

describe("AcquireResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps an acquired=true payload (mutex_id present) identically", async () => {
    const payload = {
      schema_version: 1,
      acquired: true,
      mutex_id: "33333333-3333-3333-3333-333333333333",
      holder_workflow_id: "wf-review-7",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(AcquireResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("validates + dumps an acquired=false payload (prior holder, no mutex_id) identically", async () => {
    const payload = {
      acquired: false,
      holder_workflow_id: "wf-prior-holder",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(AcquireResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults when optional fields are omitted (only acquired required)", async () => {
    // mutex_id, holder_workflow_id default to None/null and schema_version defaults to 1 on both
    // sides. acquired is the one required field.
    const payload = { acquired: false };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(AcquireResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts a future schema_version (int default, NOT a literal) identically", async () => {
    const payload = { schema_version: 2, acquired: true };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(AcquireResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("rejects an unknown extra field on BOTH sides (extra='forbid' ↔ .strict())", async () => {
    const payload = { acquired: true, bogus_field: "x" };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: payload });
    // Pydantic extra="forbid" raises → oracle reports ok=false; Zod .strict() throws too.
    expect(r.ok).toBe(false);
    expect(() => AcquireResultV1.parse(payload)).toThrow();
  }, 30_000);
});
