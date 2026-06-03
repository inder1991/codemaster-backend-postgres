import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { PrFileV1 } from "#contracts/pr_file.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `PrFileV1(**payload).model_dump(mode="json")`) and through
// Zod (`PrFileV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
const PY = "contracts.pr_file.v1";

describe("PrFileV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = {
      schema_version: 1,
      pr_file_id: "11111111-1111-1111-1111-111111111111",
      pr_id: "22222222-2222-2222-2222-222222222222",
      installation_id: "33333333-3333-3333-3333-333333333333",
      repository_id: "44444444-4444-4444-4444-444444444444",
      file_path: "src/server/handler.py",
      status: "renamed",
      additions: 42,
      deletions: 7,
      previous_path: "src/server/old_handler.py",
      language: "Python",
      // created_at left null: a non-null datetime can't be asserted for canonical-string equality
      // because the Python ref's _canonical emits Pydantic's raw "…Z" while the TS-side canonicalize()
      // normalizes "…Z" → "…000000+00:00" (canonical.ts review-item-g). Both PARSE it fine (covered by
      // the contract + the dedicated accept test below); only the equality diff is harness-asymmetric.
      created_at: null,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFileV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PrFileV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version/previous_path/language/created_at) when omitted", async () => {
    const payload = {
      pr_file_id: "11111111-1111-1111-1111-111111111111",
      pr_id: "22222222-2222-2222-2222-222222222222",
      installation_id: "33333333-3333-3333-3333-333333333333",
      repository_id: "44444444-4444-4444-4444-444444444444",
      file_path: "README.md",
      status: "added",
      additions: 0,
      deletions: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFileV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PrFileV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("validates + dumps a removed-file payload identically", async () => {
    const payload = {
      pr_file_id: "55555555-5555-5555-5555-555555555555",
      pr_id: "66666666-6666-6666-6666-666666666666",
      installation_id: "77777777-7777-7777-7777-777777777777",
      repository_id: "88888888-8888-8888-8888-888888888888",
      file_path: "obsolete/legacy.go",
      status: "removed",
      additions: 0,
      deletions: 500,
      language: "Go",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFileV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PrFileV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both ACCEPT a non-null created_at (datetime field; equality-diff is harness-asymmetric)", async () => {
    const payload = {
      pr_file_id: "11111111-1111-1111-1111-111111111111",
      pr_id: "22222222-2222-2222-2222-222222222222",
      installation_id: "33333333-3333-3333-3333-333333333333",
      repository_id: "44444444-4444-4444-4444-444444444444",
      file_path: "src/a.py",
      status: "modified",
      additions: 1,
      deletions: 1,
      created_at: "2026-06-03T10:00:00Z",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFileV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true); // Pydantic accepts the ISO datetime
    expect(() => PrFileV1.parse(payload)).not.toThrow(); // Zod accepts it too
  }, 30_000);

  it("both REJECT an out-of-range value (additions < 0)", async () => {
    const bad = {
      pr_file_id: "11111111-1111-1111-1111-111111111111",
      pr_id: "22222222-2222-2222-2222-222222222222",
      installation_id: "33333333-3333-3333-3333-333333333333",
      repository_id: "44444444-4444-4444-4444-444444444444",
      file_path: "src/a.py",
      status: "modified",
      additions: -1,
      deletions: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFileV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => PrFileV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown status (Literal ↔ z.enum)", async () => {
    const bad = {
      pr_file_id: "11111111-1111-1111-1111-111111111111",
      pr_id: "22222222-2222-2222-2222-222222222222",
      installation_id: "33333333-3333-3333-3333-333333333333",
      repository_id: "44444444-4444-4444-4444-444444444444",
      file_path: "src/a.py",
      status: "exploded",
      additions: 0,
      deletions: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFileV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PrFileV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      pr_file_id: "11111111-1111-1111-1111-111111111111",
      pr_id: "22222222-2222-2222-2222-222222222222",
      installation_id: "33333333-3333-3333-3333-333333333333",
      repository_id: "44444444-4444-4444-4444-444444444444",
      file_path: "src/a.py",
      status: "added",
      additions: 0,
      deletions: 0,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFileV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PrFileV1.parse(bad)).toThrow();
  }, 30_000);
});
