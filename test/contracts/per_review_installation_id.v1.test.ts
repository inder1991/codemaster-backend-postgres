import { describe, expect, it } from "vitest";

import { CloneRepoIntoWorkspaceInput } from "#contracts/clone_repo_into_workspace_input.v1.js";
import { DeleteReviewPlaceholderInput } from "#contracts/delete_review_placeholder_input.v1.js";
import { GenerateFixPromptInputV1 } from "#contracts/generate_fix_prompt.v1.js";
import { PostCheckRunInputV1 } from "#contracts/posted_check_run.v1.js";
import { PostReviewInputV1 } from "#contracts/post_review_input.v1.js";
import { PostReviewPlaceholderInput } from "#contracts/post_review_placeholder_input.v1.js";
import { UpdatePrDescriptionInputV1 } from "#contracts/update_pr_description.v1.js";

// Per-review GitHub installation routing (ADR — remove the CODEMASTER_GITHUB_INSTALLATION_ID env pin).
// Every GitHub-touching activity input now carries the NUMERIC github_installation_id (the per-PR GitHub
// App installation id the activity mints its token for) so one worker pool serves all orgs — the id is
// threaded per-review through the activity input, NOT read off a pod-wide env var.
//
// Uniform field shape across all seven contracts: z.number().int().gte(0).nullable().default(null).
//   - NULLABLE — faithful to the workflow payload's nullable github_installation_id; the receiving activity
//     enforces presence at runtime (the clone fail-closes; the GitHub posts skip/guard) rather than the
//     contract rejecting null. A null-id review can never produce a false-clean review because the clone
//     fail-closes — the bug class is eliminated at the activity boundary, not detected late.
//   - .default(null) keeps the KEY required at construction (z.infer carries the key), so every dispatch
//     site MUST thread the per-review id explicitly — a forgotten site fails to compile (no silent omission
//     of the env-pin replacement).
//
// These tests introspect each contract's field schema in isolation (.shape) so the field's existence +
// numeric constraints are pinned WITHOUT hand-building the heavy nested envelopes; the full-envelope
// round-trip (and the strip-the-diverged-field parity diff vs the frozen Python oracle) is covered by the
// per-contract .parity.test.ts files.

const CONTRACTS = [
  ["PostReviewInputV1", PostReviewInputV1],
  ["PostCheckRunInputV1", PostCheckRunInputV1],
  ["PostReviewPlaceholderInput", PostReviewPlaceholderInput],
  ["DeleteReviewPlaceholderInput", DeleteReviewPlaceholderInput],
  ["UpdatePrDescriptionInputV1", UpdatePrDescriptionInputV1],
  ["GenerateFixPromptInputV1", GenerateFixPromptInputV1],
  ["CloneRepoIntoWorkspaceInput", CloneRepoIntoWorkspaceInput],
] as const;

describe("per-review github_installation_id field (nullable numeric, default null)", () => {
  for (const [name, schema] of CONTRACTS) {
    describe(name, () => {
      const field = schema.shape.github_installation_id;

      it("is present on the contract shape", () => {
        expect(field).toBeDefined();
      });

      it("accepts a non-negative integer", () => {
        expect(field.safeParse(4815162342).success).toBe(true);
        expect(field.safeParse(0).success).toBe(true);
      });

      it("accepts null and defaults to null when omitted", () => {
        expect(field.safeParse(null).success).toBe(true);
        expect(field.parse(undefined)).toBe(null);
      });

      it("rejects negative and float", () => {
        expect(field.safeParse(-1).success).toBe(false);
        expect(field.safeParse(1.5).success).toBe(false);
      });
    });
  }
});
