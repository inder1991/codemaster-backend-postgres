import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { PayloadIntegrityError, ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { type ReviewJobV1 } from "#contracts/review_jobs.v1.js";
import { minimalReviewPayload, readRun, seedRun, seedRunWithState } from "./_fixtures.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation): vitest.config.ts shuffles test order, and claim()/reapStuckRuns()
// are CROSS-TENANT scans over ALL core.review_jobs rows. Without per-test cleanup a prior (shuffled) test's
// leftover 'ready'/'leased' job gets claimed/reaped instead of the just-enqueued one and flakes 'attempts===1'.
// Safe because test:integration runs --no-file-parallelism (no other file writes core.review_jobs concurrently)
// and only the runner tests write this brand-new table.
beforeEach(async () => { if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db); });

describeDb("ReviewJobsRepo.enqueue", () => {
  it("enqueues + reads back", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const id = await repo.enqueue({ ...s, payload: minimalReviewPayload(s) });
    expect((await repo.getById(id))?.state).toBe("ready");
  });
});

// ─── W0.2: durable workflow-argument store (D1) — validate → canonicalize → hash ───────────────────
describeDb("ReviewJobsRepo.enqueue — durable payload (D1)", () => {
  it("validates the payload, stores it + job_payload_schema_version=1 + sha256(canonicalJson); getById round-trips", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const payload = minimalReviewPayload(s);
    const id = await repo.enqueue({ ...s, payload });

    const job = await repo.getById(id);
    expect(job).not.toBeNull();
    expect(job!.job_payload_schema_version).toBe(1); // F1: storage-envelope version, NOT the payload's inner 2
    // The stored sha256 equals sha256hex over the SAME canonical encoding the repo uses (stable key-ordered JSON).
    const canonical = JSON.stringify(sortKeysForTest(payload));
    const expectedSha = createHash("sha256").update(Buffer.from(canonical, "utf-8")).digest("hex");
    expect(job!.payload_sha256).toBe(expectedSha);
    // The stored payload round-trips through verifyPayload (parse + hash match) with inner schema_version=2.
    const verified = repo.verifyPayload(job!);
    expect(verified.schema_version).toBe(2);
    expect(verified.review_id).toBe(s.reviewId);
    expect(verified.run_id).toBe(s.runId);
  });

  it("REJECTS an invalid payload (inner schema_version != 2) and inserts nothing", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const bad = { ...minimalReviewPayload(s), schema_version: 1 } as unknown;
    await expect(repo.enqueue({ ...s, payload: bad })).rejects.toThrow();
    // No row was inserted — the validation throws BEFORE the INSERT.
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM core.review_jobs`.execute(db);
    expect(r.rows[0]!.n).toBe(0);
  });

  it("verifyPayload throws PayloadIntegrityError when the stored hash does not match the stored payload", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const id = await repo.enqueue({ ...s, payload: minimalReviewPayload(s) });
    // Corrupt the stored sha256 so the recompute mismatches.
    // tenant:exempt reason=test-corruption-of-pk-row follow_up=FOLLOW-UP-gf3-error-mode
    await sql`UPDATE core.review_jobs SET payload_sha256 = ${"f".repeat(64)} WHERE job_id = ${id}`.execute(db);
    const job = await repo.getById(id);
    expect(() => repo.verifyPayload(job!)).toThrow(PayloadIntegrityError);
  });
});

// ─── F2: job-envelope identity ↔ payload identity must be cross-checked (review finding) ───────────
//
// enqueue stores a.runId/a.reviewId/a.installationId/a.deliveryId as the job's identity COLUMNS and stores
// the payload INDEPENDENTLY; verifyPayload used to check ONLY the hash. So payload.run_id could diverge from
// job.run_id and the shell would MIX identities (orchestrate runs job.run_id; lifecycle records
// payload.run_id). Both halves of the fix are asserted: enqueue refuses a mismatched payload BEFORE the
// INSERT, and verifyPayload refuses an already-stored divergent row at READ time.
describeDb("ReviewJobsRepo — F2 payload↔job identity equality", () => {
  it("enqueue REJECTS a payload whose run_id != a.runId and inserts nothing", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    // The payload is internally VALID (parses cleanly) but its run_id is a DIFFERENT uuid than the envelope's.
    const diverged = { ...minimalReviewPayload(s), run_id: randomUUID() } as unknown;
    await expect(repo.enqueue({ ...s, payload: diverged })).rejects.toThrow(PayloadIntegrityError);
    // The identity assert runs BEFORE the INSERT → nothing is written.
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM core.review_jobs`.execute(db);
    expect(r.rows[0]!.n).toBe(0);
  });

  it("enqueue REJECTS a payload whose review_id != a.reviewId and inserts nothing", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const diverged = { ...minimalReviewPayload(s), review_id: randomUUID() } as unknown;
    await expect(repo.enqueue({ ...s, payload: diverged })).rejects.toThrow(PayloadIntegrityError);
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM core.review_jobs`.execute(db);
    expect(r.rows[0]!.n).toBe(0);
  });

  it("enqueue REJECTS a payload whose installation_id != a.installationId and inserts nothing", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const diverged = { ...minimalReviewPayload(s), installation_id: randomUUID() } as unknown;
    await expect(repo.enqueue({ ...s, payload: diverged })).rejects.toThrow(PayloadIntegrityError);
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM core.review_jobs`.execute(db);
    expect(r.rows[0]!.n).toBe(0);
  });

  it("enqueue REJECTS a payload whose delivery_id != the supplied a.deliveryId and inserts nothing", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const payload = minimalReviewPayload(s); // payload.delivery_id = `dlv-${s.reviewId}`
    // Supply a NON-NULL envelope delivery_id that disagrees with the payload's.
    await expect(repo.enqueue({ ...s, deliveryId: "dlv-MISMATCH", payload })).rejects.toThrow(PayloadIntegrityError);
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM core.review_jobs`.execute(db);
    expect(r.rows[0]!.n).toBe(0);
  });

  it("enqueue does NOT cross-check delivery_id when a.deliveryId is null (envelope opted out)", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    // a.deliveryId omitted (null) → the payload's delivery_id is free to be anything; no identity throw.
    const id = await repo.enqueue({ ...s, payload: minimalReviewPayload(s) });
    expect((await repo.getById(id))?.state).toBe("ready");
  });

  it("verifyPayload throws PayloadIntegrityError on a hand-built job row whose payload.run_id != job.run_id", () => {
    const repo = new ReviewJobsRepo(db); const s = { runId: randomUUID(), reviewId: randomUUID(), installationId: randomUUID() };
    // A hand-built divergent row (an out-of-band write that slipped past enqueue): the job's run_id COLUMN
    // disagrees with the stored payload's run_id, while the stored sha256 STILL matches the payload — so ONLY
    // the new identity cross-check (not the hash check) can catch it. No DB round-trip → no FK on run_id.
    const job = makeJobRowFor({ ...s, runId: randomUUID() }, minimalReviewPayload(s));
    expect(() => repo.verifyPayload(job)).toThrow(PayloadIntegrityError);
  });

  it("verifyPayload throws PayloadIntegrityError on a hand-built job row whose payload.installation_id != job.installation_id", () => {
    const repo = new ReviewJobsRepo(db); const s = { runId: randomUUID(), reviewId: randomUUID(), installationId: randomUUID() };
    const job = makeJobRowFor({ ...s, installationId: randomUUID() }, minimalReviewPayload(s));
    expect(() => repo.verifyPayload(job)).toThrow(PayloadIntegrityError);
  });

  it("the happy path (matching ids) still enqueues + verifyPayload returns the payload", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const payload = minimalReviewPayload(s);
    // Supply the matching delivery_id so the non-null branch of the cross-check is exercised on the happy path.
    const id = await repo.enqueue({ ...s, deliveryId: payload.delivery_id, payload });
    const job = await repo.getById(id);
    expect(job).not.toBeNull();
    const verified = repo.verifyPayload(job!);
    expect(verified.run_id).toBe(s.runId);
    expect(verified.review_id).toBe(s.reviewId);
    expect(verified.installation_id).toBe(s.installationId);
    expect(verified.delivery_id).toBe(payload.delivery_id);
  });
});

// ─── CS4.1 (RT3 + RC6/H9): delivery_id persisted at enqueue + idempotent enqueue on redelivery ─────
//
// RC6/H9: the outbox row REDELIVERS after a crash between the review enqueue and markDispatched. The
// re-driven enqueue used to plain-INSERT into uq_review_jobs_active_run (UNIQUE active job per run_id)
// → 23505 → throw → the outbox row retried to dead-letter as NOISE even though a job WAS already
// enqueued (and possibly running). The fix: the active-run unique conflict returns the EXISTING active
// job_id (idempotent); identity-mismatch + every OTHER integrity error keeps throwing.
describeDb("ReviewJobsRepo.enqueue — CS4.1 delivery_id persistence + redelivery idempotency (RC6/H9)", () => {
  it("persists the envelope deliveryId onto the delivery_id COLUMN (not NULL) — RT3 supporting half", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const payload = minimalReviewPayload(s);
    const id = await repo.enqueue({ ...s, deliveryId: payload.delivery_id, payload });
    // tenant:exempt reason=test-assertion-PK-lookup follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql<{ delivery_id: string | null }>`
      SELECT delivery_id FROM core.review_jobs WHERE job_id = ${id}`.execute(db);
    expect(r.rows[0]!.delivery_id).toBe(payload.delivery_id);   // the timeline-join column is POPULATED
  });

  it("a REDELIVERED enqueue (same run_id, job still 'ready') returns the EXISTING job_id — no 23505, exactly ONE row", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const payload = minimalReviewPayload(s);
    const first = await repo.enqueue({ ...s, deliveryId: payload.delivery_id, payload });
    // The redelivery byte-shape: the SAME envelope re-driven by the outbox retry. Must NOT throw.
    const second = await repo.enqueue({ ...s, deliveryId: payload.delivery_id, payload });
    expect(second).toBe(first);                                  // idempotent: the EXISTING job_id
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM core.review_jobs WHERE run_id = ${s.runId}`.execute(db);
    expect(r.rows[0]!.n).toBe(1);                                // no duplicate row
    expect((await repo.getById(first))!.state).toBe("ready");    // the existing job is untouched
  });

  it("a REDELIVERED enqueue while the job is LEASED (runner already claimed it) returns the same job_id without disturbing the lease", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const payload = minimalReviewPayload(s);
    const first = await repo.enqueue({ ...s, payload });
    const c = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 60_000 });
    expect(c!.job_id).toBe(first);
    // The crash-window scenario: enqueue succeeded, markDispatched did NOT, the runner ALREADY claimed
    // the job — the redelivered enqueue must coalesce onto the running job, not 23505 into noise.
    const second = await repo.enqueue({ ...s, payload });
    expect(second).toBe(first);
    const job = await repo.getById(first);
    expect(job!.state).toBe("leased");                           // the live lease is untouched
    expect(job!.attempts).toBe(1);
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM core.review_jobs WHERE run_id = ${s.runId}`.execute(db);
    expect(r.rows[0]!.n).toBe(1);
  });

  it("a SETTLED run frees the key: enqueue after markDone inserts a FRESH job (only the ACTIVE conflict coalesces)", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const payload = minimalReviewPayload(s);
    const first = await repo.enqueue({ ...s, payload });
    const c = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 60_000 });
    expect((await repo.markDone({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token! })).applied).toBe(true);
    // uq_review_jobs_active_run covers ONLY state IN ('ready','leased') — a settled job frees the run
    // key, so a NEW attempt enqueues a fresh row (the pre-CS4.1 behavior, pinned as the fix's boundary).
    const second = await repo.enqueue({ ...s, payload });
    expect(second).not.toBe(first);
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM core.review_jobs WHERE run_id = ${s.runId}`.execute(db);
    expect(r.rows[0]!.n).toBe(2);
  });
});

