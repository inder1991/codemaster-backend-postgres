import { createHash } from "node:crypto"; // sanctioned hashing primitive (clock_random gate bans random.*, NOT createHash)
import { type Kysely, sql } from "kysely";
import { uuid4 } from "#platform/randomness.js";
import { ReviewJobV1 } from "#contracts/review_jobs.v1.js";
import { ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";

// D1 (migration 0037): core.review_jobs is the durable workflow-argument store. enqueue REQUIRES a valid
// ReviewPullRequestPayloadV1 (inner schema_version=2); it is canonicalized + sha256'd at write, and
// verifyPayload re-parses + re-hashes it in the shell before running, so a corrupted/drifted row is caught.
export const JOB_PAYLOAD_SCHEMA_VERSION = 1; // F1: storage-envelope version (NOT the payload's inner schema_version=2)

export type EnqueueArgs = { runId: string; reviewId: string; installationId: string;
  payload: unknown; // validated inside enqueue via ReviewPullRequestPayloadV1.parse (D1)
  deliveryId?: string | null; priority?: number; maxAttempts?: number };
export type FencedResult = { applied: boolean };

/** Thrown by {@link ReviewJobsRepo.verifyPayload} when the stored payload's hash does not match the stored sha256. */
export class PayloadIntegrityError extends Error {
  constructor(public readonly jobId: string, message: string) {
    super(message);
    this.name = "PayloadIntegrityError";
  }
}

/**
 * Stable, key-ordered JSON encoding (recursively sorts object keys; arrays keep order; primitives pass
 * through) so the same payload always hashes identically across processes/re-runs. Mirrors the codebase's
 * `stableJson`/`sortKeysDeep` idiom (ingest/_workflow_events_repository.ts) — NOT a clock/random surface.
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

export class ReviewJobsRepo {
  constructor(private db: Kysely<unknown>) {}

  async enqueue(a: EnqueueArgs): Promise<string> {
    // D1: the job becomes the durable workflow-argument store. (1) validate the inner contract
    // (schema_version MUST be 2 — review_pull_request.v1.ts); an invalid payload throws here, BEFORE any
    // INSERT, so nothing is written. (2) canonicalize + (3) hash; (4) store payload + envelope version + sha.
    const payload = ReviewPullRequestPayloadV1.parse(a.payload);
    const canonical = canonicalJson(payload);
    const payloadSha256 = sha256hex(canonical);
    const jobId = uuid4();
    // The INSERT lists installation_id ⇒ raw-SQL tenancy gate escape hatch (a) is satisfied (no marker needed).
    await sql`INSERT INTO core.review_jobs
        (job_id, run_id, review_id, installation_id, delivery_id, priority, max_attempts,
         job_payload_schema_version, payload, payload_sha256)
      VALUES (${jobId}, ${a.runId}, ${a.reviewId}, ${a.installationId},
        ${a.deliveryId ?? null}, ${a.priority ?? 0}, ${a.maxAttempts ?? 3},
        ${JOB_PAYLOAD_SCHEMA_VERSION}, CAST(${canonical} AS jsonb), ${payloadSha256})`.execute(this.db);
    return jobId;
  }

  /**
   * Re-derive the typed workflow argument from a job row: parse the stored `payload` through
   * {@link ReviewPullRequestPayloadV1}, recompute its canonical hash, and assert it equals the stored
   * `payload_sha256`. The shell calls this BEFORE running — a hash mismatch (corruption / out-of-band edit)
   * raises {@link PayloadIntegrityError} so a drifted argument never silently drives a review.
   *
   * The driver hands JSONB back as a JS object; canonicalJson re-orders keys identically to enqueue, so the
   * recomputed hash is stable regardless of the column's internal byte order.
   */
  verifyPayload(job: ReviewJobV1): ReviewPullRequestPayloadV1 {
    const raw = (job as Record<string, unknown>)["payload"];
    const payload = ReviewPullRequestPayloadV1.parse(raw);
    const recomputed = sha256hex(canonicalJson(payload));
    const stored = (job as Record<string, unknown>)["payload_sha256"];
    if (recomputed !== stored) {
      throw new PayloadIntegrityError(
        job.job_id,
        `payload hash mismatch for job ${job.job_id}: stored=${String(stored)} recomputed=${recomputed}`,
      );
    }
    return payload;
  }

  async getById(jobId: string): Promise<ReviewJobV1 | null> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql<ReviewJobV1>`SELECT * FROM core.review_jobs WHERE job_id = ${jobId}`.execute(this.db);
    return r.rows[0] ? ReviewJobV1.parse(r.rows[0]) : null;
  }

  async claim(a: { owner: string; leaseMs: number; maxRuntimeMs: number }): Promise<ReviewJobV1 | null> {
    // tenant:exempt reason=worker-pool-claim-across-tenants follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql<ReviewJobV1>`
      UPDATE core.review_jobs SET state = 'leased', lease_owner = ${a.owner}, attempt_token = gen_random_uuid(),
             leased_until = now() + (${a.leaseMs}::double precision / 1000) * interval '1 second',
             timeout_at   = now() + (${a.maxRuntimeMs}::double precision / 1000) * interval '1 second',
             heartbeat_at = now(), started_at = COALESCE(started_at, now()), attempts = attempts + 1
        WHERE job_id = (
          SELECT job_id FROM core.review_jobs
            WHERE (state = 'ready'  AND run_after <= now())
               OR (state = 'leased' AND leased_until < now() AND attempts < max_attempts)  -- maxed crashes are NOT reclaimed
            ORDER BY priority DESC, run_after FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`.execute(this.db);
    return r.rows[0] ? ReviewJobV1.parse(r.rows[0]) : null;
  }

  async heartbeat(a: { jobId: string; owner: string; token: string; leaseMs: number }): Promise<boolean> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql`UPDATE core.review_jobs
        SET leased_until = now() + (${a.leaseMs}::double precision / 1000) * interval '1 second', heartbeat_at = now()
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}
        AND (timeout_at IS NULL OR now() < timeout_at)`.execute(this.db);
    return Number(r.numAffectedRows ?? 0n) === 1;
  }

  async markDone(a: { jobId: string; owner: string; token: string }): Promise<FencedResult> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql`UPDATE core.review_jobs
        SET state = 'done', finished_at = now(),
            leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
      .execute(this.db);
    return { applied: Number(r.numAffectedRows ?? 0n) === 1 };
  }

  async markFailed(a: { jobId: string; owner: string; token: string; error: string; baseBackoffMs: number }):
    Promise<{ applied: boolean; terminal: boolean }> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql<{ terminal: boolean }>`UPDATE core.review_jobs SET
        last_error  = left(${a.error}, 2000),
        state       = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'ready' END,
        dead_reason = CASE WHEN attempts >= max_attempts THEN left(${a.error}, 2000) ELSE dead_reason END,
        finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE finished_at END,
        -- exponential backoff with ±25% jitter (avoid a herd re-claiming after an LLM/GitHub incident):
        run_after   = now() + ((${a.baseBackoffMs}::double precision * power(2, attempts - 1)) * (0.75 + random() * 0.5) / 1000) * interval '1 second',
        lease_owner = NULL, attempt_token = NULL, leased_until = NULL, timeout_at = NULL, heartbeat_at = NULL
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}
      RETURNING (state = 'dead') AS terminal`.execute(this.db);
    return { applied: r.rows.length === 1, terminal: r.rows[0]?.terminal ?? false };
  }

  async reapCrashLooped(): Promise<number> {
    // tenant:exempt reason=watchdog-sweep-across-tenants follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql`UPDATE core.review_jobs
        SET state = 'dead', dead_reason = COALESCE(dead_reason, 'lease expired with attempts exhausted (crash loop)'),
            finished_at = now(),
            leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
      WHERE state = 'leased' AND leased_until < now() AND attempts >= max_attempts`.execute(this.db);
    return Number(r.numAffectedRows ?? 0n);
  }
}
