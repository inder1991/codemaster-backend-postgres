import { z } from "zod";

// Zod port of contracts/admin/quarantined_chunks/v1.py — read-only list of quarantined chunks per space.
// Quarantine state is managed by the sync pipeline; operators triage by editing the Confluence page.
//
// Field parity notes (ConfigDict(extra="forbid") → .strict()):
//   - schema_version is a PLAIN `int = 1` → z.number().int().default(1).
//   - chunk_id: uuid.UUID → z.string().uuid().
//   - last_modified_at is PLAIN `datetime` → offset+local-permissive guard.

/** One quarantined chunk from a confluence space. */
export const QuarantinedChunkV1 = z
  .object({
    schema_version: z.number().int().default(1),
    chunk_id: z.string().uuid(),
    space_key: z.string(),
    page_id: z.string(),
    page_title: z.string(),
    page_version: z.number().int().min(1),
    last_modified_at: z.string().datetime({ offset: true, local: true }),
    quarantine_reasons: z.array(z.string()).max(20).default([]),
    // Truncated to 280 chars for the sidebar preview; operators open the page in Confluence for full body.
    chunk_text_preview: z.string().max(280),
  })
  .strict();
export type QuarantinedChunkV1 = z.infer<typeof QuarantinedChunkV1>;

/** Paginated envelope for the list endpoint. */
export const QuarantinedChunksPageV1 = z
  .object({
    schema_version: z.number().int().default(1),
    rows: z.array(QuarantinedChunkV1),
    next_cursor: z.string().max(512).nullable().default(null),
  })
  .strict();
export type QuarantinedChunksPageV1 = z.infer<typeof QuarantinedChunksPageV1>;