/** Local mirror of the repo's stable key-ordered canonicalizer — keeps the test independent of the impl import. */
function sortKeysForTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysForTest);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      out[k] = sortKeysForTest(src[k]);
    }
    return out;
  }
  return value;
}
// `describe` is imported so the helper block above does not get flagged as unused when DSN is absent.
void describe;

/**
 * Build an in-memory {@link ReviewJobV1} row for the F2 verifyPayload tests WITHOUT touching the DB (so the
 * run_id FK does not block the divergent-identity fixtures). The job's identity COLUMNS come from `ids`; the
 * stored `payload` is hashed with the SAME canonical encoding the repo uses, so the row's `payload_sha256`
 * MATCHES — only the new identity cross-check (not the hash check) can reject a job whose identity columns
 * disagree with the payload's.
 */
function makeJobRowFor(
  ids: { runId: string; reviewId: string; installationId: string; deliveryId?: string | null },
  payload: { delivery_id: string } & Record<string, unknown>,
): ReviewJobV1 {
  const sha = createHash("sha256").update(Buffer.from(JSON.stringify(sortKeysForTest(payload)), "utf-8")).digest("hex");
  return {
    job_id: randomUUID(), run_id: ids.runId, review_id: ids.reviewId, installation_id: ids.installationId,
    delivery_id: ids.deliveryId ?? null, state: "leased", priority: 0, attempts: 1, max_attempts: 3,
    attempt_token: null, job_payload_schema_version: 1, payload_sha256: sha, mutex_id: null,
    payload,
  } as unknown as ReviewJobV1;
}

