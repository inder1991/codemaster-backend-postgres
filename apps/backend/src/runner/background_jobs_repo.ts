import { createHash } from "node:crypto"; // sanctioned hashing primitive (clock_random gate bans random.*, NOT createHash)
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { uuid4 } from "#platform/randomness.js";
import { BackgroundJobV1 } from "#contracts/background_job.v1.js";

// Phase 3a W2a (migration 0039): the GENERIC job-platform repo over core.background_jobs, lifting
// the PROVEN ReviewJobsRepo primitives (apps/backend/src/runner/review_jobs_repo.ts) 1:1
// generalized over job_type: canonicalJson+sha256 payload hashing, FOR UPDATE SKIP LOCKED claim
// with lease/attempt_token fencing, heartbeat, fenced settle, backoff re-enqueue, stuck-job reap.
//
// Deliberate divergences from ReviewJobsRepo (mirroring the 0039 schema's divergences from 0036):
//   * payload is an OPAQUE JSON object — the platform has no inner contract; each job_type's
//     HANDLER owns parsing it (the W2b dispatch seam). Opaque is NOT unchecked: enqueue validates
//     it as a strict recursive JSON-value tree (W4c.1 #9 — non-JSON values are rejected BEFORE the
//     INSERT instead of being silently dropped/transformed by JSON.stringify), and verifyPayload
//     proves the stored bytes are intact (hash check) before any handler runs.
//   * last_error / dead_reason / finished_at (migration 0041, W2a.1 review_jobs parity): wired
//     1:1 with ReviewJobsRepo — markDone stamps finished_at; markFailed persists last_error on
//     EVERY failure and dead_reason+finished_at on the terminal one; terminalSettle/reapStuckRuns
//     stamp dead_reason+finished_at. (0039 omitted the triple; 0041 closed the gap.)
//   * NO review_run / PR-mutex lockstep: terminalSettle is the fenced atomic job→dead settle and
//     reapStuckRuns flips stuck jobs→dead in one statement — there is no second row to keep in
//     lockstep, so neither needs the raw-pg transaction ReviewJobsRepo.terminalSettle carries.
//   * dedup_key overlap=SKIP: while an ACTIVE ('ready'|'leased') row holds the key, enqueue
//     returns the EXISTING job_id instead of inserting (uq_background_jobs_dedup_active).
//   * updated_at is maintained app-side (0039 ships no touch-trigger): every UPDATE sets it.

export type EnqueueArgs = {
  jobType: string;
  payload: unknown; // validated inside enqueue: MUST be a plain object of STRICT JSON values (no undefined/function/bigint/NaN/Infinity/Date — W4c.1 #9)
  dedupKey?: string | null;
  installationId?: string | null; // NULL = platform-scoped job (crons, retention, outbox drain)
  priority?: number;
  maxAttempts?: number;
  runAfter?: Date | null;
};
export type FencedResult = { applied: boolean };

/** Thrown by {@link BackgroundJobsRepo.verifyPayload} when the stored payload's hash does not match the stored sha256. */
export class PayloadIntegrityError extends Error {
  constructor(public readonly jobId: string, message: string) {
    super(message);
    this.name = "PayloadIntegrityError";
  }
}

/**
 * Stable, key-ordered JSON encoding (recursively sorts object keys; arrays keep order; primitives pass
 * through) so the same payload always hashes identically across processes/re-runs. Re-implemented
 * IDENTICALLY to review_jobs_repo.ts (the generic platform must not import from the review-specific
 * module); both mirror the codebase's `stableJson`/`sortKeysDeep` idiom — NOT a clock/random surface.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      // `key` is a bounded own-enumerable string key of a plain object (Object.keys) — not an
      // attacker-controlled object-key sink; the prototype-pollution threat model does not apply.
      // eslint-disable-next-line security/detect-object-injection
      sorted[key] = sortKeysDeep(src[key]);
    }
    return sorted;
  }
  return value;
}
/** sha256 hex over a string preimage. `createHash` is the gate-sanctioned hashing primitive. */
function sha256hex(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");
}

