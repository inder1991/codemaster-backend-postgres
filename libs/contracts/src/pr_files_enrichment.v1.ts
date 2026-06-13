import { z } from "zod";

import { PrFileV1 } from "./pr_file.v1.js";

// Zod port of contracts/pr_files_enrichment/v1.py::PrFilesEnrichmentResultV1.
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in pr_files_enrichment.v1.parity.test.ts.
//
// Source models / aliases ported (every public one):
//  - PrFilesEnrichmentResultV1 (ConfigDict extra=forbid, frozen) → .strict()
//  - HunkRange = tuple[int, int]  (alias from codemaster.chunking.chunker_port; inclusive 1-based
//    (start_line, end_line) pair) → HunkRange = z.tuple([z.number().int(), z.number().int()]).
//    NOT its own contract — a bare 2-tuple alias, so it is defined inline here, not imported.
//  - files: tuple[PrFileV1, ...]  → imports the sibling PrFileV1 Zod schema (no redefine).
//
// NOTE the Python `HunkRange` carries NO ge/le bound (plain `tuple[int, int]`), so the Zod tuple
// elements are plain `z.number().int()` — adding `.gte(1)` here would FALSELY reject negative/zero
// indices the frozen contract accepts and break accept/reject parity.

// HunkRange = tuple[int, int] — inclusive 1-based (start_line, end_line) pair.
// Pydantic serializes a tuple to a JSON array; a fixed-length 2-tuple → z.tuple of two ints.
export const HunkRange = z.tuple([z.number().int(), z.number().int()]);
export type HunkRange = z.infer<typeof HunkRange>;

export const PrFilesEnrichmentResultV1 = z
  .object({
    // schema_version: int = 1 — Pydantic plain-int default, NOT Literal[1] → z.number().int().default(1).
    schema_version: z.number().int().default(1),
    // files: tuple[PrFileV1, ...] — required (no default) → z.array(PrFileV1).
    files: z.array(PrFileV1),
    // changed_line_ranges: dict[str, tuple[HunkRange, ...]] — required (no default).
    // dict[str, ...] → z.record(z.string(), array-of-HunkRange).
    changed_line_ranges: z.record(z.string(), z.array(HunkRange)),
    // truncated_at: int | None — REQUIRED (no default); may be null, but the key must be present.
    truncated_at: z.number().int().nullable(),
  })
  .strict();

export type PrFilesEnrichmentResultV1 = z.infer<typeof PrFilesEnrichmentResultV1>;
