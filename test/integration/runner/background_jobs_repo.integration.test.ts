// Phase 3a W2a: BackgroundJobsRepo — the GENERIC job-platform repo over core.background_jobs
// (migration 0039), lifting the PROVEN ReviewJobsRepo primitives 1:1 generalized over job_type:
// canonicalJson+sha256 payload hashing, FOR UPDATE SKIP LOCKED claim with lease/attempt_token
// fencing, heartbeat, fenced settle (done/failed/dead), backoff re-enqueue, stuck-job reap, and the
// dedup_key overlap=SKIP guard (same job_id returned while an ACTIVE row holds the key).
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { BackgroundJobsRepo, PayloadIntegrityError } from "#backend/runner/background_jobs_repo.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation — same rationale as review_jobs_repo.integration.test.ts):
// vitest.config.ts shuffles test order, and claim()/reapStuckRuns() are CROSS-TENANT, cross-job_type
// scans over ALL core.background_jobs rows. Without per-test cleanup a prior (shuffled) test's leftover
// 'ready'/'leased' job gets claimed/reaped instead of the just-enqueued one and flakes 'attempts===1'.
// Safe because test:integration runs --no-file-parallelism (files never interleave) and the only other
// writer of this table (background_jobs_schema.integration.test.ts) deletes its own rows in afterAll.
beforeEach(async () => { if (INTEGRATION_DSN) await sql`DELETE FROM core.background_jobs`.execute(db); });

/** Per-test-unique job_type so assertions are traceable to the test that minted the row. */
function jobType(): string { return `w2a-test-${randomUUID()}`; }

describeDb("BackgroundJobsRepo — enqueue → claim → markDone happy path", () => {
  it("transitions ready → leased → done; payload is canonicalized + sha256'd at enqueue", async () => {
    const repo = new BackgroundJobsRepo(db);
    const jt = jobType();
    const payload = { b: 2, a: 1, nested: { z: "ζ", y: [3, 1, 2] } }; // deliberately unsorted keys
    const id = await repo.enqueue({ jobType: jt, payload });

    // ready, with DB defaults landed + the stored sha equals sha256(canonical key-ordered JSON).
    const job = await repo.getById(id);
    expect(job).not.toBeNull();
    expect(job!.state).toBe("ready");
    expect(job!.job_type).toBe(jt);
    expect(job!.installation_id).toBeNull(); // platform-scoped by default
    expect(job!.attempts).toBe(0);
    const canonical = JSON.stringify(sortKeysForTest(payload));
    const expectedSha = createHash("sha256").update(Buffer.from(canonical, "utf-8")).digest("hex");
    expect(job!.payload_sha256).toBe(expectedSha);

    // claim → leased, token minted, attempts 1, lease metadata set.
    const c = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 120_000 });
    expect(c?.job_id).toBe(id);
    expect(c!.state).toBe("leased");
    expect(c!.attempt_token).toBeTruthy();
    expect(c!.lease_owner).toBe("w1");
    expect(c!.attempts).toBe(1);
    expect(c!.leased_until).toBeTruthy();
    expect(c!.timeout_at).toBeTruthy();

    // a STALE token cannot settle it (fenced exactly like ReviewJobsRepo.markDone)...
    expect((await repo.markDone({ jobId: id, owner: "w1", token: randomUUID() })).applied).toBe(false);
    expect((await repo.getById(id))!.state).toBe("leased");
    // ...the owning token settles done + clears ALL lease metadata.
    expect((await repo.markDone({ jobId: id, owner: "w1", token: c!.attempt_token! })).applied).toBe(true);
    const done = await repo.getById(id);
    expect(done!.state).toBe("done");
    expect(done!.attempt_token).toBeNull();
    expect(done!.lease_owner).toBeNull();
    expect(done!.leased_until).toBeNull();
    expect(done!.timeout_at).toBeNull();
    expect(done!.heartbeat_at).toBeNull();
    // W2a.1 (migration 0041, review_jobs parity): markDone stamps finished_at; a clean done row
    // carries NO dead-letter diagnostics.
    expect(done!.finished_at).toBeInstanceOf(Date);
    expect(done!.dead_reason).toBeNull();
    expect(done!.last_error).toBeNull();
  });

  it("verifyPayload round-trips the stored payload; a corrupted sha256 throws PayloadIntegrityError", async () => {
    const repo = new BackgroundJobsRepo(db);
    const payload = { kind: "retention-prune", batch: 17 };
    const id = await repo.enqueue({ jobType: jobType(), payload });
    const job = await repo.getById(id);
    expect(repo.verifyPayload(job!)).toEqual(payload);
    // Corrupt the stored sha so the recompute mismatches (the manual-edit / drift threat model).
    // tenant:exempt reason=test-corruption-of-pk-row follow_up=FOLLOW-UP-gf3-error-mode
    await sql`UPDATE core.background_jobs SET payload_sha256 = ${"f".repeat(64)} WHERE job_id = ${id}`.execute(db);
    const corrupted = await repo.getById(id);
    expect(() => repo.verifyPayload(corrupted!)).toThrow(PayloadIntegrityError);
  });

  it("enqueue persists installationId when provided (tenant-scoped job)", async () => {
    const repo = new BackgroundJobsRepo(db);
    const iid = randomUUID();
    const id = await repo.enqueue({ jobType: jobType(), payload: { x: 1 }, installationId: iid });
    expect((await repo.getById(id))!.installation_id).toBe(iid);
  });
});

