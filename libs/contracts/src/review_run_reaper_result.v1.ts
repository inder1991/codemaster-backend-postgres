import { z } from "zod";

/**
 * Return contract of `review_run_reaper_activity`.
 *
 * 1:1 with the frozen Python (codemaster/activities/review_run_reaper.py:41-46,
 * `ConfigDict(extra="forbid")` → `.strict()`):
 *  - schema_version: int = 1   → z.number().int().default(1)
 *  - scanned: int              → z.number().int()  (REQUIRED, no default, NO ge=)
 *  - reaped: int               → z.number().int()  (REQUIRED, no default, NO ge=)
 *
 * The reaper UPDATE … RETURNING drives both counters from the same row set, so in the frozen Python
 * `scanned == reaped == len(rows)` always (every row the CTE UPDATE flipped is counted). The two fields
 * are retained as distinct contract members for forward-compat / parity with the mutex-janitor shape.
 */
export const ReviewRunReaperResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    scanned: z.number().int(),
    reaped: z.number().int(),
  })
  .strict();
export type ReviewRunReaperResultV1 = z.infer<typeof ReviewRunReaperResultV1>;
