import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { PostedReviewV1 } from "#contracts/posted_review.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `PostedReviewV1(**payload).model_dump(mode="json")`) and through
// Zod (`PostedReviewV1.parse(payload)`), then diff canonical JSON. Accept / reject must also agree.
// This follows the markdown_chunk.v1.parity template (Task 0.5).
const PY = "contracts.posted_review.v1";

// A valid DroppedClassificationV1 payload to embed in the dropped_classifications tuple field.
const DROPPED = { schema_version: 1, index: 7, eligibility_reason: "file_not_in_diff" };

describe("PostedReviewV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated INLINE_POSTED payload identically", async () => {
    const payload = {
      schema_version: 1,
      review_id: 12345,
      marker_comment_id: 67890,
      was_update: true,
      inline_comment_count: 3,
      comment_ids: [1, 2, 3],
      kept_finding_indices: [0, 2, 5],
      publication_outcome: "inline_posted",
      degradation_notes: ["note one", "note two"],
      dropped_classifications: [DROPPED],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PostedReviewV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults when optional fields are omitted", async () => {
    // Only the required fields (inline_comment_count) + the IFF-satisfying review_id are supplied;
    // every other field should default identically on both sides.
    const payload = { review_id: 42, inline_comment_count: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PostedReviewV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("validates the BODY_ONLY_POSTED outcome (review_id present) identically", async () => {
    const payload = {
      review_id: 99,
      inline_comment_count: 0,
      publication_outcome: "body_only_posted",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PostedReviewV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("validates the DEGRADED_UNPOSTED outcome (review_id null) identically", async () => {
    const payload = {
      review_id: null,
      inline_comment_count: 0,
      publication_outcome: "degraded_unposted",
      degradation_notes: ["both POSTs 422'd"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PostedReviewV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts a future schema_version (int default, NOT a literal) identically", async () => {
    const payload = { schema_version: 2, review_id: 7, inline_comment_count: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PostedReviewV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts multiple embedded dropped_classifications (with defaults) identically", async () => {
    const payload = {
      review_id: 1,
      inline_comment_count: 2,
      dropped_classifications: [
        { index: 0, eligibility_reason: "line_after_last_hunk" },
        { index: 200, eligibility_reason: "line_spans_hunks" },
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PostedReviewV1.parse(payload))).toBe(r.out);
  }, 30_000);

  // ---- IFF validator: both directions ------------------------------------------------------

  it("both REJECT DEGRADED_UNPOSTED with a non-null review_id (IFF direction 1)", async () => {
    const bad = {
      review_id: 5,
      inline_comment_count: 0,
      publication_outcome: "degraded_unposted",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => PostedReviewV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-degraded outcome with a null review_id (IFF direction 2)", async () => {
    const bad = {
      review_id: null,
      inline_comment_count: 0,
      publication_outcome: "inline_posted",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PostedReviewV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT the default-outcome path with a null review_id (default INLINE_POSTED)", async () => {
    // publication_outcome omitted → defaults INLINE_POSTED → review_id MUST be a positive int.
    const bad = { review_id: null, inline_comment_count: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PostedReviewV1.parse(bad)).toThrow();
  }, 30_000);

  // ---- numeric bounds ----------------------------------------------------------------------

  it("both REJECT review_id below the lower bound (review_id < 1)", async () => {
    const bad = { review_id: 0, inline_comment_count: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PostedReviewV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT marker_comment_id below the lower bound (marker_comment_id < 1)", async () => {
    const bad = { review_id: 1, marker_comment_id: 0, inline_comment_count: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PostedReviewV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a negative inline_comment_count (inline_comment_count < 0)", async () => {
    const bad = { review_id: 1, inline_comment_count: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PostedReviewV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required inline_comment_count", async () => {
    const bad = { review_id: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PostedReviewV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown publication_outcome value (enum mismatch)", async () => {
    const bad = { review_id: 1, inline_comment_count: 0, publication_outcome: "bogus_outcome" };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PostedReviewV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a nested dropped_classifications entry that violates its own bound (index > 200)", async () => {
    const bad = {
      review_id: 1,
      inline_comment_count: 0,
      dropped_classifications: [{ index: 201, eligibility_reason: "file_not_in_diff" }],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PostedReviewV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { review_id: 1, inline_comment_count: 0, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PostedReviewV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PostedReviewV1.parse(bad)).toThrow();
  }, 30_000);
});