describeDb("BackgroundJobsRepo.claim — lease discipline", () => {
  it("a 2nd claim while leased + un-expired returns null", async () => {
    const repo = new BackgroundJobsRepo(db);
    await repo.enqueue({ jobType: jobType(), payload: { x: 1 } });
    const c1 = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 120_000 });
    expect(c1).not.toBeNull();
    expect(await repo.claim({ owner: "w2", leaseMs: 60_000, maxRuntimeMs: 120_000 })).toBeNull();
  });

  it("reclaims an EXPIRED lease with a NEW token while attempts remain; not when attempts are exhausted", async () => {
    const repo = new BackgroundJobsRepo(db);
    await repo.enqueue({ jobType: jobType(), payload: { x: 1 }, maxAttempts: 2 });
    const c1 = await repo.claim({ owner: "w1", leaseMs: 1, maxRuntimeMs: 120_000 }); // attempts → 1
    await new Promise((r) => setTimeout(r, 50)); // lease expires; worker "crashed"
    const c2 = await repo.claim({ owner: "w2", leaseMs: 1, maxRuntimeMs: 120_000 }); // attempts → 2 (== max)
    expect(c2?.job_id).toBe(c1!.job_id);
    expect(c2!.attempt_token).not.toBe(c1!.attempt_token);
    expect(c2!.attempts).toBe(2);
    await new Promise((r) => setTimeout(r, 50)); // 2nd lease expires too — but attempts are exhausted
    expect(await repo.claim({ owner: "w3", leaseMs: 60_000, maxRuntimeMs: 120_000 })).toBeNull(); // not re-run
  });
});

describeDb("BackgroundJobsRepo.heartbeat", () => {
  it("extends for the owning token; refuses a stale token; refuses past timeout_at", async () => {
    const repo = new BackgroundJobsRepo(db);
    await repo.enqueue({ jobType: jobType(), payload: { x: 1 } });
    const c = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 30 }); // 30ms runtime ceiling
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, leaseMs: 60_000 })).toBe(true);
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: randomUUID(), leaseMs: 60_000 })).toBe(false);
    await new Promise((r) => setTimeout(r, 60)); // exceed timeout_at
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, leaseMs: 60_000 })).toBe(false);
  });
});

