import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../../../test/parity/canonical.js";
import { pyRef, shutdownRef } from "../../../test/parity/oracle.js";
import { computeChunkId, DiffChunkV1 } from "./diff_chunking.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `DiffChunkV1(**payload).model_dump(mode="json")`) and through
// Zod (`DiffChunkV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
// Follows the markdown_chunk.v1 template (Task 0.5).
const PY = "contracts.diff_chunking.v1";

// A real chunk_id minted by the TS port of compute_chunk_id (lowercase, hyphenated) — the same
// shape every constructor must mint. (Pydantic normalizes UUID case to lowercase; Zod passes input
// through, so parity payloads MUST already be lowercase. computeChunkId emits lowercase.)
const CHUNK_ID = computeChunkId({ path: "a/b.py", start_line: 1, end_line: 10, body: "def f():\n    pass\n" });

describe("DiffChunkV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 1,
      chunk_id: CHUNK_ID,
      path: "a/b.py",
      language: "python",
      start_line: 1,
      end_line: 10,
      body: "def f():\n    pass\n",
      chunk_kind: "function",
      token_estimate: 12,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiffChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DiffChunkV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=1, language=null) when omitted", async () => {
    const payload = {
      chunk_id: CHUNK_ID,
      path: "a.py",
      start_line: 1,
      end_line: 2,
      body: "x",
      chunk_kind: "hunk",
      token_estimate: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiffChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DiffChunkV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts the line-range boundary (end_line == start_line)", async () => {
    const payload = {
      chunk_id: CHUNK_ID,
      path: "a.py",
      language: null,
      start_line: 5,
      end_line: 5,
      body: "y",
      chunk_kind: "module",
      token_estimate: 3,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiffChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DiffChunkV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("preserves a non-default schema_version (plain int, not Literal — re-emitted)", async () => {
    const payload = {
      schema_version: 2,
      chunk_id: CHUNK_ID,
      path: "a.py",
      start_line: 1,
      end_line: 2,
      body: "x",
      chunk_kind: "batch",
      token_estimate: 7,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiffChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DiffChunkV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT the model_validator violation (end_line < start_line)", async () => {
    const bad = {
      chunk_id: CHUNK_ID,
      path: "a.py",
      start_line: 5,
      end_line: 2,
      body: "x",
      chunk_kind: "module",
      token_estimate: 3,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiffChunkV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError (_check_line_range)
    expect(() => DiffChunkV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-range value (start_line < 1)", async () => {
    const bad = {
      chunk_id: CHUNK_ID,
      path: "a.py",
      start_line: 0,
      end_line: 1,
      body: "x",
      chunk_kind: "hunk",
      token_estimate: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiffChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DiffChunkV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-enum chunk_kind", async () => {
    const bad = {
      chunk_id: CHUNK_ID,
      path: "a.py",
      start_line: 1,
      end_line: 2,
      body: "x",
      chunk_kind: "bogus",
      token_estimate: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiffChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DiffChunkV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      chunk_id: CHUNK_ID,
      path: "a.py",
      start_line: 1,
      end_line: 2,
      body: "x",
      chunk_kind: "hunk",
      token_estimate: 0,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiffChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DiffChunkV1.parse(bad)).toThrow();
  }, 30_000);
});

// compute_chunk_id parity. The frozen helper returns a bare uuid.UUID, which the parity oracle's
// canonicalizer cannot serialize (it only special-cases Decimal) — so we cannot pyRef the helper
// directly. Instead we prove value-parity end-to-end through DiffChunkV1: the TS-minted chunk_id is
// fed into DiffChunkV1 on BOTH sides and must round-trip identically (proves wire-acceptance +
// canonical-form parity). The deterministic UUIDv5 byte-value is additionally pinned against the
// frozen Python helper's verified output below.
describe("computeChunkId parity (deterministic UUIDv5)", () => {
  it("matches the frozen Python uuid.uuid5 derivation", () => {
    // Verified equal to vendor/codemaster-py compute_chunk_id(path='a/b.py', start_line=1,
    // end_line=10, body='def f():\\n    pass\\n') run under the frozen submodule venv.
    expect(computeChunkId({ path: "a/b.py", start_line: 1, end_line: 10, body: "def f():\n    pass\n" })).toBe(
      "b236513f-0da7-57a0-aeb3-3f5ab0e92a3f",
    );
  });

  it("is replay-stable (same inputs → same id)", () => {
    const a = computeChunkId({ path: "x.py", start_line: 2, end_line: 9, body: "hello" });
    const b = computeChunkId({ path: "x.py", start_line: 2, end_line: 9, body: "hello" });
    expect(a).toBe(b);
  });

  it("the minted id round-trips through DiffChunkV1 on both sides", async () => {
    const cid = computeChunkId({ path: "src/m.py", start_line: 3, end_line: 8, body: "body-here" });
    const payload = {
      chunk_id: cid,
      path: "src/m.py",
      start_line: 3,
      end_line: 8,
      body: "body-here",
      chunk_kind: "class",
      token_estimate: 4,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiffChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DiffChunkV1.parse(payload))).toBe(r.out);
  }, 30_000);
});
