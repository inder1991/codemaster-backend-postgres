import { z } from "zod";

import { DroppedClassificationV1 } from "./dropped_classification.v1.js";

// Zod port of contracts/posted_review/v1.py. Parity-validated in
// posted_review.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - PublicationOutcome (Python Enum, .value) → z.enum on the .value strings
//    (model_dump(mode="json") emits the .value: inline_posted / body_only_posted / degraded_unposted).
//  - PostedReviewV1 (ConfigDict extra="forbid", frozen=True) → .strict() + one
//    @model_validator(mode="after") (_validate_outcome_review_id_iff) re-authored as .superRefine().
//
// Field-shape notes:
//  - schema_version: int = 1                  → z.number().int().default(1) (PLAIN int with default,
//    NOT z.literal(1) — z.literal would wrongly reject a future schema_version bump).
//  - review_id: int | None = Field(default=None, ge=1)        → z.number().int().gte(1).nullable().default(null)
//  - marker_comment_id: int | None = Field(default=None, ge=1)→ z.number().int().gte(1).nullable().default(null)
//  - was_update: bool = False                 → z.boolean().default(false)
//  - inline_comment_count: int = Field(ge=0)  → z.number().int().gte(0) (REQUIRED, no default)
//  - comment_ids / kept_finding_indices: tuple[int, ...] = () → z.array(z.number().int()).default([])
//  - publication_outcome: PublicationOutcome = INLINE_POSTED  → PublicationOutcome.default("inline_posted")
//  - degradation_notes: tuple[str, ...] = ()  → z.array(z.string()).default([])
//  - dropped_classifications: tuple[DroppedClassificationV1, ...] = () → z.array(DroppedClassificationV1).default([])
//    (cross-contract ref imported from ./dropped_classification.v1.js — not redefined).
//
// No float fields, no UUID fields. No byte-round-trip hazards.

// PublicationOutcome(Enum) — model_dump(mode="json") emits the .value strings.
export const PublicationOutcome = z.enum(["inline_posted", "body_only_posted", "degraded_unposted"]);
export type PublicationOutcome = z.infer<typeof PublicationOutcome>;

// PostedReviewV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// One @model_validator(mode="after") (_validate_outcome_review_id_iff) re-authored below as .superRefine():
// publication_outcome=DEGRADED_UNPOSTED IFF review_id is null (both directions enforced).
export const PostedReviewV1 = z
  .object({
    schema_version: z.number().int().default(1),
    review_id: z.number().int().gte(1).nullable().default(null),
    marker_comment_id: z.number().int().gte(1).nullable().default(null),
    was_update: z.boolean().default(false),
    inline_comment_count: z.number().int().gte(0),
    comment_ids: z.array(z.number().int()).default([]),
    kept_finding_indices: z.array(z.number().int()).default([]),
    publication_outcome: PublicationOutcome.default("inline_posted"),
    degradation_notes: z.array(z.string()).default([]),
    dropped_classifications: z.array(DroppedClassificationV1).default([]),
  })
  .strict()
  // @model_validator(mode="after") _validate_outcome_review_id_iff:
  // publication_outcome=DEGRADED_UNPOSTED IFF review_id is null. Both directions of the IFF
  // are enforced — neither field is allowed to drift from the other.
  .superRefine((v, ctx) => {
    if (v.publication_outcome === "degraded_unposted") {
      if (v.review_id !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["review_id"],
          message: `publication_outcome=DEGRADED_UNPOSTED requires review_id is None (got review_id=${v.review_id})`,
        });
      }
    } else if (v.review_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["review_id"],
        message: `publication_outcome=${v.publication_outcome} requires review_id to be a positive int (got review_id=None)`,
      });
    }
  });
export type PostedReviewV1 = z.infer<typeof PostedReviewV1>;