// The payload column's shape (BackgroundJobV1.payload): a plain JSON object validated BEFORE the
// INSERT — as a STRICT recursive JSON-value tree (W4c.1 review #9). The previous z.record(z.unknown())
// let non-JSON values (undefined, functions, NaN/±Infinity, bigint, Date, symbol) reach
// JSON.stringify, which silently drops or transforms them (or throws mid-canonicalization, for
// bigint) — so the stored bytes diverged from what the caller handed us while payload_sha256
// vouched for the DIVERGED bytes. Rejecting non-JSON at the boundary keeps "stored payload ≡ what
// the producer enqueued" a real invariant. z.number().finite() rejects NaN/±Infinity; undefined /
// function / bigint / symbol / Date fall outside the union entirely (Zod types Date as its own
// parsed type, never a record), so each is a hard parse error.
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | Array<JsonValue> | { [key: string]: JsonValue };
const JsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(JsonValueSchema)]),
);
const PayloadObject = z.record(JsonValueSchema);

export class BackgroundJobsRepo {
  /** @param db Kysely over the (shared, ADR-0062) pool — drives every fenced single-statement op. */
  constructor(private db: Kysely<unknown>) {}

  /**
   * Insert a job (state `ready`). The payload is validated (plain JSON object), canonicalized and
   * sha256'd at write — {@link verifyPayload} re-proves the pair before any handler runs.
   *
   * dedupKey (the scheduler's overlap=SKIP guard): the INSERT targets the PARTIAL unique index
   * `uq_background_jobs_dedup_active` with `ON CONFLICT ... DO NOTHING`; when no row was inserted
   * (an ACTIVE 'ready'|'leased' row already holds the key) the EXISTING job_id is re-SELECTed and
   * returned — both enqueues observe the SAME job. A terminal (done|dead) row frees the key.
   * The conflict→settle→re-SELECT race (the active holder settles between our two statements) is
   * closed with a bounded retry: the next iteration's INSERT then succeeds against the freed key.
   */
  async enqueue(a: EnqueueArgs): Promise<string> {
    const payload = PayloadObject.parse(a.payload); // throws BEFORE any INSERT — nothing is written
    const canonical = canonicalJson(payload);
    const payloadSha256 = sha256hex(canonical);

    for (let tries = 0; tries < 3; tries++) {
      const jobId = uuid4();
      // The INSERT lists installation_id (tenancy-gate escape hatch (a)) — NULL marks a deliberately
      // platform-scoped (tenant-agnostic) job, hence the marker for the NULL case:
      // tenant:exempt reason=tenant-agnostic-background-job follow_up=PERMANENT-EXEMPTION-platform-scoped-jobs
      const r = await sql<{ job_id: string }>`INSERT INTO core.background_jobs
          (job_id, job_type, installation_id, payload, payload_sha256, priority, max_attempts, run_after, dedup_key)
        VALUES (${jobId}, ${a.jobType}, ${a.installationId ?? null}, CAST(${canonical} AS jsonb), ${payloadSha256},
          ${a.priority ?? 0}, ${a.maxAttempts ?? 3}, COALESCE(CAST(${a.runAfter ?? null} AS timestamptz), now()),
          ${a.dedupKey ?? null})
        ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL AND state IN ('ready','leased') DO NOTHING
        RETURNING job_id`.execute(this.db);
      if (r.rows[0]) return r.rows[0].job_id;
      // overlap=SKIP honored at enqueue: surface the ACTIVE holder's job_id so the caller tracks it.
      // tenant:exempt reason=dedup-key-lookup-platform-scoped follow_up=PERMANENT-EXEMPTION-platform-scoped-jobs
      const existing = await sql<{ job_id: string }>`SELECT job_id FROM core.background_jobs
        WHERE dedup_key = ${a.dedupKey ?? null} AND state IN ('ready','leased')
        LIMIT 1`.execute(this.db);
      if (existing.rows[0]) return existing.rows[0].job_id;
      // The holder settled between INSERT and SELECT — retry; the freed key now accepts our INSERT.
    }
    throw new Error(`enqueue did not converge for dedup_key=${String(a.dedupKey)} (conflict/settle race persisted)`);
  }

  /**
   * Re-derive the stored payload from a job row: re-validate the shape, recompute its canonical hash,
   * and assert it equals the stored `payload_sha256`. The runner calls this BEFORE dispatching to the
   * job_type's handler — a hash mismatch (corruption / out-of-band edit) raises
   * {@link PayloadIntegrityError} so a drifted argument never silently drives a job. The driver hands
   * JSONB back as a JS object; canonicalJson re-orders keys identically to enqueue, so the recomputed
   * hash is stable regardless of the column's internal byte order.
   */
  verifyPayload(job: BackgroundJobV1): Record<string, unknown> {
    const payload = PayloadObject.parse(job.payload);
    const recomputed = sha256hex(canonicalJson(payload));
    if (recomputed !== job.payload_sha256) {
      throw new PayloadIntegrityError(
        job.job_id,
        `payload hash mismatch for job ${job.job_id}: stored=${job.payload_sha256} recomputed=${recomputed}`,
      );
    }
    return payload;
  }

