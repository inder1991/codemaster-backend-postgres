import { z } from "zod";

// Typed single-arg input envelope for the `sync_code_owners_activity` activity (CLAUDE.md invariant 11 —
// exactly one positional Pydantic/Zod-model argument per Temporal activity; ADR-0047).
//
// `SyncCodeOwnersWorkflow.run` takes a BARE `payload: dict[str, Any]` and dispatches the activity MULTI-positional:
//
//     return await workflow.execute_activity(
//         "sync_code_owners_activity",
//         args=[
//             uuid.UUID(payload["installation_id_uuid"]),   # uuid.UUID
//             int(payload["installation_id_int"]),          # int
//             uuid.UUID(payload["repository_id"]),          # uuid.UUID
//             str(payload["owner"]),                        # str
//             str(payload["repo"]),                         # str
//             str(payload["default_branch"]),               # str
//         ],
//         ...,
//     )
//
// pre-dating the ADR-0047 single-typed-input convention. The TS port introduces this envelope so the
// activity dispatch is positional-arg-free at the Temporal seam — consistent with the other ported
// activities (enrich_pr_files_input.v1 / post_review_input.v1 etc.). It is NOT a parity-validated 1:1 of
// an existing Python contract (there is NO Python `SyncCodeOwnersPayloadV1` — the Python side is a bare
// dict); it is the activity-input contract the port adds.
//
// FIELD NAMES MIRROR THE PYTHON PAYLOAD DICT KEYS VERBATIM (`installation_id_uuid` / `installation_id_int`
// / `repository_id` / `owner` / `repo` / `default_branch`), NOT the renamed shape enrich_pr_files uses.
// The webhook emitter (the INTEGRATOR's push-event branch in github_webhook_persistence) builds the
// `temporal_workflow_start` outbox payload with exactly these keys, so keeping the names identical means
// the emitter does not need a field-rename adapter — the same bare dict the Python webhook handler emits
// validates 1:1 here.
//
// Field shapes (read off the dispatch arg order + the frozen activity signature
// `sync_code_owners(installation_id_uuid, installation_id_int, repository_id, owner, repo,
// default_branch)`):
//  - installation_id_uuid: uuid.UUID — the FK installation id the persisted code_owners rows carry
//                          (`core.code_owners.installation_id`). Lowercased UUID string on the wire.
//  - installation_id_int:  int (ge=0) — the NUMERIC GitHub-API installation id the GitHub client
//                          authenticates the CODEOWNERS fetch with.
//  - repository_id:        uuid.UUID — the repo FK the persisted rows carry. Lowercased UUID string.
//  - owner:                str (1..200) — GitHub owner/org login.
//  - repo:                 str (1..200) — bare repo name (NOT "owner/name").
//  - default_branch:       str (1..255) — the ref the CODEOWNERS file is fetched at (the repo's default
//                          branch; the webhook push-event branch only enqueues on a default-branch push).
//
// No float fields. UUIDs spelled lowercase so a Pydantic-lowercased dump round-trips through Zod's
// pass-through. ConfigDict(extra="forbid") analogue → .strict().
export const SyncCodeOwnersPayloadV1 = z
  .object({
    schema_version: z.number().int().default(1),
    installation_id_uuid: z.string().uuid(),
    installation_id_int: z.number().int().gte(0),
    repository_id: z.string().uuid(),
    owner: z.string().min(1).max(200),
    repo: z.string().min(1).max(200),
    default_branch: z.string().min(1).max(255),
  })
  .strict();

export type SyncCodeOwnersPayloadV1 = z.infer<typeof SyncCodeOwnersPayloadV1>;
