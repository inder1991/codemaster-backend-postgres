import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { CloneRepoIntoWorkspaceInput } from "#contracts/clone_repo_into_workspace_input.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the frozen
// CloneRepoIntoWorkspaceInput via the oracle) and through Zod, then diff canonical JSON. The nested
// WorkspaceHandle is supplied inline; its parity is also pinned by workspace_handle.v1.parity.test.ts.
//
// PER-REVIEW ROUTING DIVERGENCE (ADR — remove the CODEMASTER_GITHUB_INSTALLATION_ID env pin): the TS
// contract carries a NULLABLE numeric `github_installation_id` the frozen Python model does NOT (the clone
// is dispatched unconditionally on the spine; the activity fail-closes on a null id). The omitted-field
// payloads below default it to null in Zod; `stripGhId` removes it from the Zod canonical JSON before the
// diff so every SHARED field stays byte-identical to Python. A dedicated test pins that a provided id
// round-trips.
const PY = "codemaster.activities._workspace_clone";

const HANDLE = {
  workspace_id: "11111111-1111-1111-1111-111111111111",
  installation_id: "22222222-2222-2222-2222-222222222222",
  run_id: "33333333-3333-3333-3333-333333333333",
  derived_path: "/tmp/codemaster/ws/abc",
  state: "allocated",
};

// Drop the TS-only github_installation_id from a Zod canonical string (the oracle never had the field).
function stripGhId(canon: string): string {
  const o = JSON.parse(canon) as Record<string, unknown>;
  delete o.github_installation_id;
  return canonicalize(o);
}

describe("CloneRepoIntoWorkspaceInput parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically (shared fields)", async () => {
    const payload = {
      schema_version: 1,
      handle: HANDLE,
      repo_url: "https://github.com/acme/widget.git",
      head_sha: "abc1234deadbeef0000000000000000000000000",
      changed_paths: ["src/a.ts", "src/b.ts"],
      pr_number: 42,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CloneRepoIntoWorkspaceInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(stripGhId(canonicalize(CloneRepoIntoWorkspaceInput.parse(payload)))).toBe(r.out);
  }, 30_000);

  it("defaults github_installation_id to null when omitted; a provided id round-trips (per-review routing ADR)", () => {
    const base = {
      handle: HANDLE,
      repo_url: "https://github.com/acme/widget.git",
      head_sha: "abc1234567",
      changed_paths: [],
    };
    expect(CloneRepoIntoWorkspaceInput.parse(base).github_installation_id).toBe(null);
    expect(CloneRepoIntoWorkspaceInput.parse({ ...base, github_installation_id: 4815162342 }).github_installation_id).toBe(
      4815162342,
    );
  });

  it("applies the same defaults (schema_version=1, pr_number=null) when omitted", async () => {
    const payload = {
      handle: HANDLE,
      repo_url: "https://github.com/acme/widget.git",
      head_sha: "abc1234567",
      changed_paths: [],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CloneRepoIntoWorkspaceInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(stripGhId(canonicalize(CloneRepoIntoWorkspaceInput.parse(payload)))).toBe(r.out);
  }, 30_000);

  it("treats an explicit null pr_number identically to the default", async () => {
    const payload = {
      handle: HANDLE,
      repo_url: "https://github.com/acme/widget.git",
      head_sha: "abc1234567",
      changed_paths: ["a"],
      pr_number: null,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CloneRepoIntoWorkspaceInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(stripGhId(canonicalize(CloneRepoIntoWorkspaceInput.parse(payload)))).toBe(r.out);
  }, 30_000);

  it("both REJECT schema_version != 1 (Literal[1])", async () => {
    const bad = {
      schema_version: 2,
      handle: HANDLE,
      repo_url: "https://github.com/acme/widget.git",
      head_sha: "abc1234567",
      changed_paths: [],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CloneRepoIntoWorkspaceInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CloneRepoIntoWorkspaceInput.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed nested handle (handle.state missing)", async () => {
    const { workspace_id, installation_id, run_id, derived_path } = HANDLE;
    const handleNoState = { workspace_id, installation_id, run_id, derived_path };
    const bad = {
      handle: handleNoState,
      repo_url: "https://github.com/acme/widget.git",
      head_sha: "abc1234567",
      changed_paths: [],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CloneRepoIntoWorkspaceInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CloneRepoIntoWorkspaceInput.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      handle: HANDLE,
      repo_url: "https://github.com/acme/widget.git",
      head_sha: "abc1234567",
      changed_paths: [],
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CloneRepoIntoWorkspaceInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CloneRepoIntoWorkspaceInput.parse(bad)).toThrow();
  }, 30_000);
});
