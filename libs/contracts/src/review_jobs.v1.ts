import { z } from "zod";
export const JOB_STATES = ["ready", "leased", "done", "dead", "cancelled"] as const;
export const JobState = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobState>;
export const ReviewJobV1 = z.object({
  job_id: z.string().uuid(), run_id: z.string().uuid(), review_id: z.string().uuid(),
  installation_id: z.string().uuid(),
  delivery_id: z.string().nullable().optional(),
  state: JobState, priority: z.number().int(), attempts: z.number().int(), max_attempts: z.number().int(),
  attempt_token: z.string().uuid().nullable().optional(),
  // D1/F1 — durable workflow-argument store (migration 0037). job_payload_schema_version is the
  // STORAGE-ENVELOPE version (default 1, NOT NULL in the DB), DISTINCT from the review payload's OWN
  // inner schema_version (=2, review_pull_request.v1.ts). payload_sha256 = sha256hex(canonicalJson(payload))
  // bound at enqueue; verifyPayload() recomputes + compares it in the shell. mutex_id (D3/F6) is the
  // FK to core.pr_review_mutex the shell persists on first acquire and reuses on re-run (null until then).
  job_payload_schema_version: z.number().int().optional(),
  payload_sha256: z.string().optional(),
  mutex_id: z.string().uuid().nullable().optional(),
}).passthrough();
export type ReviewJobV1 = z.infer<typeof ReviewJobV1>;