describeDb("ReviewJobsRepo.claim", () => {
  it("claims, mints a token, sets timeout_at; a 2nd claimer gets nothing", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue({ ...s, payload: minimalReviewPayload(s) });
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    expect(c?.attempt_token).toBeTruthy(); expect(c?.attempts).toBe(1);
    expect((c as Record<string, unknown>).timeout_at).toBeTruthy();
    expect(await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 })).toBeNull();
  });
  it("reclaims an expired lease with a NEW token while attempts remain", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue({ ...s, maxAttempts: 3, payload: minimalReviewPayload(s) });
    const c1 = await repo.claim({ owner: "w1", leaseMs: 1, maxRuntimeMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    const c2 = await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 });
    expect(c2?.job_id).toBe(c1!.job_id); expect(c2!.attempt_token).not.toBe(c1!.attempt_token); expect(c2!.attempts).toBe(2);
  });
  it("does NOT reclaim an expired lease whose attempts are exhausted (v3 #2)", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue({ ...s, maxAttempts: 1, payload: minimalReviewPayload(s) });
    await repo.claim({ owner: "w1", leaseMs: 1, maxRuntimeMs: 60_000 }); // attempts → 1 (== max)
    await new Promise((r) => setTimeout(r, 50));                          // lease expires; worker "crashed"
    expect(await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 })).toBeNull(); // not re-run
  });
});

