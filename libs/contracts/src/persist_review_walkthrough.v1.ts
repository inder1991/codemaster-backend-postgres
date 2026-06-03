import { z } from "zod";

import { WalkthroughV1 } from "./walkthrough.v1.js";

// Zod port of contracts/persist_review_walkthrough/v1.py::PersistReviewWalkthroughInputV1 (frozen
// Python). Parity-validated in persist_review_walkthrough.v1.parity.test.ts.
//
// Single typed positional input for the persist_review_walkthrough_activity (review-detail P3).
// ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
//
// Source models / enums / constants ported (every public one):
//  - PersistReviewWalkthroughInputV1 (ConfigDict extra=forbid, frozen) → .strict().
//
// schema_version GOTCHA: bare Python `int = 1` (NOT Literal) → z.number().int().default(1)
// (any int accepted, default 1 — matches the sibling WalkthroughV1 treatment).
//
// UUID GOTCHA: review_id / installation_id are Pydantic uuid.UUID → model_dump(mode="json") emits
// the lowercase canonical form, matched by the Zod .transform(toLowerCase).
//
// walkthrough is a nested WalkthroughV1 — the sibling Zod schema is IMPORTED above, not redefined.
export const PersistReviewWalkthroughInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    review_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    installation_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    walkthrough: WalkthroughV1,
  })
  .strict();
export type PersistReviewWalkthroughInputV1 = z.infer<typeof PersistReviewWalkthroughInputV1>;
