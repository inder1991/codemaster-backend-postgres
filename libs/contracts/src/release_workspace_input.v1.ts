import { z } from "zod";

// Zod port of codemaster/activities/_workspace_release.py::ReleaseWorkspaceInput.
// Parity-validated in release_workspace_input.v1.parity.test.ts.
//
// Single typed positional input for the workspace-release activity (CLAUDE.md invariant 11 — single
// positional Pydantic BaseModel input per Temporal activity). Constructed by the workflow body, the
// janitor, or operator tools. ConfigDict(extra="forbid") → .strict().
//
// schema_version GOTCHA: Python `schema_version: Literal[1] = 1` (Literal, not bare int) → only the
// value 1 is accepted, default 1. z.literal(1).default(1) reproduces both the constraint and default.
//
// workspace_id GOTCHA: Python uuid.UUID → z.string().uuid(). UUIDs are spelled lowercase in fixtures so
// Pydantic's lowercasing-on-dump matches Zod's pass-through.
export const ReleaseWorkspaceInput = z
  .object({
    schema_version: z.literal(1).default(1),
    workspace_id: z.string().uuid(),
  })
  .strict();

export type ReleaseWorkspaceInput = z.infer<typeof ReleaseWorkspaceInput>;
