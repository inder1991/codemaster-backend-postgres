import { z } from "zod";

// Zod port of contracts/outbox_payloads/v1.py (frozen Python). Parity-validated in
// outbox_payloads.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - VaultCredentialWritePayloadV1    (ConfigDict extra="ignore") → default .strip() (NO .strict())
//  - TemporalWorkflowStartPayloadV1   (ConfigDict extra="ignore") → default .strip()
//  - BedrockPayloadArchivePayloadV1   (ConfigDict extra="ignore") → default .strip()
//
// EXTRA-FIELD HANDLING: all three models use `ConfigDict(extra="ignore")`, NOT extra="forbid".
// Pydantic drops unknown fields silently; Zod's DEFAULT `.object()` behaviour also strips unknown
// keys (`.strip()`), so the two agree by construction. We therefore do NOT call `.strict()` here,
// and the parity test asserts AGREEMENT-ON-STRIP (round-trip an extra field → equal canonical),
// not mutual rejection.
//
// schema_version: these contracts type it as a Python `Literal[...]` (NOT a bare `int`), so
// Pydantic re-emits exactly the literal value. The Vault/Bedrock sinks pin `Literal[1] = 1`
// (→ z.literal(1).default(1)); the Temporal sink accepts `Literal[1, 2] = 2` for the v1→v2
// in-flight migration window (→ z.union([z.literal(1), z.literal(2)]).default(2)).
//
// NOTE on `payload_bytes_zstd` (BedrockPayloadArchivePayloadV1): the Python field is typed `bytes`.
// Over the JSON wire (model_dump(mode="json")) Pydantic emits bytes as their UTF-8-decoded string and
// accepts a `str` input (UTF-8-encoding it). On the Zod side the wire shape is therefore a string, so
// the field is modelled as `z.string()`. Parity payloads use ASCII-only content so the UTF-8
// round-trip is lossless and canonical JSON byte-matches.

// VaultCredentialWritePayloadV1 — ConfigDict(extra="ignore"); default strip (no .strict()).
export const VaultCredentialWritePayloadV1 = z.object({
  schema_version: z.literal(1).default(1),
  // Pydantic UUID — lowercased on model_dump(mode="json"). z.string().uuid() validates the shape.
  integration_id: z.string().uuid(),
  vault_path: z.string(),
  // dict[str, str] → record of string values.
  secret_material: z.record(z.string(), z.string()),
  // int | None = None → nullable int with default null.
  expected_vault_version_after: z.number().int().nullable().default(null),
});
export type VaultCredentialWritePayloadV1 = z.infer<typeof VaultCredentialWritePayloadV1>;

// id_reuse_policy = Literal["ALLOW_DUPLICATE", "REJECT_DUPLICATE"].
export const IdReusePolicy = z.enum(["ALLOW_DUPLICATE", "REJECT_DUPLICATE"]);
export type IdReusePolicy = z.infer<typeof IdReusePolicy>;

// id_conflict_policy = Literal["FAIL", "USE_EXISTING", "TERMINATE_EXISTING"].
export const IdConflictPolicy = z.enum(["FAIL", "USE_EXISTING", "TERMINATE_EXISTING"]);
export type IdConflictPolicy = z.infer<typeof IdConflictPolicy>;

// TemporalWorkflowStartPayloadV1 — ConfigDict(extra="ignore"); default strip (no .strict()).
export const TemporalWorkflowStartPayloadV1 = z.object({
  // schema_version: Literal[1, 2] = 2 — accept both legacy v1 rows and v2 default.
  schema_version: z.union([z.literal(1), z.literal(2)]).default(2),
  workflow_type: z.string(),
  workflow_id: z.string(),
  task_queue: z.string(),
  // list[object] = default_factory=list → array of arbitrary JSON values.
  args: z.array(z.unknown()).default([]),
  execution_timeout_seconds: z.number().int().gte(1).lte(86400).default(900),
  run_timeout_seconds: z.number().int().gte(1).lte(86400).default(900),
  // dict[str, object] = default_factory=dict → record of arbitrary JSON values.
  search_attributes: z.record(z.string(), z.unknown()).default({}),
  id_reuse_policy: IdReusePolicy.default("ALLOW_DUPLICATE"),
  id_conflict_policy: IdConflictPolicy.default("TERMINATE_EXISTING"),
});
export type TemporalWorkflowStartPayloadV1 = z.infer<typeof TemporalWorkflowStartPayloadV1>;

// BedrockPayloadArchivePayloadV1 — ConfigDict(extra="ignore"); default strip (no .strict()).
export const BedrockPayloadArchivePayloadV1 = z.object({
  schema_version: z.literal(1).default(1),
  llm_call_id: z.string().uuid(),
  // Python `bytes`; wire shape is the UTF-8-decoded string (see header note).
  payload_bytes_zstd: z.string(),
  target_uri_prefix: z.string(),
});
export type BedrockPayloadArchivePayloadV1 = z.infer<typeof BedrockPayloadArchivePayloadV1>;
