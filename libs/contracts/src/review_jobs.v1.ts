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
}).passthrough();
export type ReviewJobV1 = z.infer<typeof ReviewJobV1>;
