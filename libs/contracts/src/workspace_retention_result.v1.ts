import { z } from "zod";

// Zod port of the THREE result contracts of the workspace-retention janitor activities
// (codemaster/activities/workspace_retention.py:73-101). Parity-validated in
// workspace_retention_result.v1.parity.test.ts.
//
// Pydantic v2 envelopes for the WorkspaceRetentionWorkflow's three composed activities. Every model
// carries ConfigDict(extra="forbid") → .strict() and schema_version: Literal[1] = 1 →
// z.literal(1).default(1).
//
// GOTCHA — NO ge= constraint: unlike retention.v1 (RunIdRetention*, which uses Field(ge=0)), the
// frozen workspace-retention counters carry NO Field(ge=0) — `orphaned_count: int` / `deleted_count:
// int` are bare ints (1:1 with review_run_reaper / partition_maintenance shape). So they map to
// z.number().int() with NO .gte(0).
//
// GOTCHA — workspace_ids is tuple[uuid.UUID, ...]: Pydantic model_dump(mode="json") emits each UUID as
// a lowercase string and the tuple as a JSON array → z.array(z.string().uuid()). UUIDs are spelled
// lowercase in fixtures so Pydantic's lowercasing-on-dump matches Zod's pass-through.

// WorkspaceOrphanSweepResultV1 — result of run_workspace_orphan_sweep_activity.
export const WorkspaceOrphanSweepResultV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    orphaned_count: z.number().int(),
  })
  .strict();
export type WorkspaceOrphanSweepResultV1 = z.infer<typeof WorkspaceOrphanSweepResultV1>;

// WorkspaceReapEligibleResultV1 — result of run_workspace_reap_activity. workspace_ids is the list of
// leases the workflow body invokes release_workspace_activity against (sorted, deterministic).
export const WorkspaceReapEligibleResultV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    workspace_ids: z.array(z.string().uuid()),
  })
  .strict();
export type WorkspaceReapEligibleResultV1 = z.infer<typeof WorkspaceReapEligibleResultV1>;

// WorkspaceRetentionPurgeResultV1 — result of run_workspace_released_retention_activity.
export const WorkspaceRetentionPurgeResultV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    deleted_count: z.number().int(),
  })
  .strict();
export type WorkspaceRetentionPurgeResultV1 = z.infer<typeof WorkspaceRetentionPurgeResultV1>;
