/**
 * Per-PR review mutex — 1:1 port of the frozen Python `codemaster/concurrency/pr_mutex.py`
 * (Sprint 4 / S4.1.7; lease-based redesign ADR-0064). Atomic acquire / release for the per-PR
 * review lock.
 *
 * - Postgres `pg_try_advisory_xact_lock(<key1>, <key2>)` serializes only the acquire critical
 *   section. The lock is TRANSACTION-scoped — auto-released on commit/rollback (including process
 *   kill) — so it provides no liveness signal once the acquiring transaction commits.
 * - The **lease** (`lease_expires_at`) is the liveness signal. A live row whose lease is in the
 *   future is held; once the lease expires (a dead/wedged holder failed to renew) the row is
 *   reclaimable — the next acquire (or the janitor) marks it released and inserts a fresh row.
 * - A `core.pr_review_mutex` row is the *visibility* record (admin console + janitor). Its
 *   partial-unique index `uq_pr_review_mutex_live_pr` (WHERE released_at IS NULL) keeps at most one
 *   live row per PR.
 *
 * The advisory lock keys are derived deterministically from `(installation_id, repository_id,
 * pr_number)` via SHA-256 truncated to two 31-bit positive ints (Postgres advisory keys are signed
 * BIGINT, but `pg_advisory_lock(int4, int4)` is the safest collision-resistant form).
 *
 * Invariant: an `acquire` either inserts the visibility row + returns `acquired=true`, OR returns
 * `acquired=false` with the prior holder's workflow_id. Never returns success without both.
 *
 * ## Transaction / connection contract
 *
 * The advisory xact lock + the `FOR UPDATE` SELECT + the INSERT MUST run in ONE transaction on ONE
 * connection (the `xact_lock` form auto-releases on commit/rollback). Mirroring the Python helper —
 * which takes a SQLAlchemy `AsyncSession` whose transaction the caller commits — these functions
 * take the caller's already-open transaction connection (a `pg.PoolClient` obtained from the shared
 * ADR-0062 pool via {@link getPool} and put into a transaction with `BEGIN`). The caller commits as
 * part of the surrounding workflow activity. {@link withMutexTransaction} is a thin helper that
 * checks out one client from the shared pool, runs `BEGIN`/`COMMIT`/`ROLLBACK`, and releases it.
 *
 * ## Clock authority (M1)
 *
 * The DB `now()` is the SINGLE authority for the lease (avoids pod/DB skew). The injected `clock` is
 * RETAINED on the acquire signature for call-site stability but is NOT used for lease timestamps —
 * `lease_expires_at = now() + make_interval(secs => ttl)` is computed in SQL. (Only
 * {@link releasePrReviewMutex} uses the injected clock, for the `released_at` audit timestamp, 1:1
 * with the Python `release_pr_review_mutex`.)
 */

import { createHash } from "node:crypto";

import { type Pool, type PoolClient } from "pg";

import { type Clock } from "#platform/clock.js";

/**
 * Namespace string mixed into the hash so this lock can never collide with another caller's
 * pg_advisory_lock usage in the same DB. Verbatim from the Python constant.
 */
export const PR_REVIEW_MUTEX_LOCK_NAMESPACE = "codemaster:pr_review_mutex:v1";

/**
 * 30 min — deliberately LONGER than the worst-case single review stage. Cost-safety: a mid-review
 * lease expiry would let the janitor / a re-push steal it and start a 2nd concurrent review (double
 * Bedrock). The workflow renews well within this window; a DEAD review's lease expires in <=30 min
 * and is reclaimed (or instantly on the next push via heal-on-contact).
 *
 * Expressed in SECONDS (the unit the SQL `make_interval(secs => ...)` consumes), matching the
 * Python `timedelta(minutes=30).total_seconds()`.
 */
export const DEFAULT_LEASE_TTL_SECONDS = 30 * 60;

/**
 * Raised when the helper detects a state that should not occur (e.g. advisory lock acquired but the
 * visibility row insert failed). Indicates infra trouble, not a caller bug. 1:1 with the Python
 * `PrReviewMutexInvariantError(RuntimeError)`.
 */
export class PrReviewMutexInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PrReviewMutexInvariantError";
  }
}

/**
 * Stable shape returned by {@link acquirePrReviewMutex}. The runtime VALUE shape mirrors the
 * `AcquireResultV1` Zod contract (libs/contracts/src/acquire_result.v1.ts); this in-process type is
 * the convenient native form (UUIDs as strings, since `pg` returns `uuid` columns as strings).
 */
