import { z } from "zod";

/**
 * Return contract of `mutex_janitor_activity`.
 *
 * 1:1 with the frozen Python (codemaster/activities/mutex_janitor.py:32-37,
 * `ConfigDict(extra="forbid")` → `.strict()`):
 *  - schema_version: int = 1   → z.number().int().default(1)
 *  - scanned: int              → z.number().int()  (REQUIRED, no default, NO ge= — the activity always
 *      passes a loop-counted non-negative value, but Pydantic imposes no lower bound, so neither does Zod)
 *  - swept: int                → z.number().int()  (REQUIRED, no default, NO ge=)
 *
 * `scanned` counts rows the sweep SELECT … FOR UPDATE SKIP LOCKED claimed; `swept` counts rows whose
 * released_at was actually set (== scanned in the common case — the per-row UPDATE is guarded
 * `WHERE … released_at IS NULL`, so a concurrent release between SELECT and UPDATE can make swept < scanned).
 */
export const MutexJanitorResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    scanned: z.number().int(),
    swept: z.number().int(),
  })
  .strict();
export type MutexJanitorResultV1 = z.infer<typeof MutexJanitorResultV1>;
