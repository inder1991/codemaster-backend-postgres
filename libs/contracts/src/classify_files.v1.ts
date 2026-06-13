import { z } from "zod";

// NEW typed-input envelope introduced DURING the Python→TS port — there is NO Python Pydantic
// counterpart to diff against. `ClassifyFilesActivity.classify_files`
// dispatches with TWO positional
// arguments — `(workspace_path: str, files: tuple[str, ...])` — which violates CLAUDE.md invariant 11 /
// ADR-0047 ("every Temporal activity takes EXACTLY ONE positional argument typed as a Pydantic v2
// BaseModel"). The TS port CLOSES that violation: the activity's single positional input is this
// `ClassifyFilesInputV1` envelope (consistent with the aggregate_findings.v1 envelope that closed the
// only OTHER known live invariant-11 dispatch).
//
// Because there is no Python contract for this envelope, the parity test only covers round-trip /
// validation (accepts a valid {workspace_path, files}; `.strict()` rejects unknown keys) — there is no
// source-of-truth to byte-diff against.
//
// Field mapping:
//  - `workspace_path: str` positional → z.string(). The Python wraps it in `Path(workspace_path)`; the
//    TS activity wraps it via node:path the same way. No min-length bound (the Python `str` is loose).
//  - `files: tuple[str, ...]` positional → z.array(z.string()). Tuples serialize to JSON arrays; the
//    activity iterates this in INPUT ORDER (the failure-isolation ordering is parity-significant).
//  - `schema_version: int = 1` → z.number().int().default(1) (NOT z.literal(1): a literal would
//    false-reject a future schema_version=2 wire payload). Mirrors the aggregate_findings.v1 envelope.

export const ClassifyFilesInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    workspace_path: z.string(),
    files: z.array(z.string()),
  })
  .strict();
export type ClassifyFilesInputV1 = z.infer<typeof ClassifyFilesInputV1>;