  async getById(jobId: string): Promise<BackgroundJobV1 | null> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=PERMANENT-EXEMPTION-pk-fenced-writes
    const r = await sql<BackgroundJobV1>`SELECT * FROM core.background_jobs WHERE job_id = ${jobId}`.execute(this.db);
    return r.rows[0] ? BackgroundJobV1.parse(r.rows[0]) : null;
  }

  async claim(a: { owner: string; leaseMs: number; maxRuntimeMs: number }): Promise<BackgroundJobV1 | null> {
    // tenant:exempt reason=worker-pool-claim-across-tenants follow_up=PERMANENT-EXEMPTION-worker-pool-claim
    const r = await sql<BackgroundJobV1>`
      UPDATE core.background_jobs SET state = 'leased', lease_owner = ${a.owner}, attempt_token = gen_random_uuid(),
             leased_until = now() + (${a.leaseMs}::double precision / 1000) * interval '1 second',
             timeout_at   = now() + (${a.maxRuntimeMs}::double precision / 1000) * interval '1 second',
             heartbeat_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE job_id = (
          SELECT job_id FROM core.background_jobs
            WHERE (state = 'ready'  AND run_after <= now())
               OR (state = 'leased' AND leased_until < now() AND attempts < max_attempts)  -- maxed crashes are NOT reclaimed
            -- full deterministic order (W4c.1 review #8): created_at then job_id break (priority,
            -- run_after) ties, so concurrent claimers drain equal-priority backlogs in one stable
            -- order and EXPLAIN/plan output is reproducible. Key order matches the partial index
            -- ix_background_jobs_ready_claim (migration 0042); ix_background_jobs_leased_expiry
            -- serves the reclaim arm.
            ORDER BY priority DESC, run_after, created_at, job_id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`.execute(this.db);
    return r.rows[0] ? BackgroundJobV1.parse(r.rows[0]) : null;
  }

  async heartbeat(a: { jobId: string; owner: string; token: string; leaseMs: number }): Promise<boolean> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=PERMANENT-EXEMPTION-pk-fenced-writes
    const r = await sql`UPDATE core.background_jobs
        SET leased_until = now() + (${a.leaseMs}::double precision / 1000) * interval '1 second',
            heartbeat_at = now(), updated_at = now()
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}
        AND (timeout_at IS NULL OR now() < timeout_at)`.execute(this.db);
    return Number(r.numAffectedRows ?? 0n) === 1;
  }

  async markDone(a: { jobId: string; owner: string; token: string }): Promise<FencedResult> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=PERMANENT-EXEMPTION-pk-fenced-writes
    const r = await sql`UPDATE core.background_jobs
        SET state = 'done', finished_at = now(), updated_at = now(),
            leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
      .execute(this.db);
    return { applied: Number(r.numAffectedRows ?? 0n) === 1 };
  }

  /**
   * Fail the current attempt: re-enqueue with exponential backoff while attempts remain, else
   * dead-letter. Fenced exactly like {@link markDone} (owning lease_owner+attempt_token on a
   * still-`leased` row; a stale token affects 0 rows → applied:false). Mirrors
   * ReviewJobsRepo.markFailed (W2a.1 / migration 0041): `last_error` is persisted on EVERY failure
   * (re-enqueue AND dead); the TERMINAL transition additionally stamps dead_reason + finished_at.
   */
  async markFailed(a: { jobId: string; owner: string; token: string; error: string; baseBackoffMs: number }):
    Promise<{ applied: boolean; terminal: boolean }> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=PERMANENT-EXEMPTION-pk-fenced-writes
    const r = await sql<{ terminal: boolean }>`UPDATE core.background_jobs SET
        last_error  = left(${a.error}, 2000),
        state       = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'ready' END,
        dead_reason = CASE WHEN attempts >= max_attempts THEN left(${a.error}, 2000) ELSE dead_reason END,
        finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE finished_at END,
        -- exponential backoff with ±25% jitter (avoid a herd re-claiming after an incident):
        run_after   = now() + ((${a.baseBackoffMs}::double precision * power(2, attempts - 1)) * (0.75 + random() * 0.5) / 1000) * interval '1 second',
        lease_owner = NULL, attempt_token = NULL, leased_until = NULL, timeout_at = NULL, heartbeat_at = NULL,
        updated_at  = now()
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}
      RETURNING (state = 'dead') AS terminal`.execute(this.db);
    return { applied: r.rows.length === 1, terminal: r.rows[0]?.terminal ?? false };
  }

  /**
   * Defer a THROTTLED attempt to `runAfter` WITHOUT consuming an attempt (CS4.4 — H3/RC6/XH2): the
   * rate-limit settle. Re-enqueues 'ready' at the caller's hint instant (the runner derives it via
   * retry_hints.ts — Retry-After/resetAt, capped) and DECREMENTS `attempts` back: `claim` charges
   * the attempt up-front, and a throttle is the ENVIRONMENT refusing the work, not the work
   * failing — so it must never march a job toward 'dead' (markFailed's exhaustion CASE is absent
   * here BY DESIGN; a perpetually-throttled job stays 'ready', visible on run_after/last_error).
   * `last_error` still records the throttle forensically. Fenced exactly like {@link markFailed}.
   */
  async deferRetry(a: { jobId: string; owner: string; token: string; error: string; runAfter: Date }):
    Promise<FencedResult> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=PERMANENT-EXEMPTION-pk-fenced-writes
    const r = await sql`UPDATE core.background_jobs SET
        last_error  = left(${a.error}, 2000),
        state       = 'ready',
        attempts    = GREATEST(attempts - 1, 0),
        run_after   = ${a.runAfter},
        lease_owner = NULL, attempt_token = NULL, leased_until = NULL, timeout_at = NULL, heartbeat_at = NULL,
        updated_at  = now()
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}
      RETURNING job_id`.execute(this.db);
    return { applied: r.rows.length === 1 };
  }

  /**
   * Terminally settle a job → `dead` REGARDLESS of attempts remaining (the poison-pill / operator
   * path) — it is never re-enqueued. Fenced exactly like {@link markDone}. Atomic by construction:
   * ONE fenced UPDATE (the generic platform has no review_run/mutex second row to keep in lockstep,
   * unlike ReviewJobsRepo.terminalSettle's job+run transaction). Mirrors the review_jobs dead branch
   * (W2a.1 / migration 0041): `reason` lands on dead_reason and finished_at is stamped.
   */
  async terminalSettle(a: { jobId: string; owner: string; token: string; reason: string }): Promise<FencedResult> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=PERMANENT-EXEMPTION-pk-fenced-writes
    const r = await sql`UPDATE core.background_jobs
        SET state = 'dead', dead_reason = left(${a.reason}, 2000), finished_at = now(), updated_at = now(),
            leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
      .execute(this.db);
    return { applied: Number(r.numAffectedRows ?? 0n) === 1 };
  }

  /**
   * The stuck-job reaper (liveness backstop): every job whose lease EXPIRED with attempts EXHAUSTED
   * — `state='leased' AND leased_until < now() AND attempts >= max_attempts`, i.e. the rows
   * {@link claim} will NEVER reclaim — is flipped → `dead` with ALL lease metadata cleared and the
   * dead-letter columns stamped (dead_reason COALESCE'd + finished_at, mirroring
   * ReviewJobsRepo.reapStuckRuns step 1 — W2a.1 / migration 0041). An expired lease with attempts
   * REMAINING is deliberately LEFT for claim() to reclaim. ONE statement, cross-tenant by design
   * (it MUST see every tenant's stuck jobs). Returns the count.
   */
  async reapStuckRuns(): Promise<number> {
    // tenant:exempt reason=worker-pool-claim-across-tenants follow_up=PERMANENT-EXEMPTION-worker-pool-claim
    const r = await sql<{ job_id: string }>`UPDATE core.background_jobs
        SET state = 'dead',
            dead_reason = COALESCE(dead_reason, 'lease expired with attempts exhausted (stuck run)'),
            finished_at = now(), updated_at = now(),
            leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
      WHERE state = 'leased' AND leased_until < now() AND attempts >= max_attempts
      RETURNING job_id`.execute(this.db);
    return r.rows.length;
  }
}
