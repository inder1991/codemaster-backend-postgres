import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { PostReviewPlaceholderInput } from "#contracts/post_review_placeholder_input.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (the frozen
// PostReviewPlaceholderInput via the oracle) and through Zod, then diff canonical JSON. Accept/reject must
// also agree. Pins the Zod port against the Python BaseModel — including the bare-int pr_number (NO ge=1).
//
// PER-REVIEW ROUTING DIVERGENCE (ADR — remove the CODEMASTER_GITHUB_INSTALLATION_ID env pin): the TS
// contract carries a numeric `github_installation_id` the frozen Python model does NOT (the Python pinned
// the id at worker construction; the port threads it per-review through the activity input). So the oracle
// is called with the Python-shaped payload (no github_installation_id), the Zod contract is parsed with the
// same payload PLUS the numeric id, and the canonical diff STRIPS that one field — every SHARED field stays
// byte-identical to Python. A dedicated test pins that the TS-only field round-trips.
const PY = "codemaster.activities.post_review_placeholder";
const CALLABLE = "PostReviewPlaceholderInput";

const GH_ID = 4815162342;

const VALID = {
  schema_version: 1,
  pr_id: "11111111-1111-1111-1111-111111111111",
  run_id: "22222222-2222-2222-2222-222222222222",
  review_id: "33333333-3333-3333-3333-333333333333",
  installation_id: "44444444-4444-4444-4444-444444444444",
  owner: "test-org",
  repo_name: "test-repo",
  pr_number: 42,
};

// Parse a Python-shaped payload through the TS contract, supplying the TS-only numeric id the Python model
// lacks. The required field would otherwise reject the Python-shaped payload.
function zodParse(pythonShaped: Record<string, unknown>): Record<string, unknown> {
  return PostReviewPlaceholderInput.parse({ ...pythonShaped, github_installation_id: GH_ID }) as Record<
    string,
    unknown
  >;
}

// Canonical JSON of the SHARED fields only (drop the TS-only github_installation_id the oracle never had).
function sharedCanonical(parsed: Record<string, unknown>): string {
  const shared = { ...parsed };
  delete shared.github_installation_id;
  return canonicalize(shared);
}

describe("PostReviewPlaceholderInput parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically (shared fields)", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: VALID });
    expect(r.ok, r.err).toBe(true);
    expect(sharedCanonical(zodParse(VALID))).toBe(r.out);
  }, 30_000);

  it("threads the TS-only github_installation_id (absent from the frozen Python — per-review routing ADR)", () => {
    expect(zodParse(VALID).github_installation_id).toBe(GH_ID);
  });

  it("applies the same default (schema_version=1) when omitted", async () => {
    const payload = {
      pr_id: VALID.pr_id,
      run_id: VALID.run_id,
      review_id: VALID.review_id,
      installation_id: VALID.installation_id,
      owner: VALID.owner,
      repo_name: VALID.repo_name,
      pr_number: VALID.pr_number,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(sharedCanonical(zodParse(payload))).toBe(r.out);
  }, 30_000);

  it("both ACCEPT a non-positive pr_number (bare int, NO ge=1)", async () => {
    // Distinctive shape vs PostReviewInputV1.pr_number (ge=1): the placeholder field is a BARE Python int,
    // so 0 is valid on BOTH sides. This pins the port against accidentally importing the ge=1 constraint.
    const payload = { ...VALID, pr_number: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(sharedCanonical(zodParse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT schema_version != 1 (Literal[1])", async () => {
    const bad = { ...VALID, schema_version: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => zodParse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-UUID pr_id", async () => {
    const bad = { ...VALID, pr_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => zodParse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (review_id)", async () => {
    const bad = {
      schema_version: VALID.schema_version,
      pr_id: VALID.pr_id,
      run_id: VALID.run_id,
      installation_id: VALID.installation_id,
      owner: VALID.owner,
      repo_name: VALID.repo_name,
      pr_number: VALID.pr_number,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => zodParse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...VALID, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => zodParse(bad)).toThrow();
  }, 30_000);
});
