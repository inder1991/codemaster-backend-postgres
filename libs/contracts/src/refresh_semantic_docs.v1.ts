import { z } from "zod";

// Zod port of contracts/refresh_semantic_docs/v1.py (frozen Python — Sprint 26 / B-3).
// Parity-validated in refresh_semantic_docs.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - _TriggerSource (module-level Literal)            → TriggerSource (z.enum)
//  - RefreshSemanticDocsInputV1  (ConfigDict extra="forbid", frozen) → .strict()
//  - RefreshSemanticDocsResultV1 (ConfigDict extra="forbid", frozen) → .strict()
//
// UUID fields are emitted by Pydantic model_dump(mode="json") as lowercase RFC4122 strings; on the
// wire they are strings, so the Zod port validates the string form. `schema_version: int = 1` is a
// plain int default (NOT z.literal) → z.number().int().default(1).

// _TriggerSource = Literal["default_branch_push", "manual", "config_change"]
export const TriggerSource = z.enum(["default_branch_push", "manual", "config_change"]);
export type TriggerSource = z.infer<typeof TriggerSource>;

// RefreshSemanticDocsInputV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// head_sha: str = Field(min_length=7, max_length=64, pattern=r"^[0-9a-f]+$") — R-45 git-SHA shape.
export const RefreshSemanticDocsInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    installation_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    triggered_by: TriggerSource,
    head_sha: z.string().min(7).max(64).regex(/^[0-9a-f]+$/),
  })
  .strict();
export type RefreshSemanticDocsInputV1 = z.infer<typeof RefreshSemanticDocsInputV1>;

// RefreshSemanticDocsResultV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// degradation_reason: str | None = Field(default=None, max_length=200) → .nullable().default(null)
// (Pydantic dumps the absent field as explicit null, so the Zod default injects null too).
export const RefreshSemanticDocsResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    docs_discovered: z.number().int().gte(0),
    chunks_persisted: z.number().int().gte(0),
    chunks_skipped_oversize: z.number().int().gte(0),
    retrieval_degraded: z.boolean().default(false),
    degradation_reason: z.string().max(200).nullable().default(null),
    duration_ms: z.number().int().gte(0),
  })
  .strict();
export type RefreshSemanticDocsResultV1 = z.infer<typeof RefreshSemanticDocsResultV1>;
