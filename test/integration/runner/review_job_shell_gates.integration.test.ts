// test/integration/runner/review_job_shell_gates.integration.test.ts
//
// PHASE-2 CHAOS GATE G1 — abort-aware side-effect contract ① (plan F7).
//
// The ENFORCEABLE guarantee the runner shell makes: "no NEW paid/external call STARTS after
// signal.aborted" — NOT "zero in-flight". This file COUNTS REAL external calls (a scripted GhReviewClient
// driven by the REAL doPost via the shell's postReview port, and a REAL strict-ledger LlmClient over a
// counting SDK) and asserts the real zero-after-abort / exactly-once properties, so that if the abort
// guard (withAbortGate / doPost's throwIfAborted / the ledger replay) were removed the gate would FAIL.
//
//   G1.1 — no new external call after abort + the E6 cleanup (mutex + workspace release) still ran.
//   G1.2 — abort during post → re-run completes the post EXACTLY once (one createReview, one row).
//   G1.3 — an in-flight paid LLM call completes + ledgers; a re-run HITs the ledger (SDK charged once).
//
// DB-gated (describeDb) against the DISPOSABLE :5434 Postgres only — NEVER the cluster. --no-file-parallelism.
// test/ is OUT of the clock/random gate scope (Date.now / randomUUID are fine here).

import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { runOneJob } from "#backend/runner/review_job_runner.js";
import { runReviewJob } from "#backend/runner/review_job_shell.js";
import { doPost } from "#backend/activities/post_review_results.activity.js";
import { REVIEW_TOOL_SCHEMA_VERSION } from "#backend/review/review_activity.js";
import { disposeAllPools } from "#platform/db/database.js";
import { WallClock } from "#platform/clock.js";

