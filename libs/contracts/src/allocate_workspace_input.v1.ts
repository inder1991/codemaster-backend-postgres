import { z } from "zod";

// Zod port of codemaster/activities/_workspace_allocate.py::AllocateWorkspaceInput.
// Parity-validated in allocate_workspace_input.v1.parity.test.ts.
//
// Single typed positional input for the workspace-allocation activity (CLAUDE.md invariant 11 —
// single positional Pydantic BaseModel input per Temporal activity).
// ConfigDict(extra="forbid") → .strict().
//
// schema_version GOTCHA: Python `schema_version: Literal[1] = 1` (Literal, not bare int) → only the
// value 1 is accepted, default 1. z.literal(1).default(1) reproduces both the constraint and default
// (same idiom as clone_repo_into_workspace_input.v1.ts; NOT the bare-int idiom of
// persist_review_findings.v1.ts whose Python field is a plain int).
//
// run_id / review_id / installation_id GOTCHA: Python uuid.UUID → z.string().uuid(). UUIDs are spelled
// lowercase in fixtures so Pydantic's lowercasing-on-dump matches Zod's pass-through.
//
// repo_id GOTCHA: Python `repo_id: int | None = None` — the numeric GitHub-side repo id for the
// diagnostic _meta payload (AD-13). Pydantic dumps null when omitted → the Zod field is
// .nullable().default(null) so the dumped shape carries an explicit null (matches the oracle output).
//
// workflow_id GOTCHA: Python `workflow_id: str` (required, no default) → z.string() required.
export const AllocateWorkspaceInput = z
  .object({
    schema_version: z.literal(1).default(1),
    run_id: z.string().uuid(),
    review_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    repo_id: z.number().int().nullable().default(null),
    workflow_id: z.string(),
  })
  .strict();

export type AllocateWorkspaceInput = z.infer<typeof AllocateWorkspaceInput>;
