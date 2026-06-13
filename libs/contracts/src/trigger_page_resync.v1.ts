import { z } from "zod";

/**
 * Contracts for the single-page resync workflow (Sub-spec C T8b).
 * contracts/workflows/trigger_page_resync/v1.py. Both `ConfigDict(extra="forbid", frozen=True)` ->
 * `.strict()`.
 *
 * The DELETE-approval admin endpoint enqueues TriggerPageResyncWorkflow so default-tagged chunks of a
 * just-revoked page are flushed within minutes instead of waiting for the next 6h ConfluenceIngest tick.
 */
export const TriggerPageResyncInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    space_key: z.string().min(1).max(64),
    page_id: z.string().min(1).max(64),
    // uuid.UUID | None = None -> optional + nullable, defaulting to null (the admin user who revoked the
    // approval; absent when a background reconciler triggers the resync). Present in the dumped payload.
    triggered_by_user_id: z.string().uuid().nullable().default(null),
  })
  .strict();
export type TriggerPageResyncInputV1 = z.infer<typeof TriggerPageResyncInputV1>;

/**
 * Result of TriggerPageResyncWorkflow. `resync_complete=false` signals a transient downstream error
 * (Confluence rate-limited, embed service down) — the caller retries or escalates.
 */
export const TriggerPageResyncOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    space_key: z.string(),
    page_id: z.string(),
    resync_complete: z.boolean(),
  })
  .strict();
export type TriggerPageResyncOutputV1 = z.infer<typeof TriggerPageResyncOutputV1>;