describeDb("BackgroundJobsRepo.markFailed — backoff re-enqueue until attempts==max, then dead", () => {
  it("re-enqueues (state ready, lease cleared) while attempts remain; dead-letters at exhaustion; stale token fenced", async () => {
    const repo = new BackgroundJobsRepo(db);
    await repo.enqueue({ jobType: jobType(), payload: { x: 1 }, maxAttempts: 2 });

    const c1 = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 120_000 }); // attempts → 1
    const r1 = await repo.markFailed({ jobId: c1!.job_id, owner: "w1", token: c1!.attempt_token!, error: "boom", baseBackoffMs: 1 });
    expect(r1).toEqual({ applied: true, terminal: false });
    const requeued = await repo.getById(c1!.job_id);
    expect(requeued!.state).toBe("ready");          // retry scheduled (attempts 1 < max 2)
    expect(requeued!.attempts).toBe(1);
    expect(requeued!.attempt_token).toBeNull();     // ALL lease metadata cleared on requeue
    expect(requeued!.lease_owner).toBeNull();
    expect(requeued!.leased_until).toBeNull();
    // W2a.1 (migration 0041, review_jobs parity): the RE-ENQUEUE path persists last_error (so the
    // most recent failure is always inspectable) but does NOT terminal-stamp dead_reason/finished_at.
    expect(requeued!.last_error).toBe("boom");
    expect(requeued!.dead_reason).toBeNull();
    expect(requeued!.finished_at).toBeNull();

    await new Promise((r) => setTimeout(r, 30));    // let the (jittered 1ms-base) backoff elapse
    const c2 = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 120_000 }); // attempts → 2 (== max)
    expect(c2!.attempts).toBe(2);
    const r2 = await repo.markFailed({ jobId: c2!.job_id, owner: "w1", token: c2!.attempt_token!, error: "boom2", baseBackoffMs: 1 });
    expect(r2).toEqual({ applied: true, terminal: true });
    const deadRow = await repo.getById(c2!.job_id);
    expect(deadRow!.state).toBe("dead");
    // W2a.1: the TERMINAL transition persists the full dead-letter triple (mirrors review_jobs).
    expect(deadRow!.last_error).toBe("boom2");
    expect(deadRow!.dead_reason).toBe("boom2");
    expect(deadRow!.finished_at).toBeInstanceOf(Date);

    // a stale token after settle affects 0 rows.
    expect((await repo.markFailed({ jobId: c2!.job_id, owner: "w1", token: randomUUID(), error: "x", baseBackoffMs: 1 })).applied).toBe(false);
  });

  it("terminalSettle routes a leased job atomically → dead for the owning token; stale token settles nothing", async () => {
    const repo = new BackgroundJobsRepo(db);
    await repo.enqueue({ jobType: jobType(), payload: { x: 1 }, maxAttempts: 3 });
    const c = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 120_000 });
    // Stale token → fenced out (0 rows), state unchanged.
    expect((await repo.terminalSettle({ jobId: c!.job_id, owner: "w1", token: randomUUID(), reason: "poison" })).applied).toBe(false);
    expect((await repo.getById(c!.job_id))!.state).toBe("leased");
    // Owning token → dead REGARDLESS of attempts remaining (1 < max 3), lease metadata cleared.
    expect((await repo.terminalSettle({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, reason: "poison" })).applied).toBe(true);
    const dead = await repo.getById(c!.job_id);
    expect(dead!.state).toBe("dead");
    expect(dead!.attempt_token).toBeNull();
    expect(dead!.lease_owner).toBeNull();
    // W2a.1 (migration 0041, review_jobs parity): terminalSettle persists dead_reason + finished_at.
    expect(dead!.dead_reason).toBe("poison");
    expect(dead!.finished_at).toBeInstanceOf(Date);
    expect(dead!.last_error).toBeNull(); // poison-pill path never ran markFailed
    // Terminal: a dead job is NOT re-driven by claim().
    expect(await repo.claim({ owner: "w2", leaseMs: 60_000, maxRuntimeMs: 120_000 })).toBeNull();
  });
});

