import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { WorkspaceHandle } from "#contracts/workspace_handle.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the frozen
// WorkspaceHandle via the oracle — `WorkspaceHandle(**payload).model_dump(mode="json")`) and through
// Zod (`WorkspaceHandle.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
const PY = "codemaster.workspace._handle";

const VALID = {
  workspace_id: "11111111-1111-1111-1111-111111111111",
  installation_id: "22222222-2222-2222-2222-222222222222",
  run_id: "33333333-3333-3333-3333-333333333333",
  derived_path: "/tmp/codemaster/ws/abc",
  state: "allocated",
};

describe("WorkspaceHandle parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceHandle", kwargs: VALID });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(WorkspaceHandle.parse(VALID))).toBe(r.out);
  }, 30_000);

  it("normalizes an uppercase UUID to lowercase identically", async () => {
    const payload = { ...VALID, workspace_id: "AAAAAAAA-1111-1111-1111-111111111111" };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceHandle", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(WorkspaceHandle.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a missing required field (state)", async () => {
    const bad = {
      workspace_id: VALID.workspace_id,
      installation_id: VALID.installation_id,
      run_id: VALID.run_id,
      derived_path: VALID.derived_path,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceHandle", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WorkspaceHandle.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-UUID workspace_id", async () => {
    const bad = { ...VALID, workspace_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceHandle", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WorkspaceHandle.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...VALID, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceHandle", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WorkspaceHandle.parse(bad)).toThrow();
  }, 30_000);
});