export type AcquireResult = {
  acquired: boolean;
  mutexId: string | null;
  holderWorkflowId: string | null;
};

/**
 * Derive `(key1, key2)` for `pg_try_advisory_xact_lock(int4, int4)`. EXACT port of the Python
 * `_advisory_keys`: SHA-256 of `"<namespace>|<installation_id>|<repository_id>|<pr_number>"`, then
 * the first two big-endian unsigned 32-bit words masked to 31 bits so both are positive (Postgres
 * advisory keys are 4-byte SIGNED int when called as int4,int4).
 */
export function advisoryKeys(
  installationId: string,
  repositoryId: string,
  prNumber: number,
): [number, number] {
  const payload = `${PR_REVIEW_MUTEX_LOCK_NAMESPACE}|${installationId}|${repositoryId}|${prNumber}`;
  const digest = createHash("sha256").update(payload, "utf-8").digest();
  // struct.unpack("!I", ...) is big-endian unsigned 32-bit; mask to 31 bits (0x7FFFFFFF) so we
  // always pass positive numbers to the int4 advisory-lock args.
  const k1 = digest.readUInt32BE(0) & 0x7fff_ffff;
  const k2 = digest.readUInt32BE(4) & 0x7fff_ffff;
  return [k1, k2];
}

type ExistingLiveRow = {
  mutex_id: string;
  holder_workflow_id: string;
  lease_valid: boolean;
};

/**
 * Atomically acquire the live mutex for `(install, repo, PR)`. Returns `acquired=true` with the new
 * `mutexId` on success, or `acquired=false` with the prior holder's `holderWorkflowId` when another
 * caller already holds it (live lease) or is momentarily holding the advisory lock.
 *
 * Must be called on a connection inside an OPEN transaction (the `xact_lock` form auto-releases on
 * commit/rollback). The caller commits as part of the surrounding workflow activity. Use
 * {@link withMutexTransaction} to obtain such a connection from the shared pool.
 *
 * @param clock RETAINED for call-site stability (M1: the DB `now()` is the lease authority) — NOT
 *   used for lease timestamps. Marked as consumed via `void` to satisfy no-unused-vars.
 */
export async function acquirePrReviewMutex(args: {
  client: PoolClient;
  installationId: string;
  repositoryId: string;
  prNumber: number;
  holderWorkflowId: string;
  clock: Clock;
  leaseTtlSeconds?: number;
}): Promise<AcquireResult> {
  const {
    client,
    installationId,
    repositoryId,
    prNumber,
    holderWorkflowId,
    leaseTtlSeconds = DEFAULT_LEASE_TTL_SECONDS,
  } = args;
  // M1: the injected clock is retained on the signature for call-site stability but is NOT used for
  // lease timestamps — the DB `now()` is the single lease authority. Mark consumed.
  void args.clock;

  if (prNumber <= 0) {
    throw new RangeError(`pr_number must be > 0; got ${prNumber}`);
  }

  const [k1, k2] = advisoryKeys(installationId, repositoryId, prNumber);

  const locked = await client.query<{ pg_try_advisory_xact_lock: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1, $2)",
    [k1, k2],
  );
  if (!locked.rows[0]?.pg_try_advisory_xact_lock) {
    // A concurrent acquire for this PR holds the advisory lock right now (momentary). Report busy
    // with the current holder. (Tenant-filtered: installation_id is in the WHERE clause.)
    const prior = await client.query<{ holder_workflow_id: string }>(
      "SELECT holder_workflow_id FROM core.pr_review_mutex " +
        "WHERE installation_id = $1 AND repository_id = $2 " +
        " AND pr_number = $3 AND released_at IS NULL",
      [installationId, repositoryId, prNumber],
    );
    return {
      acquired: false,
      mutexId: null,
      holderWorkflowId: prior.rows[0]?.holder_workflow_id ?? null,
    };
  }

  // Inspect the live row under the advisory lock (serialized). A NULL lease is NOT valid
  // (legacy/old-writer rows are reclaimable). lease_valid is computed by the DB clock.
  const existingRes = await client.query<ExistingLiveRow>(
    "SELECT mutex_id, holder_workflow_id, " +
      "       (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_valid " +
      "FROM core.pr_review_mutex " +
      "WHERE installation_id = $1 AND repository_id = $2 " +
      " AND pr_number = $3 AND released_at IS NULL " +
      "FOR UPDATE",
    [installationId, repositoryId, prNumber],
  );
  const existing = existingRes.rows[0];

  if (existing !== undefined) {
    if (existing.lease_valid) {
      return {
        acquired: false,
        mutexId: null,
        holderWorkflowId: existing.holder_workflow_id,
      };
    }
    // Expired / NULL lease => dead/wedged holder. Reclaim: mark the old row released (preserve as
    // audit), then insert fresh. (Tenant-filtered: installation_id is in the WHERE clause.)
    await client.query(
      "UPDATE core.pr_review_mutex SET released_at = now() " +
        "WHERE installation_id = $1 AND mutex_id = $2 AND released_at IS NULL",
      [installationId, existing.mutex_id],
    );
  }

  // The DB mints mutex_id via its `gen_random_uuid()` default and RETURNS it — so we never touch the
  // randomness seam, and the DB `now()` authors both acquired_at and lease_expires_at.
  const inserted = await client.query<{ mutex_id: string }>(
    "INSERT INTO core.pr_review_mutex " +
      "(installation_id, repository_id, pr_number, holder_workflow_id, " +
      " acquired_at, lease_expires_at, released_at) " +
      "VALUES ($1, $2, $3, $4, now(), now() + make_interval(secs => $5), NULL) " +
      "RETURNING mutex_id",
    [installationId, repositoryId, prNumber, holderWorkflowId, leaseTtlSeconds],
  );
  const mutexId = inserted.rows[0]?.mutex_id;
  if (mutexId === undefined) {
    throw new PrReviewMutexInvariantError(
      "advisory lock held but visibility-row INSERT returned no mutex_id",
    );
  }
  return { acquired: true, mutexId, holderWorkflowId };
}