describeDb("ReviewJobsRepo.heartbeat", () => {
  it("extends for the owning token; refuses a stale token; refuses past timeout_at", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue({ ...s, payload: minimalReviewPayload(s) });
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 30 }); // 30ms runtime ceiling
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, leaseMs: 1000 })).toBe(true);
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: crypto.randomUUID(), leaseMs: 1000 })).toBe(false);
    await new Promise((r) => setTimeout(r, 60)); // exceed timeout_at
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, leaseMs: 1000 })).toBe(false);
  });
});

describeDb("ReviewJobsRepo.markDone", () => {
  it("completes for the owning token and clears the lease; a stale token is applied:false", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue({ ...s, payload: minimalReviewPayload(s) });
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    expect((await repo.markDone({ jobId: c!.job_id, owner: "w1", token: crypto.randomUUID() })).applied).toBe(false);
    expect((await repo.getById(c!.job_id))!.state).toBe("leased");
    expect((await repo.markDone({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token! })).applied).toBe(true);
    const done = await repo.getById(c!.job_id);
    expect(done!.state).toBe("done");
    expect((done as Record<string, unknown>).attempt_token).toBeNull();          // lease metadata cleared (v3 #9)
    expect((done as Record<string, unknown>).lease_owner).toBeNull();
  });
});

