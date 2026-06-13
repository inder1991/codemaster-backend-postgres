import { z } from "zod";

// Zod port of contracts/integrations/v1.py. Parity-validated in
// integrations.v1.parity.test.ts.
//
// Boundary: admin-console integrations UI writes/reads; carries ONLY non-secret metadata
// (secrets referenced by vault_path + vault_version, never inlined).
//
// Source models / enums ported (every public one — the package __init__ re-exports exactly these):
//  - IntegrationKindV1     (str, Enum)                       → z.enum on the .value strings
//  - IntegrationProbeResultV1 (ConfigDict extra="ignore")   → plain z.object() (NO .strict():
//    extra="ignore" silently DROPS unknown keys, which Zod's default .parse() also does — both
//    accept-and-strip, so the parity test asserts strip-agreement, not extra-field rejection).
//    The Python class attribute `__contract_internal__ = True` is a dunder marker (not a model
//    field) so it never appears in model_dump(mode="json") — nothing to port on the wire.
//  - IntegrationMetadataV1 (ConfigDict extra="ignore")      → plain z.object() (same strip semantics)
//
// UUID fields are emitted by Pydantic model_dump(mode="json") as lowercase RFC4122 strings; payloads
// in the parity test use lowercase UUIDs so the wire shapes match byte-for-byte.
// datetime fields are valid RFC3339 strings; both canonicalizers normalize to `.ffffff+00:00`.

// IntegrationKindV1(str, Enum) — model_dump(mode="json") emits the .value strings.
export const IntegrationKindV1 = z.enum([
  "github_app_cloud",
  "github_app_ghes",
  "bedrock",
  "confluence",
  "embeddings",
  "postgres_app",
  "postgres_temporal",
  "nexus",
  "slack_webhook",
  "smtp",
  "keycloak",
]);
export type IntegrationKindV1 = z.infer<typeof IntegrationKindV1>;

// IntegrationProbeResultV1 — result of a "Test Connection" probe. ConfigDict(extra="ignore") → plain
// object (unknown keys stripped, not rejected). Nested in IntegrationMetadataV1.
export const IntegrationProbeResultV1 = z.object({
  success: z.boolean(),
  latency_ms: z.number().int(),
  error_class: z.string().nullable().default(null),
  error_message: z.string().nullable().default(null),
  probed_at: z.string().datetime({ offset: true }),
  probed_by_ad_user_id: z.string().uuid(),
});
export type IntegrationProbeResultV1 = z.infer<typeof IntegrationProbeResultV1>;

// IntegrationMetadataV1 — top-level integration metadata persisted into core.integrations.
// ConfigDict(extra="ignore") → plain object (unknown keys stripped, not rejected).
export const IntegrationMetadataV1 = z.object({
  // schema_version: Literal[1] = 1.
  schema_version: z.literal(1).default(1),

  id: z.string().uuid(),
  name: z.string(),
  kind: IntegrationKindV1,

  // metadata: dict[str, object] = Field(default_factory=dict) — non-secret config (URLs/regions/etc.).
  metadata: z.record(z.string(), z.unknown()).default({}),

  // Vault references (the secret material itself never appears here).
  vault_path: z.string(),
  vault_version: z.number().int(),

  // Operational state.
  enabled: z.boolean().default(true),
  approval_required: z.boolean(),
  // pending_change: dict[str, object] | None — staged update awaiting two-person approval.
  pending_change: z.record(z.string(), z.unknown()).nullable().default(null),

  // Audit-friendly probe history.
  last_tested_at: z.string().datetime({ offset: true }).nullable().default(null),
  last_tested_by_ad_user_id: z.string().uuid().nullable().default(null),
  last_test_result: IntegrationProbeResultV1.nullable().default(null),

  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});
export type IntegrationMetadataV1 = z.infer<typeof IntegrationMetadataV1>;
