// W3.1 (D4) — durable comment_ids on core.posted_reviews + lost-claim recovery + repair-needed metric.
//
// The won-claim path persists `github_review_id` AND `comment_ids`; a crash-then-re-run loses the claim
// and the lost-claim path must return the STORED `comment_ids` (NOT `[]`) so inline lifecycle
// finalization works on the re-run. A posted review whose stored `comment_ids` is empty BUT whose input
// still carries kept findings emits `codemaster_posted_reviews_comment_ids_repair_needed_total` (D4's
// repair signal).
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise. NEVER touches any
// other DB. Every test seeds a fresh FK chain (pull_request_reviews[current_run_id] → review_runs) for
// the AD-4 stale-write guard + a standalone core.posted_reviews row keyed by pr_meta.pr_id; all rows are
// cleaned up per-test.
//
// COUNTER-TIMING GOTCHA (verified empirically; same as chunk_response_parser.counters.test.ts): the
// activity caches its Counter instruments at MODULE scope (created once at import) per the metrics-seam
// convention. An OTel counter created BEFORE a MeterProvider is registered binds to the no-op meter and
// never records to a later-registered provider. So the in-memory provider is registered in `beforeAll`
// and the activity module is DYNAMICALLY IMPORTED afterward, so its module-scope counters (including the
// new repair-needed counter) bind to the in-memory provider.
import { createHash, randomInt } from "node:crypto";

import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { disposeAllPools } from "#platform/db/database.js";
import { FakeClock } from "#platform/clock.js";

import { type PostReviewInputV1 } from "#contracts/post_review_input.v1.js";
import { type PrMetaV1, type WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import { type AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { type ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { type PostedReviewV1 } from "#contracts/posted_review.v1.js";

import {
  type CreatedReviewV1,
  type GhReviewClient,
  type ReviewComment,
} from "#backend/integrations/github/review_client.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// 2099 keeps any FakeClock-driven audit emit out of a missing range partition (same convention as the
// post_review_results integration test). The doPost age computation uses Postgres now(), NOT this clock.
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-03-04T05:06:07.000Z") });

// Dynamically-imported activity surface (see COUNTER-TIMING GOTCHA above). Hand-written structural types
// so we never statically import the module (which would eagerly bind its module-scope counters to the
// no-op meter BEFORE the provider is registered).
type DoPost = (
  input: PostReviewInputV1,
  deps: {
    ghClient: GhReviewClient;
    dsn: string;
    clock?: FakeClock;
    inFlightWindowSeconds?: number;
  },
) => Promise<PostedReviewV1>;
type MarkerFor = (prId: string) => string;

let doPost: DoPost;
let markerFor: MarkerFor;

let pool: Pool;
let exporter: InMemoryMetricExporter;
let provider: MeterProvider;

const REPAIR_NEEDED_NAME = "codemaster_posted_reviews_comment_ids_repair_needed_total";

beforeAll(async () => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool / provider against an undefined DSN
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });

  // DELTA temporality (not CUMULATIVE) so each forceFlush reports only the adds SINCE the last
  // collection — combined with exporter.reset() in beforeEach, every test asserts EXACTLY its own
  // counter adds (no cross-test running-total accumulation).
  exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 2_147_483_647 });
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  // Dynamic import AFTER provider registration so the module-scope counters bind to the real meter.
  ({ doPost, markerFor } = await import("#backend/activities/post_review_results.activity.js"));
});

afterAll(async () => {
  await provider?.shutdown();
  metrics.disable(); // reset the process-global provider so other test files start clean.
  // The doPost path opens the ADR-0062 shared pool for INTEGRATION_DSN; end it so the run leaks no socket.
  await disposeAllPools();
});

beforeEach(() => {
  // Drop any prior export batches so `sumFor` sees only this test's flush.
  exporter?.reset();
});

/** Every data point of `name` (which carries no labels), across all collected metrics. */
function pointsFor(name: string): Array<DataPoint<number>> {
  const out: Array<DataPoint<number>> = [];
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === name) {
          for (const dp of m.dataPoints as Array<DataPoint<number>>) {
            out.push(dp);
          }
        }
      }
    }
  }
  return out;
}

/** Sum the value of the (label-less) counter `name` across the reset-then-single-flush batches. */
function sumFor(name: string): number {
  return pointsFor(name).reduce((acc, dp) => acc + dp.value, 0);
}

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

// ─── FK-chain seed (1:1 in shape with the post_review_results integration test) ─────────────────

type Seed = {
  installationId: string;
  reviewId: string;
  currentRunId: string;
  prId: string;
};

async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const reviewId = newUuid();
  const currentRunId = newUuid();
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
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = $1 WHERE review_id = $2`, [
    currentRunId,
    reviewId,
  ]);
  return { installationId, reviewId, currentRunId, prId };
}

async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM core.posted_reviews WHERE pr_id = $1`, [seed.prId]);
  await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1`, [seed.currentRunId]);
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = NULL WHERE review_id = $1`, [
    seed.reviewId,
  ]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [seed.currentRunId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
}

/** Read the persisted core.posted_reviews row state (github_review_id + publication_outcome + comment_ids). */
async function readPostedRow(prId: string): Promise<
  | {
      github_review_id: string | null;
      publication_outcome: string;
      comment_ids: Array<number>;
    }
  | undefined
