import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { ReleaseWorkspaceInput } from "#contracts/release_workspace_input.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the frozen
// ReleaseWorkspaceInput via the oracle) and through Zod, then diff canonical JSON. Accept/reject must
// also agree.
const PY = "codemaster.activities._workspace_release";

const VALID = {
  schema_version: 1,
  workspace_id: "11111111-1111-1111-1111-111111111111",
};

describe("ReleaseWorkspaceInput parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "ReleaseWorkspaceInput", kwargs: VALID });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ReleaseWorkspaceInput.parse(VALID))).toBe(r.out);
  }, 30_000);

  it("applies the same default (schema_version=1) when omitted", async () => {
    const payload = { workspace_id: VALID.workspace_id };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReleaseWorkspaceInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ReleaseWorkspaceInput.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT schema_version != 1 (Literal[1])", async () => {
    const bad = { ...VALID, schema_version: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReleaseWorkspaceInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReleaseWorkspaceInput.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-UUID workspace_id", async () => {
    const bad = { ...VALID, workspace_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReleaseWorkspaceInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReleaseWorkspaceInput.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (workspace_id)", async () => {
    const bad = { schema_version: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReleaseWorkspaceInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReleaseWorkspaceInput.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...VALID, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReleaseWorkspaceInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReleaseWorkspaceInput.parse(bad)).toThrow();
  }, 30_000);
});
