import { z } from "zod";

// Zod port of contracts/retention/v1.py. Parity-validated in
// retention.v1.parity.test.ts.
//
// Pydantic v2 envelopes for the run_id retention janitor. Every model carries
// ConfigDict(extra="forbid") → .strict(), schema_version: Literal[1] = 1 →
// z.literal(1).default(1), and integer counters with Field(ge=0) → z.number().int().gte(0).
//
// Source models ported (every public one):
//  - StalePrCloserResultV1   (scanned / closed / skipped)
//  - RunsRetentionResultV1   (scanned / retired)
//  - EventsRetentionResultV1 (scanned / deleted / batches)
//  - RunIdRetentionResultV1  (composite: pr_closer / runs / events nested submodels)
//
// No enums, floats, datetimes, or UUIDs — pure integer-counter result envelopes.

// StalePrCloserResultV1 — result of run_id_close_stale_prs activity.
export const StalePrCloserResultV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    scanned: z.number().int().gte(0),
    closed: z.number().int().gte(0),
    skipped: z.number().int().gte(0),
  })
  .strict();
export type StalePrCloserResultV1 = z.infer<typeof StalePrCloserResultV1>;

// RunsRetentionResultV1 — result of run_id_retire_old_runs activity.
export const RunsRetentionResultV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    scanned: z.number().int().gte(0),
    retired: z.number().int().gte(0),
  })
  .strict();
export type RunsRetentionResultV1 = z.infer<typeof RunsRetentionResultV1>;

// EventsRetentionResultV1 — result of run_id_delete_old_events activity.
export const EventsRetentionResultV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    scanned: z.number().int().gte(0),
    deleted: z.number().int().gte(0),
    batches: z.number().int().gte(0),
  })
  .strict();
export type EventsRetentionResultV1 = z.infer<typeof EventsRetentionResultV1>;

// RunIdRetentionResultV1 — composite return value of RunIdRetentionWorkflow.
// Aggregates the three sub-activity results.
export const RunIdRetentionResultV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    pr_closer: StalePrCloserResultV1,
    runs: RunsRetentionResultV1,
    events: EventsRetentionResultV1,
  })
  .strict();
export type RunIdRetentionResultV1 = z.infer<typeof RunIdRetentionResultV1>;
