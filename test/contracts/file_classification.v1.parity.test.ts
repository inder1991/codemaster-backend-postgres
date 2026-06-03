import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { FileClassificationV1 } from "#contracts/file_classification.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `FileClassificationV1(**payload).model_dump(mode="json")`) and
// through Zod (`FileClassificationV1.parse(payload)`), then diff canonical JSON. Accept/reject must
// also agree. Follows the markdown_chunk.v1 template (Task 0.5).
const PY = "contracts.file_classification.v1";

describe("FileClassificationV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 1,
      path: "src/app/main.py",
      byte_size: 4096,
      magika_label: "python",
      language: "python",
      is_binary: false,
      is_generated: false,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileClassificationV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FileClassificationV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=1, language=null) when omitted", async () => {
    const payload = {
      path: "vendor/lib.bin",
      byte_size: 0,
      magika_label: "binary",
      is_binary: true,
      is_generated: true,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileClassificationV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FileClassificationV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("dumps an explicit null language identically", async () => {
    const payload = {
      path: "data/blob",
      byte_size: 12,
      magika_label: "json",
      language: null,
      is_binary: false,
      is_generated: false,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileClassificationV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FileClassificationV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an out-of-range value (byte_size < 0)", async () => {
    const bad = {
      path: "a.py",
      byte_size: -1,
      magika_label: "python",
      is_binary: false,
      is_generated: false,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileClassificationV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => FileClassificationV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty path (min_length=1)", async () => {
    const bad = {
      path: "",
      byte_size: 10,
      magika_label: "python",
      is_binary: false,
      is_generated: false,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileClassificationV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FileClassificationV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      path: "a.py",
      byte_size: 10,
      magika_label: "python",
      is_binary: false,
      is_generated: false,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileClassificationV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FileClassificationV1.parse(bad)).toThrow();
  }, 30_000);
});
