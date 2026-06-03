import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { ClonedRepoV1 } from "../../libs/contracts/src/cloned_repo.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `ClonedRepoV1(**payload).model_dump(mode="json")`) and through
// Zod (`ClonedRepoV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
const PY = "contracts.cloned_repo.v1";

describe("ClonedRepoV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 2,
      workspace_path: "/tmp/codemaster/ws/abc",
      repo_path: "/tmp/codemaster/ws/abc/repo",
      head_sha: "0123456789abcdef0123456789abcdef01234567",
      byte_size: 1048576,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ClonedRepoV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ClonedRepoV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=2, repo_path=null) when omitted", async () => {
    const payload = {
      workspace_path: "/tmp/ws",
      head_sha: "abc1234",
      byte_size: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ClonedRepoV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ClonedRepoV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("treats an explicit null repo_path identically to the default", async () => {
    const payload = {
      workspace_path: "/tmp/ws",
      repo_path: null,
      head_sha: "abc1234567",
      byte_size: 42,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ClonedRepoV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ClonedRepoV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a too-short head_sha (min_length=7)", async () => {
    const bad = { workspace_path: "/tmp/ws", head_sha: "abc12", byte_size: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ClonedRepoV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => ClonedRepoV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty workspace_path (min_length=1)", async () => {
    const bad = { workspace_path: "", head_sha: "abc1234", byte_size: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ClonedRepoV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ClonedRepoV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a negative byte_size (ge=0)", async () => {
    const bad = { workspace_path: "/tmp/ws", head_sha: "abc1234", byte_size: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ClonedRepoV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ClonedRepoV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { workspace_path: "/tmp/ws", head_sha: "abc1234", byte_size: 0, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ClonedRepoV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ClonedRepoV1.parse(bad)).toThrow();
  }, 30_000);
});