describeDb("BackgroundJobsRepo.reapStuckRuns", () => {
  it("reaps ONLY leased+expired+attempts-exhausted jobs → dead; leaves retryable/live leases alone", async () => {
    const repo = new BackgroundJobsRepo(db);
    // Claim everything with LONG leases (so each sequential claim deterministically targets the one
    // just-enqueued ready row), then expire A+B's leases via direct SQL — no sleep flakiness.
    // jobA: exhausted (max 1) + (soon-)expired lease → REAPED.
    const idA = await repo.enqueue({ jobType: jobType(), payload: { which: "A" }, maxAttempts: 1 });
    const cA = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 120_000 });
    expect(cA?.job_id).toBe(idA);
    // jobB: (soon-)expired lease but attempts REMAIN (1 < max 3) → left for claim() to reclaim, NOT reaped.
    const idB = await repo.enqueue({ jobType: jobType(), payload: { which: "B" }, maxAttempts: 3 });
    const cB = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 120_000 });
    expect(cB?.job_id).toBe(idB);
    // jobC: live un-expired lease (attempts exhausted, but the worker is still heartbeat-alive) → untouched.
    const idC = await repo.enqueue({ jobType: jobType(), payload: { which: "C" }, maxAttempts: 1 });
    const cC = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 120_000 });
    expect(cC?.job_id).toBe(idC);

    // Expire A's and B's leases out-of-band (deterministic — the worker "crashed").
    // tenant:exempt reason=test-fixture-expires-leases follow_up=FOLLOW-UP-gf3-error-mode
    await sql`UPDATE core.background_jobs SET leased_until = now() - interval '1 second'
      WHERE job_id IN (${idA}, ${idB})`.execute(db);
    expect(await repo.reapStuckRuns()).toBe(1);  // ONLY A is stuck (expired AND exhausted)

    const a = await repo.getById(idA);
    expect(a!.state).toBe("dead");
    expect(a!.attempt_token).toBeNull();         // lease metadata cleared on reap
    expect(a!.lease_owner).toBeNull();
    // W2a.1 (migration 0041, review_jobs parity): the reaper terminal-stamps the dead-letter columns.
    expect(a!.dead_reason).toBe("lease expired with attempts exhausted (stuck run)");
    expect(a!.finished_at).toBeInstanceOf(Date);
    expect((await repo.getById(idB))!.state).toBe("leased"); // claim() owns reclaiming B
    expect((await repo.getById(idC))!.state).toBe("leased"); // live lease untouched
  });
});

describeDb("BackgroundJobsRepo.enqueue — dedupKey overlap=SKIP", () => {
  it("two enqueues with the same dedupKey while one is ACTIVE return the SAME job_id with ONE row", async () => {
    const repo = new BackgroundJobsRepo(db);
    const jt = jobType();
    const key = `sched-${randomUUID()}:bucket-1`;
    const id1 = await repo.enqueue({ jobType: jt, payload: { x: 1 }, dedupKey: key });
    const id2 = await repo.enqueue({ jobType: jt, payload: { x: 1 }, dedupKey: key });
    expect(id2).toBe(id1); // overlap=SKIP honored at enqueue → same job_id returned
    const n1 = await sql<{ n: number }>`SELECT count(*)::int AS n FROM core.background_jobs
      WHERE dedup_key = ${key}`.execute(db);
    expect(n1.rows[0]!.n).toBe(1); // ONE row

    // 'leased' is still ACTIVE: an enqueue while the job runs ALSO returns the same id.
    const c = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 120_000 });
    expect(c?.job_id).toBe(id1);
    expect(await repo.enqueue({ jobType: jt, payload: { x: 1 }, dedupKey: key })).toBe(id1);

    // a TERMINAL row frees the key (the partial half of uq_background_jobs_dedup_active): a fresh
    // enqueue mints a NEW job.
    await repo.markDone({ jobId: id1, owner: "w1", token: c!.attempt_token! });
    const id3 = await repo.enqueue({ jobType: jt, payload: { x: 1 }, dedupKey: key });
    expect(id3).not.toBe(id1);
    const n2 = await sql<{ n: number }>`SELECT count(*)::int AS n FROM core.background_jobs
      WHERE dedup_key = ${key}`.execute(db);
    expect(n2.rows[0]!.n).toBe(2);
  });
});

/** Local mirror of the repo's stable key-ordered canonicalizer — keeps the test independent of the impl import. */
function sortKeysForTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysForTest);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      out[k] = sortKeysForTest(src[k]); // bounded Object.keys of a plain object — not an injection sink
    }
    return out;
  }
  return value;
}
// `describe` is imported so the helper block above does not get flagged as unused when DSN is absent.
void describe;
