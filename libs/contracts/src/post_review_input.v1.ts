import { z } from "zod";

import { AggregatedFindingsV1 } from "./aggregated_findings.v1.js";
import { PrMetaV1, WalkthroughV1 } from "./walkthrough.v1.js";

// Typed single-arg input envelope for the `post_review_results` activity (CLAUDE.md invariant 11 —
// exactly one positional Pydantic/Zod-model argument per Temporal activity; ADR-0047).
//
// The frozen Python `PostReviewActivity.post_review_results` (vendor/codemaster-py/codemaster/
// activities/post_review_results.py) is a MULTI-positional activity (`walkthrough, aggregated, pr_meta,
// head_sha, walkthrough_md, owner, repo_name, pr_number, run_id, review_id, changed_line_ranges`),
// pre-dating the ADR-0047 single-typed-input convention. The TS port introduces this envelope so the
// activity dispatch is positional-arg-free at the Temporal seam — consistent with the other ported
// activities (persist_review_findings.v1 etc.). It is NOT a parity-validated 1:1 of an existing Python
// contract (there is no Python `PostReviewInputV1`); it is the activity-input contract the port adds.
//
// Field shapes (read off `_do_post`'s actual keyword params):
//  - walkthrough:         WalkthroughV1               — the rendered walkthrough envelope (NOT directly
//                         used by `_do_post` beyond being threaded; the markdown body comes from
//                         walkthrough_md). Required cross-contract ref → ./walkthrough.v1.js.
//  - aggregated:          AggregatedFindingsV1        — the deduped/ranked findings tuple. Required.
//  - pr_meta:             PrMetaV1                    — pr_id (posted_reviews PK), installation_id, repo
//                         (metric labels). Required.
//  - head_sha:            str                         — commit_id for the GitHub review + deep links.
//  - walkthrough_md:      str                         — the rendered markdown the review body wraps.
//  - owner / repo_name:   str                         — GitHub repo coordinates (repo_name is the bare
//                         name, NOT "owner/name").
//  - pr_number:           int (ge=1)                  — the GitHub PR number.
//  - run_id / review_id:  uuid.UUID                   — the AD-4 stale-write-guard keys. review_id is the
//                         core.pull_request_reviews PK; run_id the candidate run. Lowercased UUID strings.
//  - changed_line_ranges: dict[str, tuple[tuple[int,int],...]] — per-file accepted hunk windows. JSON-safe
//                         (string keys). Modeled as Record<path, Array<[lo, hi]>>; each inner pair is a
//                         fixed-length [number, number] tuple.
//
// No float fields. UUIDs spelled lowercase so a Pydantic-lowercased dump round-trips through Zod's
// pass-through (PrMetaV1 already .transform(toLowerCase)s its own UUID members).
export const PostReviewInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    walkthrough: WalkthroughV1,
    aggregated: AggregatedFindingsV1,
    pr_meta: PrMetaV1,
    head_sha: z.string(),
    walkthrough_md: z.string(),
    owner: z.string().min(1),
    repo_name: z.string().min(1),
    pr_number: z.number().int().gte(1),
    run_id: z.string().uuid(),
    review_id: z.string().uuid(),
    // dict[str, tuple[tuple[int, int], ...]] — per-file accepted hunk windows. JSON-safe (string keys);
    // each inner pair is a fixed [lo, hi] int tuple.
    changed_line_ranges: z.record(
      z.string(),
      z.array(z.tuple([z.number().int(), z.number().int()])),
    ),
  })
  .strict();
export type PostReviewInputV1 = z.infer<typeof PostReviewInputV1>;
