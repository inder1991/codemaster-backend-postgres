import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { PRTopologyEntryV1 } from "../../libs/contracts/src/pr_topology.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `PRTopologyEntryV1(**payload).model_dump(mode="json")`) and through
// Zod (`PRTopologyEntryV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
// UUIDs are canonical-lowercase: Pydantic lowercases uuid.UUID on dump; Zod .uuid() does not normalize.
const PY = "contracts.pr_topology.v1";

// PRTopologyKind is a bare Literal (not a Pydantic model), so it is exercised through PRTopologyEntryV1.kind.

describe("PRTopologyEntryV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = {
      chunk_id: "1b671a64-40d5-491e-99b0-da01ff1f3341",
      path: "src/review/activities.py",
      start_line: 12,
      end_line: 48,
      kind: "code",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PRTopologyEntryV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PRTopologyEntryV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same kind default ('code') when omitted", async () => {
    const payload = {
      chunk_id: "9c5b94b1-35ad-49bb-b118-8e8fc24abf80",
      path: "docs/CLAUDE.md",
      start_line: 1,
      end_line: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PRTopologyEntryV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PRTopologyEntryV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts each non-default kind identically", async () => {
    for (const kind of ["doc", "config", "test", "other"]) {
      const payload = {
        chunk_id: "1b671a64-40d5-491e-99b0-da01ff1f3341",
        path: "p",
        start_line: 3,
        end_line: 7,
        kind,
      };
      const r = await pyRef({ pyModule: PY, pyCallable: "PRTopologyEntryV1", kwargs: payload });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(PRTopologyEntryV1.parse(payload))).toBe(r.out);
    }
  }, 30_000);

  it("both REJECT an out-of-range value (start_line < 1)", async () => {
    const bad = {
      chunk_id: "1b671a64-40d5-491e-99b0-da01ff1f3341",
      path: "p",
      start_line: 0,
      end_line: 5,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PRTopologyEntryV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => PRTopologyEntryV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a line-range violation (_check_line_range: end_line < start_line)", async () => {
    const bad = {
      chunk_id: "1b671a64-40d5-491e-99b0-da01ff1f3341",
      path: "p",
      start_line: 40,
      end_line: 12,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PRTopologyEntryV1", kwargs: bad });
    expect(r.ok).toBe(false); // model_validator raises ValueError → ValidationError
    expect(() => PRTopologyEntryV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown kind value (Literal ↔ z.enum)", async () => {
    const bad = {
      chunk_id: "1b671a64-40d5-491e-99b0-da01ff1f3341",
      path: "p",
      start_line: 1,
      end_line: 2,
      kind: "binary",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PRTopologyEntryV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PRTopologyEntryV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      chunk_id: "1b671a64-40d5-491e-99b0-da01ff1f3341",
      path: "p",
      start_line: 1,
      end_line: 2,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PRTopologyEntryV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PRTopologyEntryV1.parse(bad)).toThrow();
  }, 30_000);
});
