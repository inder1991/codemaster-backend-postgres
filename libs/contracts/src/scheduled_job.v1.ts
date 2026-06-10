import { z } from "zod";

// Phase 3a W1: row contract for core.scheduled_jobs (migration 0040) — the Postgres scheduler that
// replaces Temporal Schedules (2026-06-10 full-removal program). One row per schedule; the Wave-3
// scheduler loop reads `enabled AND next_run_at <= now()`, enqueues a core.background_jobs row
// (dedup_key = `${schedule_id}:${bucket}` for overlap=SKIP), and advances next_run_at.
//
//   - cadence_kind: 'cron' (cadence_spec = a cron expression) | 'interval' (cadence_spec = seconds).
//     DB CHECK ck_scheduled_jobs_cadence_kind mirrors the enum.
//   - overlap_policy: text, default 'skip' — 'skip' is the only Wave-3-implemented policy. The DB
//     carries NO CHECK on it (per the Phase-3a Wave-1 spec), so the contract stays string-typed:
//     a contract stricter than the DB would crash read paths on an operator-edited row.
//   - enabled: operator pause switch (mirrors ensureCronSchedule idempotency / Temporal pause).
export const CADENCE_KINDS = ["cron", "interval"] as const;
export const CadenceKind = z.enum(CADENCE_KINDS);
export type CadenceKind = z.infer<typeof CadenceKind>;

// Timestamps are z.coerce.date(): pg returns Date for timestamptz, JSON wire carries ISO strings —
// both coerce (the admin.v1.ts idiom; ZodNullable short-circuits null before coercion).
export const ScheduledJobV1 = z
  .object({
    schema_version: z.number().int().default(1),
    schedule_id: z.string().min(1),
    job_type: z.string().min(1),
    cadence_kind: CadenceKind,
    cadence_spec: z.string().min(1),
    input: z.record(z.unknown()),
    overlap_policy: z.string().min(1).default("skip"),
    enabled: z.boolean(),
    next_run_at: z.coerce.date(),
    last_enqueued_at: z.coerce.date().nullable(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .passthrough();
export type ScheduledJobV1 = z.infer<typeof ScheduledJobV1>;
