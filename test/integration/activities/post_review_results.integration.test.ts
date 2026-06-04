import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import {
  doPost,
  markerFor,
  PostReviewTransientError,
} from "#backend/activities/post_review_results.activity.js";

import {
  type CreatedReviewV1,
  type GhReviewClient,
  type ReviewComment,
} from "#backend/integrations/github/review_client.js";
import { GitHubUnprocessableError } from "#backend/integrations/github/api_client.js";
import { StaleWriteError } from "#backend/domain/stale_write_guard.js";

import { disposeAllPools } from "#platform/db/database.js";
import { FakeClock } from "#platform/clock.js";

import { type PostReviewInputV1 } from "#contracts/post_review_input.v1.js";
import { type PrMetaV1, type WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import { type AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { type ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { type PostedReviewV1 } from "#contracts/posted_review.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test for the `post_review_results` doPost 2-phase atomic-claim state machine,
// against a DISPOSABLE Postgres (squashed baseline migrated; core.posted_reviews + the IFF CHECK
// present). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so
// validate-fast stays green without a DB. NEVER touches any other DB. Every test seeds a fresh FK chain
// (pull_request_reviews[current_run_id] → review_runs) for the AD-4 stale-write guard, plus a standalone
// core.posted_reviews row keyed by pr_meta.pr_id; all rows are cleaned up per-test.

// 2099 keeps any FakeClock-driven audit emit out of a missing range partition (same convention as the
// stale-write-guard integration test). The doPost age computation uses Postgres now(), NOT this clock.
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-03-04T05:06:07.000Z") });

let pool: Pool;
let db: Kysely<Record<string, never>>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
  db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy();
  // The doPost path opens the ADR-0062 shared pool for INTEGRATION_DSN; end it so the run leaks no socket.
  await disposeAllPools();
});

/** Deterministic-enough RFC4122 v4 UUID for fixtures (NOT security-sensitive). */
function newUuid(): string {
  const h = createHash("sha1")
    .update(Buffer.from(`${process.hrtime.bigint()}-${randomInt(0, 1 << 30)}`, "utf-8"))
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x40, 6); // version 4
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hx = b.toString("hex");
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20, 32)}`;
}

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

// ─── FK-chain seed (1:1 in shape with the stale-write-guard integration test) ───────────────────

type Seed = {
  installationId: string;
  reviewId: string;
  /** The authoritative run pointed at by pull_request_reviews.current_run_id. */
  currentRunId: string;
  /** A second valid run row used as the "incoming stale" run for the superseded-run case. */
  staleRunId: string;
  /** core.posted_reviews PK (the PR's id) — DISTINCT from reviewId. */
  prId: string;
};

/**
 * Seed the FK chain assertCurrentRun needs:
 *   core.pull_request_reviews (review_id PK; provider/repo_id/pr_number/provider_pr_id NOT NULL;
 *     current_run_id → review_runs ON DELETE SET NULL) → TWO core.review_runs rows (run_id PK;
 *     review_id FK RESTRICT; trigger_type CHECK), one of which becomes current_run_id.
 * core.posted_reviews has NO FK — pr_id is a standalone PK distinct from review_id.
 *
 * `currentNull=true` leaves current_run_id NULL (the missing-pointer mismatch); then the guard would
 * reject — used by the superseded-run case via the stale run.
 */
async function seedTenant(opts: { currentNull?: boolean } = {}): Promise<Seed> {
  const installationId = newUuid();
  const reviewId = newUuid();
  const currentRunId = newUuid();
  const staleRunId = newUuid();
  const prId = newUuid();
  const repoId = uniqueBigint();
  const prNumber = (uniqueBigint() % 9999) + 1;

  await pool.query(
    `INSERT INTO core.pull_request_reviews
       (review_id, provider, repo_id, pr_number, provider_pr_id, status, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, 'open', NULL)`,
    [reviewId, repoId, prNumber, `pr-${repoId}-${prNumber}`],
  );
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type, lifecycle_state)
     VALUES ($1, $2, 'pr_opened', 'PENDING')`,
    [currentRunId, reviewId],
  );
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type, lifecycle_state)
     VALUES ($1, $2, 'pr_synchronize', 'PENDING')`,
    [staleRunId, reviewId],
  );
  if (!opts.currentNull) {
    await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = $1 WHERE review_id = $2`, [
      currentRunId,
      reviewId,
    ]);
  }
  return { installationId, reviewId, currentRunId, staleRunId, prId };
}

async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM core.posted_reviews WHERE pr_id = $1`, [seed.prId]);
  await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1 OR run_id = $2`, [
    seed.currentRunId,
    seed.staleRunId,
  ]);
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = NULL WHERE review_id = $1`, [
    seed.reviewId,
  ]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1 OR run_id = $2`, [
    seed.currentRunId,
    seed.staleRunId,
  ]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
}

