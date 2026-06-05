import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { AllocateWorkspaceInput } from "#contracts/allocate_workspace_input.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the frozen
// AllocateWorkspaceInput via the oracle — `AllocateWorkspaceInput(**payload).model_dump(mode="json")`)
// and through Zod (`AllocateWorkspaceInput.parse(payload)`), then diff canonical JSON. Accept/reject
// must also agree.
const PY = "codemaster.activities._workspace_allocate";

const VALID = {
  schema_version: 1,
  run_id: "11111111-1111-1111-1111-111111111111",
  review_id: "22222222-2222-2222-2222-222222222222",
  installation_id: "33333333-3333-3333-3333-333333333333",
  repo_id: 4242,
  workflow_id: "review-pr-acme-widget-42",
};

describe("AllocateWorkspaceInput parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "AllocateWorkspaceInput", kwargs: VALID });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(AllocateWorkspaceInput.parse(VALID))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=1, repo_id=null) when omitted", async () => {
    const payload = {
      run_id: VALID.run_id,
      review_id: VALID.review_id,
      installation_id: VALID.installation_id,
      workflow_id: VALID.workflow_id,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AllocateWorkspaceInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(AllocateWorkspaceInput.parse(payload))).toBe(r.out);
  }, 30_000);

  it("treats an explicit null repo_id identically to the default", async () => {
    const payload = { ...VALID, repo_id: null };
    const r = await pyRef({ pyModule: PY, pyCallable: "AllocateWorkspaceInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(AllocateWorkspaceInput.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT schema_version != 1 (Literal[1])", async () => {
    const bad = { ...VALID, schema_version: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: "AllocateWorkspaceInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AllocateWorkspaceInput.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-UUID run_id", async () => {
    const bad = { ...VALID, run_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY, pyCallable: "AllocateWorkspaceInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AllocateWorkspaceInput.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (workflow_id)", async () => {
    const bad = {
      run_id: VALID.run_id,
      review_id: VALID.review_id,
      installation_id: VALID.installation_id,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AllocateWorkspaceInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AllocateWorkspaceInput.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...VALID, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "AllocateWorkspaceInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AllocateWorkspaceInput.parse(bad)).toThrow();
  }, 30_000);
});