// ─── W0.3: markCancelled (E3) — superseded loser settles 'cancelled', terminal, fenced like markDone ───
describeDb("ReviewJobsRepo.markCancelled", () => {
  it("settles 'cancelled' for the owning token (cancel_reason + finished_at + lease cleared); a stale token is applied:false", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue({ ...s, payload: minimalReviewPayload(s) });
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    // Stale token → fenced out (0 rows), state unchanged.
    expect((await repo.markCancelled({ jobId: c!.job_id, owner: "w1", token: crypto.randomUUID(), reason: "superseded" })).applied).toBe(false);
    expect((await repo.getById(c!.job_id))!.state).toBe("leased");
    // Owning token → settles cancelled (terminal — NOT ready, NOT dead) with cancel_reason + finished_at.
    expect((await repo.markCancelled({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, reason: "superseded" })).applied).toBe(true);
    const cancelled = await repo.getById(c!.job_id);
    expect(cancelled!.state).toBe("cancelled");
    expect((cancelled as Record<string, unknown>).cancel_reason).toBe("superseded");
    expect((cancelled as Record<string, unknown>).finished_at).toBeTruthy();
    expect((cancelled as Record<string, unknown>).attempt_token).toBeNull();        // ALL lease metadata cleared (v3 #9)
    expect((cancelled as Record<string, unknown>).lease_owner).toBeNull();
    expect((cancelled as Record<string, unknown>).leased_until).toBeNull();
    expect((cancelled as Record<string, unknown>).timeout_at).toBeNull();
    expect((cancelled as Record<string, unknown>).heartbeat_at).toBeNull();
    // Terminal: a cancelled job is NOT re-driven by claim() (state is neither 'ready' nor a reclaimable 'leased').
    expect(await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 })).toBeNull();
  });
});

describeDb("ReviewJobsRepo.markFailed", () => {
  it("re-enqueues with backoff then dead-letters; clears lease; a stale token is applied:false", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue({ ...s, maxAttempts: 2, payload: minimalReviewPayload(s) });
    const c1 = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    const r1 = await repo.markFailed({ jobId: c1!.job_id, owner: "w1", token: c1!.attempt_token!, error: "boom", baseBackoffMs: 1 });
    expect(r1).toEqual({ applied: true, terminal: false });
    const requeued = await repo.getById(c1!.job_id);
    expect(requeued!.state).toBe("ready");
    expect((requeued as Record<string, unknown>).attempt_token).toBeNull();      // lease metadata cleared on requeue (v3 #9)
    await new Promise((r) => setTimeout(r, 30));
    const c2 = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    const r2 = await repo.markFailed({ jobId: c2!.job_id, owner: "w1", token: c2!.attempt_token!, error: "boom2", baseBackoffMs: 1 });
    expect(r2).toEqual({ applied: true, terminal: true });
    const dead = await repo.getById(c2!.job_id); expect(dead!.state).toBe("dead"); expect((dead as Record<string, unknown>).dead_reason).toContain("boom2");
    expect((await repo.markFailed({ jobId: c2!.job_id, owner: "w1", token: crypto.randomUUID(), error: "x", baseBackoffMs: 1 })).applied).toBe(false);
  });
});

