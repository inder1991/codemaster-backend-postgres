import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  HunkRange,
  PrFilesEnrichmentResultV1,
} from "../../libs/contracts/src/pr_files_enrichment.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `PrFilesEnrichmentResultV1(**payload).model_dump(mode="json")`)
// and through Zod (`PrFilesEnrichmentResultV1.parse(payload)`), then diff canonical JSON.
// Accept/reject must also agree.
const PY = "contracts.pr_files_enrichment.v1";

// A valid PrFileV1 payload (Pydantic lowercases UUIDs on dump — use lowercase UUIDs).
const FILE_A = {
  schema_version: 1,
  pr_file_id: "11111111-1111-4111-8111-111111111111",
  pr_id: "22222222-2222-4222-8222-222222222222",
  installation_id: "33333333-3333-4333-8333-333333333333",
  repository_id: "44444444-4444-4444-8444-444444444444",
  file_path: "src/a.py",
  status: "modified",
  additions: 5,
  deletions: 2,
  previous_path: null,
  language: "Python",
  created_at: "2026-06-03T10:00:00+00:00",
};

describe("PrFilesEnrichmentResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (files + nested PrFileV1 + ranges + truncated_at)", async () => {
    const payload = {
      files: [FILE_A],
      changed_line_ranges: { "src/a.py": [[1, 10], [20, 25]], "src/b.ts": [[3, 3]] },
      truncated_at: 50,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFilesEnrichmentResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PrFilesEnrichmentResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = {
      files: [],
      changed_line_ranges: {},
      truncated_at: null,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFilesEnrichmentResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PrFilesEnrichmentResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("round-trips truncated_at=null with a non-empty range map identically", async () => {
    const payload = {
      files: [FILE_A],
      changed_line_ranges: { "src/a.py": [[7, 7]] },
      truncated_at: null,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFilesEnrichmentResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PrFilesEnrichmentResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a HunkRange that is not a 2-tuple (length 3)", async () => {
    const bad = {
      files: [],
      changed_line_ranges: { x: [[1, 2, 3]] },
      truncated_at: null,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFilesEnrichmentResultV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => PrFilesEnrichmentResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (truncated_at omitted)", async () => {
    const bad = { files: [], changed_line_ranges: {} };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFilesEnrichmentResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PrFilesEnrichmentResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { files: [], changed_line_ranges: {}, truncated_at: null, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFilesEnrichmentResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PrFilesEnrichmentResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a nested PrFileV1 with an out-of-range value (additions < 0)", async () => {
    const bad = {
      files: [{ ...FILE_A, additions: -1 }],
      changed_line_ranges: {},
      truncated_at: null,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PrFilesEnrichmentResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PrFilesEnrichmentResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("exposes the HunkRange tuple alias (parses a valid 2-int pair)", () => {
    expect(HunkRange.parse([1, 10])).toEqual([1, 10]);
    expect(() => HunkRange.parse([1])).toThrow();
    expect(() => HunkRange.parse([1, 2, 3])).toThrow();
  });
});