/**
 * Mark the visibility row as released. The advisory lock auto-releases when the surrounding
 * transaction commits. Idempotent — release on an already-released row is a no-op (the janitor may
 * have swept it). 1:1 with the Python `release_pr_review_mutex` (which uses the injected clock for
 * the `released_at` audit timestamp).
 */
export async function releasePrReviewMutex(args: {
  client: PoolClient;
  installationId: string;
  mutexId: string;
  clock: Clock;
}): Promise<void> {
  const { client, installationId, mutexId, clock } = args;
  // rowcount = 0 is fine — release on an already-released row is a no-op. (Tenant-filtered:
  // installation_id is in the WHERE clause; the Python keys only on mutex_id, but mutex_id is the
  // PK so adding the redundant installation_id predicate is loss-free and keeps the gate clean.)
  await client.query(
    "UPDATE core.pr_review_mutex SET released_at = $1 " +
      "WHERE installation_id = $2 AND mutex_id = $3 AND released_at IS NULL",
    [clock.now(), installationId, mutexId],
  );
}

/**
 * Extend a held mutex's lease (DB clock authoritative). Returns `true` if extended; `false` if the
 * row was already released/reclaimed — the holder LOST ITS CLAIM (steal or janitor sweep). The
 * `false` return is the lost-claim signal the workflow honors to stop a stolen review. 1:1 with the
 * Python `renew_pr_review_mutex_lease`.
 */
export async function renewPrReviewMutexLease(args: {
  client: PoolClient;
  installationId: string;
  mutexId: string;
  leaseTtlSeconds?: number;
}): Promise<boolean> {
  const { client, installationId, mutexId, leaseTtlSeconds = DEFAULT_LEASE_TTL_SECONDS } = args;
  const result = await client.query(
    "UPDATE core.pr_review_mutex " +
      "SET lease_expires_at = now() + make_interval(secs => $1) " +
      "WHERE installation_id = $2 AND mutex_id = $3 AND released_at IS NULL",
    [leaseTtlSeconds, installationId, mutexId],
  );
  return result.rowCount === 1;
}

/**
 * Run `fn` inside a single transaction on ONE checked-out client from the SHARED ADR-0062 pool
 * (so the advisory xact lock + FOR UPDATE + INSERT all run on one connection). Commits on success,
 * rolls back on throw (which also releases the transaction-scoped advisory lock), always releases
 * the client. The caller passes the shared `pool` from `getPool(dsn)` — this helper never builds
 * its own pool, honoring the ADR-0062 pool-memoization invariant.
 */
export async function withMutexTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