> {
  const res = await pool.query<{
    github_review_id: string | null;
    publication_outcome: string;
    comment_ids: Array<number>;
  }>(
    `SELECT github_review_id, publication_outcome, comment_ids FROM core.posted_reviews WHERE pr_id = $1`,
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
    github_installation_id: 4815162342,
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
  createReview?: Array<CreatedReviewV1>;
};

type StubCalls = {
  createReview: Array<{ comments: ReadonlyArray<ReviewComment> }>;
  updateReview: Array<{ reviewId: number; body: string }>;
};

function makeStub(script: StubScript): { client: GhReviewClient; calls: StubCalls } {
  const createSeq = [...(script.createReview ?? [])];
  const calls: StubCalls = { createReview: [], updateReview: [] };
  const client: GhReviewClient = {
    async findExistingReviewByMarker() {
      return null;
    },
    async createReview({ comments }) {
      calls.createReview.push({ comments });
      const next = createSeq.shift();
      if (next === undefined) {
        throw new Error("stub createReview called more times than scripted");
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

describeDb("post_review_results doPost — durable comment_ids re-run recovery (W3.1 / D4)", () => {
  let seed: Seed;

  beforeEach(async () => {
    seed = await seedTenant();
  });

  afterEach(async () => {
    await cleanupTenant(seed);
  });

  it("WON: createReview ids are persisted to core.posted_reviews.comment_ids (durable)", async () => {
    // Stub A wins the claim and creates the review with two inline comment ids.
    const createdA: CreatedReviewV1 = { reviewId: 999, commentIds: [1001, 1002] };
    const { client, calls } = makeStub({ createReview: [createdA] });
    const input = makeInput({
      seed,
      findings: [finding({ start_line: 10, end_line: 10 }), finding({ start_line: 20, end_line: 20 })],
    });

    const result = await doPost(input, {
      ghClient: client,
      dsn: INTEGRATION_DSN!,
      clock: FIXED_CLOCK,
    });

    expect(result.publication_outcome).toBe("inline_posted");
    expect(result.review_id).toBe(999);
    expect(result.comment_ids).toEqual([1001, 1002]);
    expect(calls.createReview.length).toBe(1);

    // The row carries BOTH github_review_id=999 AND the durable comment_ids (NOT the DB default []).
    const row = await readPostedRow(seed.prId);
    expect(row).toBeDefined();
    expect(Number(row!.github_review_id)).toBe(999);
    expect(row!.comment_ids).toEqual([1001, 1002]);
  });

  it("RE-RUN lost-claim: returns the STORED comment_ids (not []) and never re-creates", async () => {
    // First run (stub A) wins the claim, stores reviewId 999 + comment ids.
    const createdA: CreatedReviewV1 = { reviewId: 999, commentIds: [1001, 1002] };
    const stubA = makeStub({ createReview: [createdA] });
    const input = makeInput({
      seed,
      findings: [finding({ start_line: 10, end_line: 10 }), finding({ start_line: 20, end_line: 20 })],
    });
    const first = await doPost(input, { ghClient: stubA.client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });
    expect(first.review_id).toBe(999);
    expect(stubA.calls.createReview.length).toBe(1);

    // Re-run (stub B) — the row already holds the claim → lost-claim path. ZERO createReview on B, ONE
    // updateReview, and the returned PostedReviewV1.comment_ids MUST be the stored ids (recovers inline
    // lifecycle finalization), NOT the [] it returned before W3.1.
    const stubB = makeStub({});
    const second = await doPost(input, { ghClient: stubB.client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

    expect(second.was_update).toBe(true);
    expect(second.review_id).toBe(999);
    expect(stubB.calls.createReview.length).toBe(0); // ZERO create on the re-run
    expect(stubB.calls.updateReview.length).toBe(1); // ONE update
    expect(stubB.calls.updateReview[0]!.reviewId).toBe(999);
    expect(second.comment_ids).toEqual([1001, 1002]); // STORED ids recovered, NOT []

    // The persisted row is unchanged.
    const row = await readPostedRow(seed.prId);
    expect(Number(row!.github_review_id)).toBe(999);
    expect(row!.comment_ids).toEqual([1001, 1002]);
  });

  it("REPAIR-NEEDED: lost-claim re-run on a winner with EMPTY stored comment_ids but kept findings → metric increments", async () => {
    // Pre-seed a winning row that published (github_review_id set) but stored EMPTY comment_ids — the
    // pre-W3.1 corruption shape (won-claim that never wrote the ids). The re-run's input STILL carries a
    // kept finding, so the lost-claim path can't recover ids for inline finalization → emit the repair
    // signal.
    await pool.query(
      `INSERT INTO core.posted_reviews
         (pr_id, marker, github_review_id, publication_outcome, comment_ids, posted_at)
       VALUES ($1, $2, $3, 'inline_posted', '[]'::jsonb, now())`,
      [seed.prId, markerFor(seed.prId), 4242],
    );

    const { client, calls } = makeStub({});
    const input = makeInput({ seed, findings: [finding({ start_line: 10, end_line: 10 })] });

    const result = await doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

    expect(result.was_update).toBe(true);
    expect(result.review_id).toBe(4242);
    expect(result.comment_ids).toEqual([]); // nothing to recover
    expect(calls.updateReview.length).toBe(1);

    await provider.forceFlush();
    expect(sumFor(REPAIR_NEEDED_NAME)).toBe(1);
  });

  it("REPAIR-NEEDED: NOT emitted when stored comment_ids are present (no repair signal on the healthy path)", async () => {
    await pool.query(
      `INSERT INTO core.posted_reviews
         (pr_id, marker, github_review_id, publication_outcome, comment_ids, posted_at)
       VALUES ($1, $2, $3, 'inline_posted', '[1001]'::jsonb, now())`,
      [seed.prId, markerFor(seed.prId), 4242],
    );

    const { client } = makeStub({});
    const input = makeInput({ seed, findings: [finding({ start_line: 10, end_line: 10 })] });

    const result = await doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

    expect(result.comment_ids).toEqual([1001]);

    await provider.forceFlush();
    expect(sumFor(REPAIR_NEEDED_NAME)).toBe(0);
  });
});
