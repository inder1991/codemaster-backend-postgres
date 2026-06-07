import { z } from "zod";

import { WorkspaceHandle } from "./workspace_handle.v1.js";

// Zod port of codemaster/activities/_workspace_clone.py::CloneRepoIntoWorkspaceInput (frozen Python).
// Parity-validated in clone_repo_into_workspace_input.v1.parity.test.ts.
//
// Single typed positional input for the workspace-aware clone activity (Phase 6 Task 18).
// ConfigDict(extra="forbid") → .strict(). NOT frozen on the Python side (the handle it nests IS).
//
// schema_version GOTCHA: Python `schema_version: Literal[1] = 1` (Literal, not bare int) → only the
// value 1 is accepted, default 1. z.literal(1).default(1) reproduces both the constraint and default.
//
// changed_paths GOTCHA: Python tuple[str, ...] → JSON array of strings. Zod z.array(z.string()).
//
// pr_number GOTCHA: Python `int | None = None`. Pydantic dumps null when omitted → the Zod field is
// .nullable().default(null) so the dumped shape carries an explicit null (matches the oracle output).
//
// handle is a nested WorkspaceHandle — the sibling Zod schema is IMPORTED above, not redefined.
export const CloneRepoIntoWorkspaceInput = z
  .object({
    schema_version: z.literal(1).default(1),
    handle: WorkspaceHandle,
    repo_url: z.string(),
    head_sha: z.string(),
    // NUMERIC GitHub-App installation id the clone mints its token for (per-review routing). NULLABLE here
    // ALONE among the GitHub activity inputs: the clone is dispatched UNCONDITIONALLY on the spine and the
    // workflow payload's github_installation_id is itself nullable — so the contract accepts null and the
    // clone ACTIVITY fail-closes (CloneFailedError) on a null id rather than the contract rejecting it.
    // TS-only field, absent in the frozen Python CloneRepoIntoWorkspaceInput; the parity test strips it.
    github_installation_id: z.number().int().gte(0).nullable().default(null),
    changed_paths: z.array(z.string()),
    pr_number: z.number().int().nullable().default(null),
  })
  .strict();

export type CloneRepoIntoWorkspaceInput = z.infer<typeof CloneRepoIntoWorkspaceInput>;
