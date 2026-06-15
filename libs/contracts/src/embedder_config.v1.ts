// Admin contracts for the DB-backed embedder config (Phase 2). These replace the Vault-KV
// `embedder.qwen` platform-credential path with a first-class, UI-editable provider config persisted in
// core.embedder_provider_settings (field-codec ciphertext). The api key NEVER appears in any GET shape —
// only `key_present:bool`. `provider` is SERVER-OWNED (only openai_compat is representable today), so the
// PUT body omits it. The /test response reuses TestPlatformCredentialsResponseV1 (admin.v1) — its
// {ok, error, error_detail, latency_ms, detected_dimension, corpus_dimension} shape already matches the
// probe output exactly.

import { z } from "zod";

/** The only embedder provider representable today (server-owned; the PUT body never sends it). */
export const EMBEDDER_PROVIDER = "openai_compat" as const;

/** Validation outcome persisted on the settings row (mirrors the eps_validation_state CHECK). */
export const EmbedderValidationStatusV1 = z.enum(["ok", "failed"]);
export type EmbedderValidationStatusV1 = z.infer<typeof EmbedderValidationStatusV1>;

/**
 * GET /api/admin/embedder-config — the non-secret view. `key_present` reflects whether an api key is
 * stored (false for a keyless embedder OR an unconfigured row). When no row exists yet, base_url /
 * model_name / the timestamps are null and enabled is false. `updated_at` is surfaced so a UI that wants
 * optimistic concurrency can echo it; the server's /test promotion is the authoritative CAS guard.
 */
export const EmbedderConfigV1 = z
  .object({
    schema_version: z.number().int().default(1),
    provider: z.literal(EMBEDDER_PROVIDER),
    base_url: z.string().nullable(),
    model_name: z.string().nullable(),
    key_present: z.boolean(),
    enabled: z.boolean(),
    last_validation_status: EmbedderValidationStatusV1.nullable(),
    last_validation_error: z.string().nullable(),
    last_validated_at: z.string().datetime({ offset: true }).nullable(),
    last_rotated_at: z.string().datetime({ offset: true }).nullable(),
    last_rotated_by: z.string().nullable(),
    updated_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type EmbedderConfigV1 = z.infer<typeof EmbedderConfigV1>;

/**
 * PUT /api/admin/embedder-config — provider is server-owned (never sent). `api_key` is TRI-STATE:
 *   - absent (undefined) → keep the existing key untouched;
 *   - null               → clear the key (keyless embedder);
 *   - non-empty string   → set / rotate the key.
 * A PUT only STAGES the row (and resets validation) — promotion to the runtime happens on /test success.
 */
export const PutEmbedderConfigRequestV1 = z
  .object({
    schema_version: z.number().int().default(1),
    base_url: z.string().min(1).max(2048),
    model_name: z.string().min(1).max(256),
    // min(4): the stored fingerprint is the last 4 plaintext chars (the eps_fingerprint_4 CHECK), so a
    // 1-3 char key would pass Zod then violate the DB CHECK (500). A real api key is always ≥4 chars.
    api_key: z.string().min(4).max(4096).nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type PutEmbedderConfigRequestV1 = z.infer<typeof PutEmbedderConfigRequestV1>;

// ─── config-status (versioned; adds the `invalid` state + an optional detail) ─────────────────────────

/** A non-blocking feature-config state. `invalid` (6-10) = saved + enabled but the last /test failed —
 *  distinct from `disabled` (saved but enabled=false) and `pending` (not set in any source). */
export const ConfigStatusStateV1 = z.enum(["configured", "disabled", "pending", "invalid"]);
export type ConfigStatusStateV1 = z.infer<typeof ConfigStatusStateV1>;

/** Where the value came from. `db` = UI-saved (overrides env/file); env/file/vault = the observed tier. */
export const ConfigStatusSourceV1 = z.enum(["db", "env", "file", "vault", "none"]);
export type ConfigStatusSourceV1 = z.infer<typeof ConfigStatusSourceV1>;

/** One config-status item. `detail`/`gates` are optional so the existing lean items keep validating. */
export const ConfigStatusItemV1 = z
  .object({
    key: z.string(),
    state: ConfigStatusStateV1,
    source: ConfigStatusSourceV1,
    detail: z.string().optional(),
    gates: z.string().optional(),
  })
  .strict();
export type ConfigStatusItemV1 = z.infer<typeof ConfigStatusItemV1>;

/** GET /api/admin/config-status — the actual response shape is `{ items: [...] }` (the route has always
 *  wrapped the array). The contract matches that exactly so a frontend can parse the boundary. */
export const ConfigStatusV1 = z.object({ items: z.array(ConfigStatusItemV1) });
export type ConfigStatusV1 = z.infer<typeof ConfigStatusV1>;
