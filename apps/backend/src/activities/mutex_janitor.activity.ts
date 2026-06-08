/**
 * `mutexJanitorActivity` — REAL de-stubbed port of the frozen Python
 * `@activity.defn mutex_janitor_activity`
 * (vendor/codemaster-py/codemaster/activities/mutex_janitor.py).
 *
 * Sweeps `core.pr_review_mutex` rows whose lease has expired (or is NULL — defensive). A row is eligible
 * for sweeping when:
 *   - `released_at IS NULL` (still logically held), AND
 *   - `lease_expires_at IS NULL OR lease_expires_at < now()`.
 *
 * The `IS NULL` disjunct is mandatory in the frozen Python: SQL NULL semantics mean NULL never satisfies
 * `< now()`, so legacy/old-writer rows without a `lease_expires_at` would leak forever without it. (In the
 * current DB the `pr_review_mutex_live_has_lease` CHECK makes a live NULL-lease row unreachable, so the
 * disjunct is purely defensive for pre-CHECK legacy rows — but it is ported byte-faithfully.)
 *
 * Each sweep emits one `audit.audit_events` row (action=`mutex.swept`) so the admin console / ops can see
 * who got cleaned and when.
 *
 * ## Clock authority (the eligibility-vs-stamp split — preserved verbatim)
 *
 * The eligibility predicate `lease_expires_at < now()` uses the DB `now()` (server transaction time). The
 * `released_at` value written by the per-row UPDATE, and the audit `after.released_at` timestamp, come from
 * the INJECTED {@link Clock} (default {@link WallClock}) — NOT the DB `now()`. This split is byte-faithful
 * with the Python (the SELECT uses `now()`; the UPDATE binds `:now = clock.now()`).
 *
 * ## Transaction / commit semantics
 *
 * The whole sweep runs in ONE transaction via {@link withPgTransaction} (BEGIN/COMMIT on a single checked-out
 * client) — the SELECT … FOR UPDATE SKIP LOCKED, every per-row UPDATE, and every audit INSERT commit
 * atomically, mirroring the Python `async with session.begin():`. A throw rolls the whole sweep back.
 *
 * ## Tenancy (cross-tenant by design)
 *
 * The sweep SELECT carries NO `installation_id` filter — it is a cross-tenant liveness sweep (the Python is
 * `@privileged_path`). The raw-SQL tenancy gate requires the `tenant:exempt reason=… follow_up=…` marker on
 * the touching query, present below.
 *
 * ## Runtime context / shared-wiring boundary
 *
 * Runs in the NORMAL Node runtime (DB access sanctioned). Exports the registered activity function only; the
 * Integrate/Workflow phase binds it under the Temporal name `mutex_janitor_activity` and does NOT live here.
 */

import { MutexJanitorResultV1 } from "#contracts/mutex_janitor_result.v1.js";

import { bindAuditContext, emitAuditEvent } from "#backend/audit/emit.js";

import { getPool, withPgTransaction } from "#platform/db/database.js";
import { type Clock, WallClock } from "#platform/clock.js";

/**
 * Injected collaborators. All OPTIONAL — production resolves the shared pool from `CODEMASTER_PG_CORE_DSN`
 * (the ADR-0062 pool) and stamps `released_at` from a {@link WallClock}; tests may inject a disposable-PG
 * `dsn` and a {@link FakeClock}.
 */
export type MutexJanitorDeps = {
  /** DSN for the shared pool; default `CODEMASTER_PG_CORE_DSN`. */
  dsn?: string;
  /** Time seam for the `released_at` stamp + audit `after` timestamp; default {@link WallClock} (1:1 Python). */
  clock?: Clock;
};

/** Resolve the DSN for the shared pool: the injected one, else `CODEMASTER_PG_CORE_DSN`. */
function resolveDsn(deps: MutexJanitorDeps): string {
  if (deps.dsn !== undefined && deps.dsn !== "") {
    return deps.dsn;
  }
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set and no dsn injected; cannot run the mutex janitor",
    );
  }
  return dsn;
}

/** One row claimed by the sweep SELECT — the columns the per-row UPDATE + audit emit need. */
type ExpiredMutexRow = {
  mutex_id: string;
  installation_id: string;
  repository_id: string;
  pr_number: number;
  holder_workflow_id: string;
};

/**
 * The registered activity — sweeps lease-expired live mutex rows in one transaction, releasing each
 * (`released_at` from the injected clock) and emitting an audit row per sweep. Returns the scan/sweep tally.
 */
export async function mutexJanitorActivity(
  deps: MutexJanitorDeps = {},
): Promise<MutexJanitorResultV1> {
  const dsn = resolveDsn(deps);
  const clock: Clock = deps.clock ?? new WallClock();
  const pool = getPool(dsn);

  let scanned = 0;
  let swept = 0;

  await withPgTransaction(pool, async (client) => {
    // Cross-tenant liveness sweep: NO installation_id filter by design (Python @privileged_path). The
    // eligibility predicate `lease_expires_at < now()` uses the DB now() (server transaction time); the
    // `released_at` value written below uses the INJECTED clock — that split is preserved verbatim.
    // tenant:exempt reason=cross-tenant-liveness-sweep follow_up=PERMANENT-EXEMPTION-mutex-janitor
    const expired = await client.query<ExpiredMutexRow>(
      "SELECT mutex_id, installation_id, repository_id, " +
        " pr_number, holder_workflow_id " +
        "FROM core.pr_review_mutex " +
        "WHERE released_at IS NULL " +
        "  AND (lease_expires_at IS NULL OR lease_expires_at < now()) " +
        "FOR UPDATE SKIP LOCKED",
    );
    const rows = expired.rows;
    scanned = rows.length;

    for (const row of rows) {
      const now = clock.now();
      await client.query(
        "UPDATE core.pr_review_mutex SET released_at = $1 " +
          "WHERE mutex_id = $2 AND released_at IS NULL",
        [now, row.mutex_id],
      );
      bindAuditContext(client, { installationId: row.installation_id });
      await emitAuditEvent({
        client,
        actorKind: "system",
        actorId: null,
        action: "mutex.swept",
        targetKind: "pr_review_mutex",
        targetId: String(row.mutex_id),
        before: {
          released_at: null,
          holder_workflow_id: row.holder_workflow_id,
        },
        after: {
          released_at: clock.now().toISOString(),
          reason: "lease_expired",
        },
        clock,
      });
      swept += 1;
    }
  });

  return MutexJanitorResultV1.parse({ scanned, swept });
}