/** Read the persisted core.posted_reviews row state (github_review_id + publication_outcome). */
async function readPostedRow(
  prId: string,
): Promise<{ github_review_id: string | null; publication_outcome: string } | undefined> {
  const res = await pool.query<{ github_review_id: string | null; publication_outcome: string }>(
    `SELECT github_review_id, publication_outcome FROM core.posted_reviews WHERE pr_id = $1`,
    [prId],
  );
  return res.rows[0];
}

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────────

const FILE_IN_DIFF = "src/app.ts";

function finding(overrides: Partial<ReviewFindingV1> = {}): ReviewFindingV1 {
  return {
    schema_version: 1,
    file: FILE_IN_DIFF,
    start_line: 10,
    end_line: 10,
    severity: "issue",
    category: "bug",
    title: "Null deref",
    body: "Possible null dereference here.",
    suggestion: null,
    confidence: 0.9,
    sources: [],
    scope: "chunk_observed",
    evidence_refs: [],
    ...overrides,
  };
}

function makeInput(args: {
  seed: Seed;
  findings: ReadonlyArray<ReviewFindingV1>;
  changedLineRanges?: Record<string, Array<[number, number]>>;
}): PostReviewInputV1 {
  const prMeta: PrMetaV1 = {
    pr_id: args.seed.prId,
    installation_id: args.seed.installationId,
    repo: "octo/app",
    pr_title: "Add feature",
    pr_description: "desc",
    author_login: null,
    draft: false,
    base_ref: null,
    head_ref: null,
    opened_at: null,
  };
  const walkthrough: WalkthroughV1 = {
    schema_version: 1,
    tldr: "Adds a feature.",
    file_rows: [],
    configuration_section_md: "",
    degradation_note: null,
    truncated: false,
    suggested_reviewers: [],
    linked_issues: [],
    sanitization_event: null,
  };
  const aggregated: AggregatedFindingsV1 = {
    schema_version: 1,
    findings: [...args.findings],
    dedupe_stats: {
      input_count: args.findings.length,
      exact_dropped: 0,
      semantic_merged: 0,
      capped: 0,
      semantic_skipped: false,
    },
    policy_revision: 0,
  };
  return {
    schema_version: 1,
    walkthrough,
    aggregated,
    pr_meta: prMeta,
    head_sha: "abc123",
    walkthrough_md: "## Walkthrough\n\nAdds a feature.",
    owner: "octo",
    repo_name: "app",
    pr_number: 7,
    run_id: args.seed.currentRunId,
    review_id: args.seed.reviewId,
    changed_line_ranges: args.changedLineRanges ?? { [FILE_IN_DIFF]: [[1, 100]] },
  };
}

// ─── scripted stub GhReviewClient ────────────────────────────────────────────────────────────────

type StubScript = {
  /** Sequential outcomes for create_review calls: a CreatedReviewV1, or a 422 sentinel. */
  createReview?: Array<CreatedReviewV1 | "422">;
};

type StubCalls = {
  createReview: Array<{ comments: ReadonlyArray<ReviewComment> }>;
  updateReview: Array<{ reviewId: number; body: string }>;
  findExistingReviewByMarker: number;
};

function makeStub(script: StubScript): { client: GhReviewClient; calls: StubCalls } {
  const createSeq = [...(script.createReview ?? [])];
  const calls: StubCalls = { createReview: [], updateReview: [], findExistingReviewByMarker: 0 };
  const client: GhReviewClient = {
    async findExistingReviewByMarker() {
      calls.findExistingReviewByMarker += 1;
      return null;
    },
    async createReview({ comments }) {
      calls.createReview.push({ comments });
      const next = createSeq.shift();
      if (next === undefined) {
        throw new Error("stub createReview called more times than scripted");
      }
      if (next === "422") {
        throw new GitHubUnprocessableError("simulated 422 inline-comment-position rejection");
      }
      return next;
    },
    async updateReview({ reviewId, body }) {
      calls.updateReview.push({ reviewId, body });
    },
    async createIssueComment() {
      throw new Error("not used in this test");
    },
    async listIssueComments() {
      return [];
    },
    async deleteIssueComment() {
      // no-op
    },
  };
  return { client, calls };
}

// ─── tests ───────────────────────────────────────────────────────────────────────────────────────

