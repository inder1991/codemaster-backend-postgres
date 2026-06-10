import { z } from "zod";

// Phase 3a W1: row contract for core.background_jobs (migration 0039) — the GENERIC job platform
// generalizing the proven core.review_jobs runner (review_jobs.v1.ts is the template; ADR-0077).
//
// Vocabulary divergences from ReviewJobV1 (deliberate, per the 2026-06-10 full-removal program):
//   - 'failed' IS a persisted resting state (review_jobs maps it transiently to ready|dead inside
//     markFailed; the generic platform persists it so an operator can distinguish "retry scheduled"
//     from "attempts exhausted" without reading the transition log).
//   - 'cancelled' does NOT exist (supersede semantics are review-pipeline-specific).
//   - installation_id is NULLABLE: some job types are tenant-scoped, most (crons, outbox drain,
//     retention) are platform-scoped. NULL = platform-scoped row.
//   - dedup_key is the scheduler's overlap=SKIP guard: a partial UNIQUE index
//     (WHERE dedup_key IS NOT NULL AND state IN ('ready','leased')) makes a second ACTIVE row with
//     the same key an insert-time conflict.
export const BACKGROUND_JOB_STATES = ["ready", "leased", "done", "failed", "dead"] as const;
export const BackgroundJobState = z.enum(BACKGROUND_JOB_STATES);
export type BackgroundJobState = z.infer<typeof BackgroundJobState>;

/** The sha256hex output shape — 64 LOWERCASE hex chars (mirrors DB CHECK ck_background_jobs_payload_sha256_hex). */
export const PAYLOAD_SHA256_RE = /^[0-9a-f]{64}$/;

// Timestamps are z.coerce.date(): pg returns Date for timestamptz, JSON wire carries ISO strings —
// both coerce (the admin.v1.ts idiom). ZodNullable short-circuits on null BEFORE coercion, so a
// NULL column never becomes epoch-0.
export const BackgroundJobV1 = z
  .object({
    schema_version: z.number().int().default(1),
    job_id: z.string().uuid(),
    job_type: z.string().min(1),
    installation_id: z.string().uuid().nullable(),
    payload: z.record(z.unknown()),
    payload_sha256: z.string().regex(PAYLOAD_SHA256_RE),
    state: BackgroundJobState,
    priority: z.number().int(),
    run_after: z.coerce.date(),
    lease_owner: z.string().nullable(),
    attempt_token: z.string().uuid().nullable(),
    leased_until: z.coerce.date().nullable(),
    timeout_at: z.coerce.date().nullable(),
    heartbeat_at: z.coerce.date().nullable(),
    attempts: z.number().int(),
    max_attempts: z.number().int(),
    dedup_key: z.string().nullable(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .passthrough();
export type BackgroundJobV1 = z.infer<typeof BackgroundJobV1>;
