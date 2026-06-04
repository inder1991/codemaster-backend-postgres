// Real-DB integration test for FixPromptRepo (Phase-1 data layer port of the frozen Python
// vendor/codemaster-py/codemaster/domain/repos/fix_prompt_repo.py).
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (the shared describeDb gate) — pointing at a
// disposable Postgres with migrations applied. SKIPS otherwise so validate-fast stays green
// without a DB. NEVER hard-defaults the DSN.
//
// Coverage (round-trips every public method of the frozen Python repo, method-for-method):
//  - persist + get_by_review_id round-trip: read-back equals the persisted record.
//  - upsert/conflict idempotency: a second persist on the same review_id UPDATEs in place
//    (ON CONFLICT (review_id) DO UPDATE), no duplicate row, latest values win.
//  - tenant isolation: get_by_review_id scoped to installation A does NOT see B's row even
//    when the review_id PK collides across tenants (the WHERE installation_id filter + the
//    TenancyPlugin both enforce this).
//  - absent read returns null.
//  - field fidelity: enum generation_mode, integer finding_count, boolean truncated, and the
//    timestamptz generated_at all round-trip faithfully.
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FixPromptRepo } from "#backend/domain/repos/fix_prompt_repo.js";
import { FixPromptV1 } from "#contracts/fix_prompt.v1.js";

import { describeDb, INTEGRATION_DSN } from "../../_db.js";

// Unique tenant per top-level run so parallel/repeated runs never collide; per-test review_ids keep
// rows isolated within the run. We still DELETE our rows in afterAll for hygiene.
const INSTALLATION_A = randomUUID();
const INSTALLATION_B = randomUUID();

// The repo reads `generated_at` back as a canonical microsecond-precision `…Z` RFC3339 string (the
// timestamptz column always materializes 6 fractional digits via to_char). The contract validates
// variable fractional digits on the wire, so an input like "…T00:00:00Z" persists+reads as
// "…T00:00:00.000000Z". This helper normalizes an expected record to the repo's read-back form so
// `.toEqual` compares against the truth Postgres actually stored.
const toCanonicalUtcMicros = (iso: string): string => {
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored, no nested/ambiguous quantifiers (no ReDoS)
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/.exec(iso);
  if (m === null) {
    throw new Error(`unexpected datetime form: ${iso}`);
  }
  const frac = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
  return `${m[1]}.${frac}Z`;
};

const asStored = (record: FixPromptV1): FixPromptV1 => ({
  ...record,
  generated_at: toCanonicalUtcMicros(record.generated_at),
});

describeDb("FixPromptRepo (integration)", () => {
  // Guard pool creation on the DSN so the module never attempts a live connection when SKIPPED.
  const pool = new Pool({ connectionString: INTEGRATION_DSN });
  const repo = new FixPromptRepo({ pool });

  beforeAll(async () => {
    // Sanity: confirm the disposable DB is reachable + the target table exists before asserting.
    await pool.query("SELECT 1 FROM core.fix_prompts WHERE false");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM core.fix_prompts WHERE installation_id = ANY($1::uuid[])", [
      [INSTALLATION_A, INSTALLATION_B],
    ]);
    // repo.close() disposes the Kysely wrapper, which ends the injected pool (Kysely owns the pool
    // it was given). No separate pool.end() — that would double-end (the sibling repos' convention).
    await repo.close();
  });

  const makeRecord = (overrides: Partial<FixPromptV1> = {}): FixPromptV1 =>
    FixPromptV1.parse({
      schema_version: 1,
      review_id: randomUUID(),
      prompt: "## Fix these\n\n- bullet one\n- bullet two\n",
      generation_mode: "llm",
      finding_count: 3,
      truncated: false,
      generated_at: "2026-06-04T12:34:56.123456Z",
      ...overrides,
    });

  it("persists then reads back an equal record (round-trip)", async () => {
    const record = makeRecord();
    await repo.persist(record, { installationId: INSTALLATION_A });

    const got = await repo.getByReviewId(record.review_id, { installationId: INSTALLATION_A });
    expect(got).not.toBeNull();
    // schema_version is the contract default (not persisted as a column); compare the persisted fields.
    expect(got).toEqual(asStored(record));
  });

  it("returns null for an absent review", async () => {
    const got = await repo.getByReviewId(randomUUID(), { installationId: INSTALLATION_A });
    expect(got).toBeNull();
  });

  it("upserts idempotently on conflicting review_id (ON CONFLICT DO UPDATE, no dup row)", async () => {
    const reviewId = randomUUID();
    const first = makeRecord({
      review_id: reviewId,
      prompt: "first",
      finding_count: 1,
      truncated: false,
      generation_mode: "llm",
    });
    const second = makeRecord({
      review_id: reviewId,
      prompt: "second — replaces first",
      finding_count: 9,
      truncated: true,
      generation_mode: "deterministic_fallback",
      generated_at: "2026-06-05T00:00:00Z",
    });

    await repo.persist(first, { installationId: INSTALLATION_A });
    await repo.persist(second, { installationId: INSTALLATION_A });

    const got = await repo.getByReviewId(reviewId, { installationId: INSTALLATION_A });
    expect(got).toEqual(asStored(second));

    // Exactly one physical row survives the upsert.
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM core.fix_prompts WHERE review_id = $1",
      [reviewId],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("isolates tenants: A cannot read B's row even on a colliding review_id", async () => {
    const reviewId = randomUUID();
    const aRecord = makeRecord({ review_id: reviewId, prompt: "tenant A prompt", finding_count: 2 });
    const bReviewId = randomUUID();
    const bRecord = makeRecord({ review_id: bReviewId, prompt: "tenant B prompt", finding_count: 5 });

    await repo.persist(aRecord, { installationId: INSTALLATION_A });
    await repo.persist(bRecord, { installationId: INSTALLATION_B });

    // A reading B's review_id sees nothing (different tenant).
    expect(await repo.getByReviewId(bReviewId, { installationId: INSTALLATION_A })).toBeNull();
    // B reading A's review_id sees nothing.
    expect(await repo.getByReviewId(reviewId, { installationId: INSTALLATION_B })).toBeNull();
    // Each tenant reads only its own.
    expect(await repo.getByReviewId(reviewId, { installationId: INSTALLATION_A })).toEqual(
      asStored(aRecord),
    );
    expect(await repo.getByReviewId(bReviewId, { installationId: INSTALLATION_B })).toEqual(
      asStored(bRecord),
    );
  });

  it("round-trips every field faithfully (enum / int / bool / timestamptz)", async () => {
    const record = makeRecord({
      generation_mode: "deterministic_fallback",
      finding_count: 0,
      truncated: true,
      generated_at: "2026-01-02T03:04:05.000007Z",
    });
    await repo.persist(record, { installationId: INSTALLATION_A });

    const got = await repo.getByReviewId(record.review_id, { installationId: INSTALLATION_A });
    expect(got).not.toBeNull();
    expect(got?.generation_mode).toBe("deterministic_fallback");
    expect(got?.finding_count).toBe(0);
    expect(got?.truncated).toBe(true);
    // microsecond precision survives the timestamptz round-trip.
    expect(got?.generated_at).toBe("2026-01-02T03:04:05.000007Z");
  });
});