// ─── W5.1b: terminalSettle (F4) — atomic job+run terminal transition in ONE transaction (no split-brain) ───
describeDb("ReviewJobsRepo.terminalSettle", () => {
  it("flips BOTH job→cancelled and run→CANCELLED in one txn (cancelled_at set, run cancel_reason valid)", async () => {
    const repo = new ReviewJobsRepo(db);
    const s = await seedRunWithState(db, "RUNNING");           // the shell's run starts RUNNING
    await repo.enqueue({ ...s, payload: minimalReviewPayload(s) });
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    // The JOB's free-text reason ("superseded") lands on review_jobs.cancel_reason; the RUN's CHECK-constrained
    // cancel_reason is the SEPARATE runCancelReason ('operator_cancelled' — a CHECK-valid value with no coupled
    // superseded_by_run_id requirement, unlike the run-side 'superseded' value).
    const r = await repo.terminalSettle({
      jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, runId: s.runId,
      jobState: "cancelled", runState: "CANCELLED", reason: "superseded", runCancelReason: "operator_cancelled",
    });
    expect(r.applied).toBe(true);
    const job = await repo.getById(c!.job_id);
    expect(job!.state).toBe("cancelled");
    expect((job as Record<string, unknown>).cancel_reason).toBe("superseded");   // job carries the free-text cause
    expect((job as Record<string, unknown>).finished_at).toBeTruthy();
    expect((job as Record<string, unknown>).attempt_token).toBeNull();          // ALL lease metadata cleared
    expect((job as Record<string, unknown>).lease_owner).toBeNull();
    const run = await readRun(db, s.runId);
    expect(run.lifecycle_state).toBe("CANCELLED");
    expect(run.cancelled_at).toBeTruthy();                                       // biconditional CANCELLED ⇔ cancelled_at
    expect(run.failed_at).toBeNull();
    expect(run.cancel_reason).toBe("operator_cancelled");                        // the CHECK-valid run reason
  });

  it("flips BOTH job→dead and run→FAILED in one txn (failed_at set; no run cancel_reason)", async () => {
    const repo = new ReviewJobsRepo(db);
    const s = await seedRunWithState(db, "RUNNING");
    await repo.enqueue({ ...s, payload: minimalReviewPayload(s) });
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    const r = await repo.terminalSettle({
      jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, runId: s.runId,
      jobState: "dead", runState: "FAILED", reason: "max runtime exceeded",
    });
    expect(r.applied).toBe(true);
    const job = await repo.getById(c!.job_id);
    expect(job!.state).toBe("dead");
    expect((job as Record<string, unknown>).dead_reason).toContain("max runtime");
    expect((job as Record<string, unknown>).finished_at).toBeTruthy();
    const run = await readRun(db, s.runId);
    expect(run.lifecycle_state).toBe("FAILED");
    expect(run.failed_at).toBeTruthy();                                          // biconditional FAILED ⇔ failed_at
    expect(run.cancelled_at).toBeNull();
  });

  it("a STALE token settles NEITHER row (applied:false; job stays leased, run stays RUNNING — no split-brain)", async () => {
    const repo = new ReviewJobsRepo(db);
    const s = await seedRunWithState(db, "RUNNING");
    await repo.enqueue({ ...s, payload: minimalReviewPayload(s) });
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    const r = await repo.terminalSettle({
      jobId: c!.job_id, owner: "w1", token: crypto.randomUUID(), runId: s.runId,
      jobState: "cancelled", runState: "CANCELLED", reason: "superseded", runCancelReason: "operator_cancelled",
    });
    expect(r.applied).toBe(false);
    // ATOMIC: the fenced job-update affected 0 rows → the WHOLE txn rolled back → the run is untouched too.
    expect((await repo.getById(c!.job_id))!.state).toBe("leased");
    expect((await readRun(db, s.runId)).lifecycle_state).toBe("RUNNING");
  });
});

// NOTE: `reapCrashLooped` was REPLACED by the unified `reapStuckRuns` (W6.1, D3, gate ④). Its coverage
// (the stuck-detection scan + job→dead + run→CANCELLED + mutex release + ONE audit event per run) lives in
// test/integration/runner/reap_stuck_runs.integration.test.ts.