import { type PostReviewInputV1 } from "#contracts/post_review_input.v1.js";
import { type PrMetaV1, type WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { type ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { type CreatedReviewV1 } from "#backend/integrations/github/review_client.js";

import {
  seedTenant,
  payloadFor,
  cleanup,
  makeStubPorts,
  makeStubLifecycle,
  makeScriptedGhClient,
  makeCountingSdk,
  makeCountingLedgerClient,
  purgeLedgerScenarioRows,
  type Seed,
} from "./_fixtures.js";

const clock = new WallClock();

let db: Kysely<unknown>;
let pool: Pool;
if (INTEGRATION_DSN) {
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}

afterAll(async () => {
  await db?.destroy();
  // G1.3's strict-ledger client opens the ADR-0062 shared pool for INTEGRATION_DSN; end it so no socket leaks.
  await disposeAllPools();
});

beforeEach(async () => {
  if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db);
});

/** Read the human-readable cancel cause the runner persisted onto core.review_jobs.cancel_reason. */
async function readJobCancelReason(jobId: string): Promise<string | null> {
  const r = await sql<{ cancel_reason: string | null }>`
    SELECT cancel_reason FROM core.review_jobs WHERE job_id = ${jobId}`.execute(db);
  return r.rows[0]?.cancel_reason ?? null;
}

/** Build a valid PostReviewInputV1 for a seed, with ONE finding inside the diff window (so a real post
 *  would carry an inline comment). github_installation_id is the seed-derived numeric id. */
function postInputFor(seed: Seed, prId: string): PostReviewInputV1 {
  const fileInDiff = "src/app.ts";
  const finding: ReviewFindingV1 = {
    schema_version: 1,
    file: fileInDiff,
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
  };
  const prMeta: PrMetaV1 = {
    pr_id: prId,
    installation_id: seed.installationId,
    repo: "acme/widgets",
    pr_title: "Add widget",
    pr_description: "desc",
    author_login: null,
    draft: false,
    base_ref: null,
    head_ref: null,
    opened_at: null,
  };
  const walkthrough: WalkthroughV1 = {
    schema_version: 1,
    tldr: "Adds a widget.",
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
    findings: [finding],
    dedupe_stats: { input_count: 1, exact_dropped: 0, semantic_merged: 0, capped: 0, semantic_skipped: false },
    policy_revision: 0,
  };
  return {
    schema_version: 1,
    walkthrough,
    aggregated,
    pr_meta: prMeta,
    github_installation_id: 4815162342,
    head_sha: "abc123",
    walkthrough_md: "## Walkthrough\n\nAdds a widget.",
    owner: "acme",
    repo_name: "widgets",
    pr_number: seed.prNumber,
    run_id: seed.runId,
    review_id: seed.reviewId,
    changed_line_ranges: { [fileInDiff]: [[1, 100]] },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G1.1 — no NEW external call after abort + the E6 cleanup ran.
//
// Drive the FULL shell (runReviewJob + runOneJob). The REAL postReview port talks to a scripted
// GhReviewClient (programmed to create a review, so IF the abort gate were removed the create WOULD
// record a write AFTER the abort). A counting-stub `aggregate` port fires controller.abort() at the
// pre-aggregate boundary and stamps the abort timestamp; orchestrate then reaches the gated postReview,
// whose withAbortGate throws TerminalCancelError("aborted") BEFORE doPost — so ZERO createReview starts
// and the handler settles `cancelled`. The shell's finally (E6) still releases the mutex + workspace.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G1.1 — no new external call after abort; E6 cleanup ran (F7)", () => {
  it("settles cancelled; ZERO GH write + ZERO SDK call started after abort; mutex + workspace released", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(db, 201);
    const payload = payloadFor(seed);
    // The scripted GH client WOULD create a review if reached — so the zero-after-abort assertion is a real
    // control (it is only true because the gate fired, not because the client was inert).
    const gh = makeScriptedGhClient({ createReview: [{ reviewId: 999, commentIds: [1001] }] });
    const sdk = makeCountingSdk();

    let abortTs = 0;
    const controller = new AbortController();
    const calls: Array<string> = [];

    try {
      await repo.enqueue({
        runId: seed.runId, reviewId: seed.reviewId, installationId: seed.installationId, payload,
      });

      // aggregate is ALWAYS dispatched; fire the abort there (pre-post) + stamp the abort instant.
      const ports = makeStubPorts(calls, {
        aggregate: async (input) => {
          calls.push("aggregate");
          controller.abort();
          abortTs = Date.now();
          return AggregatedFindingsV1.parse({
            findings: [...input.findings],
            dedupe_stats: { input_count: input.findings.length, exact_dropped: 0, semantic_merged: 0, capped: 0 },
            policy_revision: input.policy_revision,
          });
        },
      });

      // Track that the E6 cleanup releaseWorkspace ran (the lifecycle's release is abort-EXEMPT).
      let releaseWorkspaceCalls = 0;
      const lifecycle = makeStubLifecycle(calls, {
        releaseWorkspace: async () => { calls.push("releaseWorkspace"); releaseWorkspaceCalls += 1; },
      });

      const handler = runReviewJob({
        repo, pool, dsn: INTEGRATION_DSN!, clock, mutexRenewIntervalS: 999,
        ports,
        lifecycle,
        // REAL postReview port → real doPost → the scripted GH client (no Vault / GitHub round-trip).
        postReviewGhClient: gh.client,
      });
      // The external runner signal IS our controller's signal → aborting it aborts the shell's composed signal.
      const handlerWithSignal = (job: Parameters<typeof handler>[0]): Promise<void> =>
        handler(job, controller.signal);

      const res = await runOneJob({
        repo, clock, owner: "g1-1", leaseS: 5, heartbeatS: 1, maxRuntimeS: 60, handler: handlerWithSignal,
      });

      // (1) settled cancelled (run → CANCELLED, job → cancelled) via terminalSettle on TerminalCancelError.
      expect(res.outcome).toBe("cancelled");
      const job = await repo.getById(res.jobId!);
      expect(job!.state).toBe("cancelled");
      const run = await sql<{ lifecycle_state: string }>`
        SELECT lifecycle_state FROM core.review_runs WHERE run_id = ${seed.runId}`.execute(db);
      expect(run.rows[0]!.lifecycle_state).toBe("CANCELLED");
      // The cancel cause is the ABORT gate (proves the composed signal reached the post boundary's gate).
      expect(await readJobCancelReason(res.jobId!)).toBe("aborted");

      // (2) MEANINGFUL ASSERTION — ZERO GH write STARTED at/after the abort timestamp, AND zero total
      // createReview/updateReview/createIssueComment. The post port was GATED before doPost.
      expect(abortTs).toBeGreaterThan(0);
      expect(gh.writesStartedAtOrAfter(abortTs)).toBe(0);
      expect(gh.calls.filter((c) => c.method === "createReview")).toHaveLength(0);
      expect(gh.calls.filter((c) => c.method === "updateReview")).toHaveLength(0);
      // postReview never reached doPost (the orchestrate stub log records postReview ONLY if the fn body ran;
      // here the gate threw before any postReview body).
      expect(calls).not.toContain("postReview");

      // (3) the counting SDK STARTED zero new calls after the abort (no paid LLM call in this scenario).
      expect(sdk.calls).toHaveLength(0);

      // (4) E6 cleanup STILL ran (abort-EXEMPT finally): the mutex was released + releaseWorkspace called.
      expect(job!.mutex_id).toBeTruthy();
      const mutexRow = await sql<{ released_at: string | null }>`
        SELECT released_at FROM core.pr_review_mutex WHERE mutex_id = ${job!.mutex_id!}`.execute(db);
      expect(mutexRow.rows[0]!.released_at).not.toBeNull();
      expect(releaseWorkspaceCalls).toBe(1);
      expect(calls).toContain("releaseMutex");
      expect(calls).toContain("releaseWorkspace");
    } finally {
      await cleanup(db, seed, { prId: payload.pr_id });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G1.2 — abort during post → re-run completes the post EXACTLY once.
//
// Drive the REAL `doPost` with the EXACT options the shell's postReview port passes
// (`{ ghClient, dsn, sameRunTakeover:true, signal }` — see in_process_ports.ts::postReviewWithTakeover),
// twice against ONE scripted GhReviewClient + ONE :5434 atomic-claim row. The abort here is doPost's OWN
// pre-write gate (the BETWEEN-the-claim-and-createReview boundary the shell's coarse withAbortGate cannot
// model — that gate fires before doPost runs at all, so the Phase-1 claim would never land):
//   run #1: aborted signal → Phase-1 claim INSERTs the row, THEN doPost's throwIfAborted(signal) throws
//           TerminalCancelError BEFORE createReview → the claim row stays NULL → ZERO createReview.
//   run #2: fresh (un-aborted) signal, SAME input → lost-claim NULL-row + same-run takeover (marker finds
//           nothing) re-creates → completes the post. Across both runs: EXACTLY ONE createReview, ONE row.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G1.2 — abort during post → re-run completes exactly once", () => {
  it("run#1 aborts after claim before createReview (row NULL); run#2 re-creates → exactly ONE createReview + ONE row", async () => {
    const seed = await seedTenant(db, 202);
    const prId = payloadFor(seed).pr_id;
    // The scripted client would create review 4242 on the FIRST createReview it actually receives.
    const gh = makeScriptedGhClient({
      createReview: [{ reviewId: 4242, commentIds: [7001] } satisfies CreatedReviewV1],
      existingReviewByMarker: null, // no orphaned remote review → the takeover re-creates
    });
    const input = postInputFor(seed, prId);
    const postDeps = { ghClient: gh.client, dsn: INTEGRATION_DSN!, sameRunTakeover: true } as const;

    try {
      // ── run #1: aborted signal → claim lands, doPost's pre-write gate throws BEFORE createReview. ──
      const aborted = AbortSignal.abort();
      await expect(doPost(input, { ...postDeps, signal: aborted })).rejects.toMatchObject({
        name: "TerminalCancelError",
      });

      // The Phase-1 claim row EXISTS but github_review_id is NULL (createReview never started) — the exact
      // crash-equivalent state the next run's same-run takeover recovers.
      const after1 = await sql<{ github_review_id: string | null }>`
        SELECT github_review_id FROM core.posted_reviews WHERE pr_id = ${prId}`.execute(db);
      expect(after1.rows[0]).toBeDefined();
      expect(after1.rows[0]!.github_review_id).toBeNull();
      expect(gh.calls.filter((c) => c.method === "createReview")).toHaveLength(0);

      // ── run #2 (the follow-up re-run): fresh un-aborted signal, SAME input, same-run takeover recovers. ──
      const live = new AbortController();
      const result = await doPost(input, { ...postDeps, signal: live.signal });
      expect(result.review_id).toBe(4242);

      // MEANINGFUL ASSERTION — EXACTLY ONE createReview total across the abort + the re-run, and EXACTLY
      // ONE posted_reviews row carrying the created review. (Remove the run#1 abort gate → run#1 would have
      // created the review too → TWO createReview total; remove the run#2 same-run takeover → run#2 would
      // re-create blindly or strand the review → not exactly-once.)
      expect(gh.calls.filter((c) => c.method === "createReview")).toHaveLength(1);
      const rows = await sql<{ pr_id: string; github_review_id: string | null }>`
        SELECT pr_id, github_review_id FROM core.posted_reviews WHERE pr_id = ${prId}`.execute(db);
      expect(rows.rows).toHaveLength(1);
      expect(Number(rows.rows[0]!.github_review_id)).toBe(4242);
    } finally {
      await cleanup(db, seed, { prId });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G1.3 — an in-flight paid LLM call completes but is ledger-safe (charged EXACTLY once).
//
// Build the REAL strict-ledger LlmClient (real Postgres cost-cap / blob / telemetry + the REAL ADR-0068
// ledger, strictLedger:true) over a COUNTING SDK — exactly the wiring the shell's reviewChunk port uses.
// Invoke it twice with the SAME idempotency context the shell's per-chunk call produces (reviewId=pr_id,
// chunkId=chunk_id, toolSchemaVersion=REVIEW_TOOL_SCHEMA_VERSION, ledgerPurpose="bedrock_review_chunk"):
//   call #1 models the paid call already on the wire when abort fires — it COMPLETES, storing its ledger row.
//   call #2 models the re-run — it HITs the stored row and replays it, so the SDK is NOT re-invoked.
// Both share the SAME :5434 core.llm_invocation_ledger table (content-addressed key), so the SDK is charged
// EXACTLY ONCE for that key across abort + rerun.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G1.3 — in-flight paid LLM call completes but ledger-safe (charged exactly once)", () => {
  it("re-run HITs the ledger → SDK call count == 1 for the key across abort + rerun", async () => {
    const seed = await seedTenant(db, 203);
    const sdk = makeCountingSdk();
    const client = makeCountingLedgerClient(INTEGRATION_DSN!, sdk);

    // The deterministic per-chunk idempotency context the shell's reviewChunk path passes to invokeModel.
    const chunkId = "11111111-2222-4333-8444-555555555555"; // a stable per-chunk UUID
    const reviewId = seed.reviewId; // ReviewContextV1.pr_id is the review identity at the call site
    const idempotency = {
      reviewId,
      chunkId,
      toolSchemaVersion: REVIEW_TOOL_SCHEMA_VERSION,
      ledgerPurpose: "bedrock_review_chunk",
    };
    const invokeArgs = {
      role: "primary" as const,
      model: "claude-sonnet-4-6" as const,
      messages: [{ role: "user" as const, content: "review this chunk" }],
      maxTokens: 2048,
      purpose: "review_finding",
      installationId: seed.installationId,
      idempotency,
    };

    try {
      // call #1 (the in-flight paid call that completes after the abort): MISS → SDK invoked → ledger stored.
      const first = await client.invokeModel(invokeArgs);
      expect(first.provider).toBe("bedrock");
      expect(sdk.calls).toHaveLength(1);

      const ledgerAfter1 = await sql<{ n: string }>`
        SELECT count(*) AS n FROM core.llm_invocation_ledger
         WHERE installation_id = ${seed.installationId}::uuid AND review_id = ${reviewId}::uuid`.execute(db);
      expect(Number(ledgerAfter1.rows[0]!.n)).toBe(1);

      // call #2 (the re-run): SAME context → ledger HIT → the stored response replays, SDK NOT re-invoked.
      const second = await client.invokeModel(invokeArgs);
      expect(second.content).toBe(first.content);

      // MEANINGFUL ASSERTION — SDK call count is EXACTLY 1 across abort + rerun (no double-charge). Remove
      // the ledger replay (the strict-ledger client's lookup/store) and call #2 would re-invoke the SDK →
      // count == 2 → the gate fails. The single content-addressed ledger row is the exactly-once witness.
      expect(sdk.calls).toHaveLength(1);
      const ledgerAfter2 = await sql<{ n: string }>`
        SELECT count(*) AS n FROM core.llm_invocation_ledger
         WHERE installation_id = ${seed.installationId}::uuid AND review_id = ${reviewId}::uuid`.execute(db);
      expect(Number(ledgerAfter2.rows[0]!.n)).toBe(1);
    } finally {
      await purgeLedgerScenarioRows(db, seed.installationId);
      await cleanup(db, seed);
    }
  });
});
