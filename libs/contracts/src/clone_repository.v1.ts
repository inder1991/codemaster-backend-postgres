import { z } from "zod";

// `CloneRepositoryInputV1` — the SINGLE typed positional input for `clone_repository_activity`
// (the standalone clone primitive the refresh_semantic_docs workflow proxies as Step 1).
//
// ── INVARIANT-11 DIVERGENCE (CLAUDE.md #11, LOCKED) ──────────────────────────────────────────────
// The Python clone step is called by the refresh workflow as THREE string positionals —
// `workflow.execute_activity("clone_repository_activity", args=[str(installation_id),
// str(repository_id), head_sha])`. The TS port collapses those three positionals into ONE
// typed Pydantic-v2-equivalent contract, because CLAUDE.md invariant 11 forbids multi-positional
// activity dispatch: "Every Temporal activity takes exactly one positional argument typed as a
// Pydantic v2 BaseModel." This is a faithful-port DIVERGENCE surfaced for the integrator — there is
// NO Python Pydantic model with THIS field shape (the Python `CloneRequestV1` in
// clone_repository.py carries a DIFFERENT shape: repository_full_name + ref + max_bytes +
// timeout_seconds, resolved INSIDE the activity, not on the workflow boundary). Because no Python
// model mirrors this contract, there is NO oracle parity test for it (the parity oracle has nothing
// to diff against).
//
// schema_version: matches the refresh contract idiom — a plain int default 1 (NOT z.literal), so a
// future v2 input shape can travel the same field per the *_v2 patched-activity retirement lifecycle.
//
// installation_id / repository_id: tenant + repo identity UUIDs (the cache-dir layout
// `/clone-cache/<installation_id>/<repository_id>/` is derived from them — see the activity).
//
// head_sha: the commit the clone lands. Same R-45 git-SHA shape the refresh input enforces
// (7-64 lowercase-hex chars) so a malformed SHA is rejected at the contract boundary BEFORE any
// subprocess/token work — consistent with the GitSubprocessCloner's HEAD_SHA_RE precondition.
export const CloneRepositoryInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    installation_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    head_sha: z.string().min(7).max(64).regex(/^[0-9a-f]+$/),
  })
  .strict();

export type CloneRepositoryInputV1 = z.infer<typeof CloneRepositoryInputV1>;