describeDb("post_review_results doPost (integration, disposable PG)", () => {
  let seed: Seed;

  beforeEach(async () => {
    seed = await seedTenant();
  });

  afterEach(async () => {
    await cleanupTenant(seed);
  });

  it("WON happy inline path: create accepts comments → INLINE_POSTED, row github_review_id set", async () => {
    const created: CreatedReviewV1 = { reviewId: 4242, commentIds: [1001] };
    const { client, calls } = makeStub({ createReview: [created] });
    const input = makeInput({ seed, findings: [finding()] });

    const result: PostedReviewV1 = await doPost(input, {
      ghClient: client,
      dsn: INTEGRATION_DSN!,
      clock: FIXED_CLOCK,
    });

    expect(result.publication_outcome).toBe("inline_posted");
    expect(result.review_id).toBe(4242);
    expect(result.was_update).toBe(false);
    expect(result.inline_comment_count).toBe(1);
    expect(result.comment_ids).toEqual([1001]);
    expect(result.kept_finding_indices).toEqual([0]);
    // The create_review carried exactly one inline comment (the kept finding).
    expect(calls.createReview.length).toBe(1);
    expect(calls.createReview[0]!.comments.length).toBe(1);
    expect(calls.updateReview.length).toBe(0);

    const row = await readPostedRow(seed.prId);
    expect(row).toBeDefined();
    expect(Number(row!.github_review_id)).toBe(4242);
    expect(row!.publication_outcome).toBe("inline_posted");
  });

  it("WON body-only: create 422 then body-only ok → BODY_ONLY_POSTED, row review_id set", async () => {
    const bodyOnlyCreated: CreatedReviewV1 = { reviewId: 5555, commentIds: [] };
    const { client, calls } = makeStub({ createReview: ["422", bodyOnlyCreated] });
    const input = makeInput({ seed, findings: [finding()] });

    const result = await doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

    expect(result.publication_outcome).toBe("body_only_posted");
    expect(result.review_id).toBe(5555);
    expect(result.inline_comment_count).toBe(0);
    expect(result.comment_ids).toEqual([]);
    expect(result.kept_finding_indices).toEqual([0]);
    expect(result.degradation_notes).toContain("github_422_on_inline_post");
    // Two create calls: first with inline comments, second body-only (comments=[]).
    expect(calls.createReview.length).toBe(2);
    expect(calls.createReview[0]!.comments.length).toBe(1);
    expect(calls.createReview[1]!.comments.length).toBe(0);

    const row = await readPostedRow(seed.prId);
    expect(Number(row!.github_review_id)).toBe(5555);
    expect(row!.publication_outcome).toBe("body_only_posted");
  });

  it("WON double-422: → DEGRADED_UNPOSTED, row github_review_id stays NULL, NO raise", async () => {
    const { client, calls } = makeStub({ createReview: ["422", "422"] });
    const input = makeInput({ seed, findings: [finding()] });

    const result = await doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

    expect(result.publication_outcome).toBe("degraded_unposted");
    expect(result.review_id).toBeNull();
    expect(result.kept_finding_indices).toEqual([0]);
    expect(result.degradation_notes).toContain("github_422_on_body_only_retry");
    expect(calls.createReview.length).toBe(2);

    const row = await readPostedRow(seed.prId);
    expect(row).toBeDefined();
    expect(row!.github_review_id).toBeNull();
    expect(row!.publication_outcome).toBe("degraded_unposted");
  });

  it("comment_ids mismatch: create returns fewer ids than kept findings → RAISES", async () => {
    // Two kept findings (both single-line in-window) but GitHub returns only one comment id.
    const created: CreatedReviewV1 = { reviewId: 6001, commentIds: [9001] };
    const { client } = makeStub({ createReview: [created] });
    const input = makeInput({
      seed,
      findings: [finding({ start_line: 10, end_line: 10 }), finding({ start_line: 20, end_line: 20 })],
    });

    await expect(
      doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK }),
    ).rejects.toThrow(/comment_ids length mismatch/);

    // The row was claimed (Phase-1 INSERT committed) and Phase-2 never ran → stays at the placeholder.
    const row = await readPostedRow(seed.prId);
    expect(row).toBeDefined();
    expect(row!.github_review_id).toBeNull();
    expect(row!.publication_outcome).toBe("degraded_unposted");
  });

  it("LOST non-null: pre-seeded row with github_review_id → updateReview dispatched + inherited outcome", async () => {
    // Pre-seed a winning row (body_only_posted is a non-INLINE inherited outcome to prove no hardcode).
    await pool.query(
      `INSERT INTO core.posted_reviews (pr_id, marker, github_review_id, publication_outcome, posted_at)
       VALUES ($1, $2, $3, 'body_only_posted', now())`,
      [seed.prId, markerFor(seed.prId), 7777],
    );
    const { client, calls } = makeStub({});
    const input = makeInput({ seed, findings: [finding()] });

    const result = await doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

    expect(result.was_update).toBe(true);
    expect(result.review_id).toBe(7777);
    // Inherited from the row's persisted publication_outcome — NOT hardcoded inline_posted.
    expect(result.publication_outcome).toBe("body_only_posted");
    expect(result.inline_comment_count).toBe(1); // len(inline_payload) for the kept finding
    expect(calls.createReview.length).toBe(0); // lost the claim → no create
    expect(calls.updateReview.length).toBe(1);
    expect(calls.updateReview[0]!.reviewId).toBe(7777);

    // The lost-claim update path does NOT mutate the row's columns.
    const row = await readPostedRow(seed.prId);
    expect(Number(row!.github_review_id)).toBe(7777);
    expect(row!.publication_outcome).toBe("body_only_posted");
  });

  it("LOST in-flight: pre-seeded NULL row within window → RAISES PostReviewTransientError", async () => {
    // A fresh NULL row (posted_at = now(), age ~0 < window) = a winner still in flight.
    await pool.query(
      `INSERT INTO core.posted_reviews (pr_id, marker, github_review_id, publication_outcome, posted_at)
       VALUES ($1, $2, NULL, 'degraded_unposted', now())`,
      [seed.prId, markerFor(seed.prId)],
    );
    const { client, calls } = makeStub({});
    const input = makeInput({ seed, findings: [finding()] });

    await expect(
      doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK }),
    ).rejects.toBeInstanceOf(PostReviewTransientError);

    expect(calls.createReview.length).toBe(0);
    expect(calls.updateReview.length).toBe(0);
    // Row is untouched (NULL preserved).
    const row = await readPostedRow(seed.prId);
    expect(row!.github_review_id).toBeNull();
  });

  it("LOST past-window: NULL row past window → DEGRADED_UNPOSTED inherited, no mutation", async () => {
    // posted_at well in the past so age >= IN_FLIGHT_WINDOW (default 300s) = terminal-degraded.
    await pool.query(
      `INSERT INTO core.posted_reviews (pr_id, marker, github_review_id, publication_outcome, posted_at)
       VALUES ($1, $2, NULL, 'degraded_unposted', now() - interval '1 hour')`,
      [seed.prId, markerFor(seed.prId)],
    );
    const { client, calls } = makeStub({});
    const input = makeInput({ seed, findings: [finding()] });

    const result = await doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

    expect(result.publication_outcome).toBe("degraded_unposted");
    expect(result.review_id).toBeNull();
    expect(result.kept_finding_indices).toEqual([0]);
    expect(result.degradation_notes).toContain("prior_workflow_terminal_uncertainty");
    expect(calls.createReview.length).toBe(0);
    expect(calls.updateReview.length).toBe(0);
    // No mutation: the row stays NULL / degraded_unposted.
    const row = await readPostedRow(seed.prId);
    expect(row!.github_review_id).toBeNull();
    expect(row!.publication_outcome).toBe("degraded_unposted");
  });

  it("SUPERSEDED run: current_run_id != runId → assertCurrentRun RAISES StaleWriteError, no claim", async () => {
    // Drive doPost with the STALE run id while current_run_id points at currentRunId.
    const { client, calls } = makeStub({});
    const input: PostReviewInputV1 = { ...makeInput({ seed, findings: [finding()] }), run_id: seed.staleRunId };

    await expect(
      doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK }),
    ).rejects.toBeInstanceOf(StaleWriteError);

    expect(calls.createReview.length).toBe(0);
    // The Phase-1 claim transaction rolled back on the guard violation → NO posted_reviews row exists.
    const row = await readPostedRow(seed.prId);
    expect(row).toBeUndefined();
  });

  it("findings outside the diff are dropped: a single out-of-window finding → 0 inline comments", async () => {
    const created: CreatedReviewV1 = { reviewId: 8001, commentIds: [] };
    const { client, calls } = makeStub({ createReview: [created] });
    // The finding is on a file NOT in changed_line_ranges → dropped FILE_NOT_IN_DIFF.
    const input = makeInput({
      seed,
      findings: [finding({ file: "not/in/diff.ts" })],
      changedLineRanges: { [FILE_IN_DIFF]: [[1, 100]] },
    });

    const result = await doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

    expect(result.publication_outcome).toBe("inline_posted");
    expect(result.inline_comment_count).toBe(0);
    expect(result.kept_finding_indices).toEqual([]);
    expect(result.dropped_classifications.length).toBe(1);
    expect(result.dropped_classifications[0]!.eligibility_reason).toBe("file_not_in_diff");
    expect(calls.createReview[0]!.comments.length).toBe(0);
  });
});
