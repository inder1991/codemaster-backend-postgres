import { z } from "zod";

/**
 * Return contract of the `run_pg_partman_maintenance` activity.
 *
 * 1:1 with the frozen Python `PartitionMaintenanceResultV1`
 * (codemaster/workflows/partition_maintenance.py:23-30). NOTE the model is DEFINED in the WORKFLOW module
 * (the activity imports it from there); the parity oracle therefore resolves it under
 * `codemaster.workflows.partition_maintenance`. `ConfigDict(extra="forbid")` → `.strict()`:
 *  - schema_version: int = 1        → z.number().int().default(1)  (a PLAIN int default, NOT a Literal —
 *                                     1:1 with review_run_reaper_result, NOT retention.v1's z.literal(1))
 *  - tables_processed: int          → z.number().int()  (REQUIRED, no default, NO ge=)
 *  - partitions_created: int        → z.number().int()  (REQUIRED, no default, NO ge=)
 *
 * The Python int fields carry NO `Field(ge=…)` constraint (verbatim — the activity already floors
 * partitions_created at 0 via `max(after - before, 0)` before constructing the model, so the contract
 * itself imposes no non-negativity). We therefore omit `.gte(0)` to keep accept/reject parity with the
 * Pydantic oracle — a deliberate divergence from retention.v1.ts (whose Python DID use `Field(ge=0)`).
 */
export const PartitionMaintenanceResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    tables_processed: z.number().int(),
    partitions_created: z.number().int(),
  })
  .strict();
export type PartitionMaintenanceResultV1 = z.infer<typeof PartitionMaintenanceResultV1>;
