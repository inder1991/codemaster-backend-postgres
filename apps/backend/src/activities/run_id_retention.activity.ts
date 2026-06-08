/**
 * run_id retention janitor activities — REAL de-stubbed ports of the frozen Python
 * `@activity.defn run_id_close_stale_prs` / `run_id_retire_old_runs` / `run_id_delete_old_events`
 * (vendor/codemaster-py/codemaster/activities/run_id_retention.py). Phase 5 of the run_id
 * execution-causality refactor.
 *
 * Three sweeps the {@link runIdRetentionWorkflow} composes sequentially (close → retire → delete):
 *
 *  1. {@link runIdCloseStalePrsActivity} (registered `run_id_close_stale_prs`)
 *     Sweeps `core.review_runs` rows where `is_ephemeral = true` AND `retired_at IS NULL` AND
 *     `started_at < now() - ttl` AND the installation is not suspended, then for each issues a
 *     GitHub list-PRs-by-head call and PATCH-closes the matching open PR. Audit-emits
 *     `retention.smoke_pr.closed` per success (one fresh transaction per close — a single failed
 *     audit cannot taint the rest of the sweep). Per-row fail-open on any GitHub error.
 *
 *  2. {@link runIdRetireOldRunsActivity} (registered `run_id_retire_old_runs`)
 *     Batched soft-delete of terminal (`COMPLETED`/`FAILED`) `review_runs` older than ttl. Sets
 *     `retired_at` + `retention_reason='ttl_expired'` via `UPDATE … RETURNING` so concurrent
 *     supersede races resolve naturally (only confirmed-transitioned rows appear in RETURNING, and
 *     only those trigger audit emit). LEFT JOIN to pull_request_reviews + repositories preserves
 *     orphan rows: they are STILL retired but emit to `audit.workflow_events` under system context
 *     (tagged `orphan_reason='orphan_retire'`), not `audit.audit_events`.
 *
 *  3. {@link runIdDeleteOldEventsActivity} (registered `run_id_delete_old_events`)
 *     Hard-deletes `audit.workflow_events` rows older than ttl in bounded batches. No per-row audit
 *     emit — the rows are correlation transients, NOT tenant-scoped actions. The composite-key
 *     `WHERE (event_id, received_at) IN (...)` DELETE form is required by the partitioned-parent
 *     shape (PK is `(event_id, received_at)`).
 *
 * ## Archive-before-DELETE? NO.
 *
 * Neither DB sweep does an archive-before-DELETE. Sweep 2 is a SOFT delete (`UPDATE … SET retired_at`
 * — the row stays, just flagged), so there is nothing to archive. Sweep 3 is a hard DELETE of
 * correlation transients (workflow_events) with NO archive table — 1:1 with the frozen Python, which
 * deletes them outright (they are not recoverable business state; the compact lifecycle truth lives on
 * `core.review_runs`). This is faithful to the Python; it is NOT the archive-before-DELETE migration
 * pattern (that governs migrations, not this runtime janitor).
 *
 * ## TTL source (divergence from the Python — workflow-arg injection, not env/platform_config)
 *
 * The frozen Python workflow body passes `ttl_days` to each activity as a positional arg pinned at
 * Schedule registration (`args=[7, 30, 90]`). Faithful 1:1: the TS activities take `ttlDays` as an
 * injected dep ({@link RetentionSweepDeps.ttlDays}) and the {@link runIdRetentionWorkflow} supplies it
 * via the typed proxy args. Production resolves the same `[7, 30, 90]` defaults the Python pins (see
 * {@link DEFAULT_PR_TTL_DAYS} etc.); an injected `ttlDays` (tests) takes precedence.
 *
 * ## Cross-tenant by design (Python `_CANDIDATE_SQL` / retire / delete carry NO installation_id filter)
 *
 * All three sweeps are cross-tenant liveness/retention scans (the Python guards them by running inside
 * the privileged retention workflow). The raw-SQL tenancy gate accepts the inline
 * `// tenant:exempt reason=… follow_up=…` marker on each touching query.
 *
 * ## Clock authority
 *
 * The cutoff (`clock.now() - ttl`) and every audit `created_at` come from the INJECTED {@link Clock}
 * (default {@link WallClock}) — 1:1 with the Python `clock.now()`. (The Python uses the injected clock
 * for the cutoff too, NOT the DB `now()` — preserved verbatim.)
 *
 * ## OTel counters (ported inline per the metrics-seam convention)
 *
 * Counters are emitted via the {@link PendingEmits} post-commit collector where the Python uses
 * `emit_after_commit` (BF-15 drop-on-rollback), and inline (immediate) where the Python emits inline
 * (the events-deleted counter). Counter NAMES are copied verbatim from the Python so the deferred
 * name-parity gate + existing dashboards map unchanged. Per-installation labels are preserved only
 * where the Python uses them (the per-close audit counter).
 *
 * ## Runtime context / shared-wiring boundary
 *
 * Runs in the NORMAL Node runtime (DB + GitHub access sanctioned). Exports the three registered activity
 * functions only; the Integrate/Workflow phase binds them under their Temporal names + owns the worker
 * registry — NOT this module.
 */

import { type PoolClient } from "pg";

import {
  type GitHubApiClient,
  GitHubClientError,
  GitHubForbiddenError,
  GitHubNotFoundError,
  GitHubRateLimitExceeded,
  GitHubAppUnauthorized,
} from "#backend/integrations/github/api_client.js";

import { bindAuditContext, emitAuditEvent } from "#backend/audit/emit.js";
import { emitWorkflowEvent } from "#backend/ingest/_workflow_events_repository.js";
import { PendingEmits, emitAfterCommit } from "#backend/infra/post_commit_emit.js";

import { getPool, withPgTransaction } from "#platform/db/database.js";
import { type Clock, WallClock } from "#platform/clock.js";
import { getMeter, type Counter } from "#platform/observability/metrics.js";

import { CompiledQuery, Kysely, PostgresDialect, type Transaction } from "kysely";
import { Pool as PgPool } from "pg";

import {
  EventsRetentionResultV1,
  RunsRetentionResultV1,
  StalePrCloserResultV1,
} from "#contracts/retention.v1.js";

// ─── Production TTL defaults (1:1 with the Python schedule args [7, 30, 90]) ─────────────────────────

/** Default PR-closer TTL — ephemeral smoke PRs older than 7 days get closed (Python `args=[7, …]`). */
export const DEFAULT_PR_TTL_DAYS = 7;
/** Default run-retire TTL — terminal runs older than 30 days get soft-deleted (Python `args=[…, 30, …]`). */
export const DEFAULT_RUN_TTL_DAYS = 30;
/** Default event-delete TTL — workflow_events older than 90 days get hard-deleted (Python `args=[…, 90]`). */
export const DEFAULT_EVENT_TTL_DAYS = 90;

/** Batch sizing for the retire sweep — 1:1 with the Python defaults (batch_size=1000, max_batches=50). */
const RETIRE_BATCH_SIZE = 1000;
const RETIRE_MAX_BATCHES = 50;
/** Batch sizing for the events sweep — 1:1 with the Python defaults (batch_size=5000, max_batches=200). */
const EVENTS_BATCH_SIZE = 5000;
const EVENTS_MAX_BATCHES = 200;

// ─── OTel meter + counters (names copied verbatim from the Python) ───────────────────────────────────

const METER = getMeter("codemaster.retention");

const PRS_CLOSED: Counter = METER.createCounter("codemaster_retention_prs_closed_total", {
  description: "Stale codemaster/run_* PRs closed by the retention janitor.",
});
const PRS_SKIPPED: Counter = METER.createCounter("codemaster_retention_prs_skipped_total", {
  description: "PRs scanned by the retention janitor but not closed.",
});
const RUNS_RETIRED: Counter = METER.createCounter("codemaster_retention_runs_retired_total", {
  description: "review_runs rows soft-deleted by the retention janitor.",
});
const RUNS_RETIRED_ORPHAN: Counter = METER.createCounter(
  "codemaster_retention_runs_retired_orphan_total",
  {
    description:
      "Retired runs whose review row was missing — emit went to workflow_events under system context.",
  },
);
const EVENTS_DELETED: Counter = METER.createCounter("codemaster_retention_events_deleted_total", {
  description: "audit.workflow_events rows hard-deleted by the retention janitor.",
});

// ─── Shared deps ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Injected collaborators shared by all three sweeps. All OPTIONAL — production resolves the shared pool
 * from `CODEMASTER_PG_CORE_DSN` (the ADR-0062 pool), stamps the cutoff + audit `created_at` from a
 * {@link WallClock}, and pins `ttlDays` to the per-sweep default; tests inject a disposable-PG `dsn`, a
 * {@link FakeClock}, and/or a fixed `ttlDays`.
 */
export type RetentionSweepDeps = {
  /** DSN for the shared pool; default `CODEMASTER_PG_CORE_DSN`. */
  dsn?: string;
  /** Time seam for the cutoff + audit `created_at`; default {@link WallClock} (1:1 with the Python). */
  clock?: Clock;
  /** Retention TTL in days; default is the per-sweep production default (PR=7, run=30, event=90). */
  ttlDays?: number;
};

/** PR-closer needs the GitHub client in addition to the shared deps. */
export type ClosePrsDeps = RetentionSweepDeps & {
  /** The GitHub App-token client used to list + close PRs. REQUIRED in production (no env fallback). */
  githubClient: GitHubApiClient;
};

/** Resolve the DSN for the shared pool: the injected one, else `CODEMASTER_PG_CORE_DSN`. */
function resolveDsn(deps: RetentionSweepDeps): string {
  if (deps.dsn !== undefined && deps.dsn !== "") {
    return deps.dsn;
  }
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set and no dsn injected; cannot run the run_id retention sweep",
    );
  }
  return dsn;
}

/** Resolve the TTL: the injected one, else the per-sweep production default. Validated ≥ 1. */
function resolveTtlDays(deps: RetentionSweepDeps, fallback: number): number {
  const ttl = deps.ttlDays ?? fallback;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error(`ttlDays must be an integer >= 1, got ${ttl}`);
  }
  return ttl;
}

/** Compute the cutoff instant: `clock.now() - ttlDays`. 1:1 with the Python `clock.now() - timedelta(days=…)`. */
function cutoffFor(clock: Clock, ttlDays: number): Date {
  return new Date(clock.now().getTime() - ttlDays * 24 * 60 * 60 * 1000);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
//  Sweep 1 — run_id_close_stale_prs
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** One candidate ephemeral run resolved with everything the GitHub round-trip + audit row need. */
type CandidateRow = {
  run_id: string;
  branch_name: string;
  review_id: string;
  github_repo_id: string;
  internal_repo_id: string;
  full_name: string;
  internal_installation_id: string;
  github_installation_id: string;
};

/**
 * R1-corrected candidate query — 1:1 with the Python `_CANDIDATE_SQL`. Pre-filters by `is_ephemeral`
 * (the durable authority), joins through pull_request_reviews → repositories → installations so each
 * candidate carries full_name, the bigint github_installation_id, and the internal installation_id UUID.
 */
const CANDIDATE_SQL =
  "SELECT " +
  "    wr.run_id, " +
  "    wr.branch_name, " +
  "    wr.review_id, " +
  "    prr.repo_id            AS github_repo_id, " +
  "    r.repository_id        AS internal_repo_id, " +
  "    r.full_name, " +
  "    r.installation_id      AS internal_installation_id, " +
  "    i.github_installation_id " +
  "FROM core.review_runs wr " +
  "JOIN core.pull_request_reviews prr ON prr.review_id = wr.review_id " +
  "JOIN core.repositories r ON r.github_repo_id = prr.repo_id " +
  "JOIN core.installations i ON i.installation_id = r.installation_id " +
  "WHERE wr.is_ephemeral = true " +
  "  AND wr.retired_at IS NULL " +
  "  AND wr.branch_name IS NOT NULL " +
  "  AND wr.started_at < $1 " +
  "  AND i.suspended_at IS NULL " +
  "ORDER BY wr.started_at";

/** The GitHub client exceptions the per-row fail-open path catches (1:1 with `_GITHUB_CLIENT_EXCS`). */
const GITHUB_CLIENT_ERROR_CTORS = [
  GitHubForbiddenError,
  GitHubNotFoundError,
  GitHubRateLimitExceeded,
  GitHubAppUnauthorized,
  GitHubClientError,
] as const;

function isGitHubClientError(e: unknown): boolean {
  return GITHUB_CLIENT_ERROR_CTORS.some((Ctor) => e instanceof Ctor);
}

/** Map a GitHub client error to the OTel `reason` label bucket — 1:1 with `_classify_github_error`. */
function classifyGitHubError(e: unknown): string {
  if (e instanceof GitHubForbiddenError) return "forbidden";
  if (e instanceof GitHubNotFoundError) return "not_found";
  if (e instanceof GitHubRateLimitExceeded) return "rate_limited";
  return "other_error";
}

/** URL-encode the head filter, leaving `:` and `/` literal — matches the Python `quote(..., safe=":/")`. */
function quoteHeadFilter(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ":").replace(/%2F/gi, "/");
}

/**
 * Return open PRs on `branchName` of `fullName`. 1:1 with `_list_open_pulls_for_branch`: the
 * `GET …/pulls?head={owner}:{branch}&state=open` returns ≤ 1 open PR (a branch heads at most one open
 * PR), so no pagination. The TS GitHub client returns a `body_text` string (not a `.json()` method), so
 * we JSON.parse it; a non-array body yields `[]`.
 */
async function listOpenPullsForBranch(args: {
  githubClient: GitHubApiClient;
  installationId: number;
  fullName: string;
  branchName: string;
}): Promise<Array<Record<string, unknown>>> {
  const owner = args.fullName.split("/", 1)[0] ?? args.fullName;
  const headFilter = `${owner}:${args.branchName}`;
  const path =
    `/repos/${args.fullName}/pulls?head=${quoteHeadFilter(headFilter)}&state=open&per_page=10`;
  const resp = await args.githubClient.get(path, { installationId: args.installationId });
  const text = resp.body_text ?? "";
  if (text === "") return [];
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
}

/** PATCH `…/pulls/{n}` with `state=closed`. 1:1 with `_close_pull`. */
async function closePull(args: {
  githubClient: GitHubApiClient;
  installationId: number;
  fullName: string;
  pullNumber: number;
}): Promise<void> {
  await args.githubClient.patch(`/repos/${args.fullName}/pulls/${args.pullNumber}`, {
    installationId: args.installationId,
    jsonBody: { state: "closed" },
  });
}

/**
 * Emit one `audit.audit_events` row recording a close. Fresh transaction per emit (1:1 with
 * `_emit_close_audit`): so a single failed audit can't taint the rest of the sweep, and the counter
 * increment is queued behind the commit (BF-15 drop-on-rollback).
 */
async function emitCloseAudit(args: {
  poolDsn: string;
  clock: Clock;
  internalInstallationId: string;
  fullName: string;
  pullNumber: number;
}): Promise<void> {
  const pool = getPool(args.poolDsn);
  const pending = new PendingEmits();
  await withPgTransaction(pool, async (client) => {
    bindAuditContext(client, { installationId: args.internalInstallationId });
    await emitAuditEvent({
      client,
      actorKind: "system",
      actorId: null,
      action: "retention.smoke_pr.closed",
      targetKind: "github_pull_request",
      targetId: `${args.fullName}#${args.pullNumber}`,
      before: { state: "open" },
      after: { state: "closed" },
      clock: args.clock,
    });
    // BF-15: queue the counter behind the audit-insert commit so a rolled-back audit row drops the
    // matching increment — no drift between the OTel counter and the audit-event row count.
    emitAfterCommit(pending, () =>
      PRS_CLOSED.add(1, { installation_id: String(args.internalInstallationId) }),
    );
  });
  pending.drain();
}

/** Process one candidate row. Returns `[closedDelta, skippedDelta]`. 1:1 with `_close_one_row`. */
async function closeOneRow(args: {
  row: CandidateRow;
  githubClient: GitHubApiClient;
  poolDsn: string;
  clock: Clock;
}): Promise<[number, number]> {
  const { row } = args;
  const githubInstallationId = Number(row.github_installation_id);

  // Step 1 — find the open PR for this branch (per-row fail-open).
  let pulls: Array<Record<string, unknown>>;
  try {
    pulls = await listOpenPullsForBranch({
      githubClient: args.githubClient,
      installationId: githubInstallationId,
      fullName: row.full_name,
      branchName: row.branch_name,
    });
  } catch (e) {
    if (!isGitHubClientError(e)) throw e;
    const reason = classifyGitHubError(e);
    console.info(
      `retention: list-pulls ${reason} full_name=${row.full_name} branch=${row.branch_name}`,
    );
    PRS_SKIPPED.add(1, { reason });
    return [0, 1];
  }

  if (pulls.length === 0) {
    // No open PR — already closed, or never had one. Skipped (no work), not an error. 1:1 with Python.
    PRS_SKIPPED.add(1, { reason: "not_found" });
    return [0, 1];
  }

  // Step 2 — close each open PR returned (≤ 1 in practice).
  let closed = 0;
  let skipped = 0;
  for (const pull of pulls) {
    const rawNumber = pull["number"];
    const pullNumber = typeof rawNumber === "number" ? rawNumber : Number.NaN;
    if (!Number.isInteger(pullNumber)) {
      console.warn(`retention: malformed pull payload from GitHub: ${JSON.stringify(pull)}`);
      PRS_SKIPPED.add(1, { reason: "other_error" });
      skipped += 1;
      continue;
    }

    try {
      await closePull({
        githubClient: args.githubClient,
        installationId: githubInstallationId,
        fullName: row.full_name,
        pullNumber,
      });
    } catch (e) {
      if (e instanceof GitHubNotFoundError) {
        // BF-28: someone closed it between the list and the close. Desired end-state holds but we did
        // not perform the action — count as skipped to keep `_prs_closed` truthful + avoid a
        // false-attribution audit row. 1:1 with the Python `continue` after the 404 warning.
        console.info(
          `retention: close pre-empted (404) full_name=${row.full_name} pr=${pullNumber}`,
        );
        PRS_SKIPPED.add(1, { reason: "pre_empted" });
        skipped += 1;
        continue;
      }
      if (!isGitHubClientError(e)) throw e;
      const reason = classifyGitHubError(e);
      console.info(
        `retention: close ${reason} full_name=${row.full_name} pr=${pullNumber} err=${String(e)}`,
      );
      PRS_SKIPPED.add(1, { reason });
      skipped += 1;
      continue;
    }

    closed += 1;
    await emitCloseAudit({
      poolDsn: args.poolDsn,
      clock: args.clock,
      internalInstallationId: row.internal_installation_id,
      fullName: row.full_name,
      pullNumber,
    });
  }

  return [closed, skipped];
}

/**
 * `runIdCloseStalePrsActivity` (registered `run_id_close_stale_prs`). Finds ephemeral review_runs older
 * than ttl and closes their open GitHub PRs. Returns `StalePrCloserResultV1{scanned, closed, skipped}`.
 * 1:1 with the Python `_close_stale_prs_impl`.
 */
export async function runIdCloseStalePrsActivity(
  deps: ClosePrsDeps,
): Promise<StalePrCloserResultV1> {
  const dsn = resolveDsn(deps);
  const clock: Clock = deps.clock ?? new WallClock();
  const ttlDays = resolveTtlDays(deps, DEFAULT_PR_TTL_DAYS);
  const cutoff = cutoffFor(clock, ttlDays);
  const pool = getPool(dsn);

  // Step 1 — collect candidates in one short-lived transaction; we do NOT hold the session open across
  // the GitHub round-trips. The per-close audit opens a fresh transaction per close (emitCloseAudit).
  // tenant:exempt reason=cross-tenant-ephemeral-pr-retention-sweep follow_up=PERMANENT-EXEMPTION-run-id-retention
  const rows = await withPgTransaction<ReadonlyArray<CandidateRow>>(pool, async (client) => {
    const result = await client.query<CandidateRow>(CANDIDATE_SQL, [cutoff]);
    return result.rows;
  });

  let scanned = 0;
  let closed = 0;
  let skipped = 0;
  for (const row of rows) {
    scanned += 1;
    const [closedDelta, skippedDelta] = await closeOneRow({
      row,
      githubClient: deps.githubClient,
      poolDsn: dsn,
      clock,
    });
    closed += closedDelta;
    skipped += skippedDelta;
  }

  return StalePrCloserResultV1.parse({ scanned, closed, skipped });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
//  Sweep 2 — run_id_retire_old_runs
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** One retire-candidate row (carries installation_id for the per-tenant audit emit; NULL = orphan). */
type RetireCandidateRow = {
  run_id: string;
  review_id: string;
  started_at: Date;
  installation_id: string | null;
};

/** A Kysely engine over the same pool DSN — emitWorkflowEvent requires a Kysely Transaction handle. */
function kyselyOver(dsn: string): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new PgPool({ connectionString: dsn }) }),
  });
}

/**
 * Run one raw `$N`-parameterized statement on a Kysely transaction and return its rows. The Python
 * retire sweep uses raw `text(...)` SQL (NOT the ORM query builder); this keeps the TS port byte-faithful
 * to that SQL while still threading the SAME Kysely tx that {@link emitWorkflowEvent} requires. Mirrors
 * the `sql\`\`.execute(tx)` idiom in `_workflow_events_repository`.
 */
async function txQuery<R>(
  tx: Transaction<unknown>,
  sqlText: string,
  params: ReadonlyArray<unknown>,
): Promise<ReadonlyArray<R>> {
  const result = await tx.executeQuery<R>(CompiledQuery.raw(sqlText, [...params]));
  return result.rows;
}

/**
 * Adapt a Kysely transaction into the structural `AuditQueryClient` {@link emitAuditEvent} expects.
 * Kysely has no pg-style `.query(sql, params)` method; `emitAuditEvent` emits a `$N`-parameterized
 * INSERT, which is exactly what `CompiledQuery.raw(sql, params)` + `executeQuery` run. We bind the
 * audit tenancy context on THIS adapter object (the one passed as `client`), so `getAuditContext`
 * round-trips off the same key. This is the pg-client AuditQueryClient seam the webhook-persistence note
 * (Stage-1 STUB) deferred — supplied here because the retire sweep genuinely needs emitAuditEvent AND
 * emitWorkflowEvent in one Kysely batch transaction.
 */
function auditClientFor(tx: Transaction<unknown>): {
  query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<{ rows: ReadonlyArray<unknown> }>;
} {
  return {
    query: async (sqlText: string, params: ReadonlyArray<unknown> = []) => {
      const result = await tx.executeQuery(CompiledQuery.raw(sqlText, [...params]));
      return { rows: result.rows };
    },
  };
}

/** SELECT for one retire batch — 1:1 with the Python candidate SQL (LEFT JOINs preserve orphans). */
const RETIRE_CANDIDATE_SQL =
  "SELECT wr.run_id, wr.review_id, wr.started_at, r.installation_id " +
  "FROM core.review_runs wr " +
  "LEFT JOIN core.pull_request_reviews prr ON prr.review_id = wr.review_id " +
  "LEFT JOIN core.repositories r ON r.github_repo_id = prr.repo_id " +
  "WHERE wr.retired_at IS NULL " +
  "  AND wr.lifecycle_state IN ('COMPLETED', 'FAILED') " +
  "  AND wr.started_at < $1 " +
  "ORDER BY wr.started_at " +
  "LIMIT $2 " +
  "FOR UPDATE OF wr SKIP LOCKED";

/** UPDATE … RETURNING for one retire batch — 1:1 with the Python (idempotent under Temporal retry). */
const RETIRE_UPDATE_SQL =
  "UPDATE core.review_runs " +
  "SET retired_at = $1, retention_reason = 'ttl_expired' " +
  "WHERE run_id = ANY($2) " +
  "  AND retired_at IS NULL " +
  "  AND lifecycle_state IN ('COMPLETED', 'FAILED') " +
  "RETURNING run_id, started_at";

/**
 * `runIdRetireOldRunsActivity` (registered `run_id_retire_old_runs`). Batched soft-delete of terminal
 * `review_runs` older than ttl. 1:1 with the Python `_retire_old_runs_impl` R1 invariants:
 *   - `UPDATE … RETURNING` is the source of truth for "what was retired" (NOT the prior SELECT).
 *   - `FOR UPDATE OF wr SKIP LOCKED` lets overlapping janitor runs take disjoint slices.
 *   - Each batch is its own transaction (a mid-sweep failure doesn't roll back prior batches).
 *   - LEFT JOIN preserves orphans: still retired, but emit to workflow_events under system context.
 *   - Sets BOTH `retired_at` and `retention_reason='ttl_expired'`.
 *   - Terminal filter is `COMPLETED`/`FAILED` only (CANCELLED/PARTIAL are durable diagnostic metadata).
 *
 * Returns `RunsRetentionResultV1{scanned, retired}` where both equal `total_retired` (the Python returns
 * scanned=retired=total_retired; orphans are included in total_retired, surfaced separately only via the
 * orphan OTel counter).
 */
export async function runIdRetireOldRunsActivity(
  deps: RetentionSweepDeps,
): Promise<RunsRetentionResultV1> {
  const dsn = resolveDsn(deps);
  const clock: Clock = deps.clock ?? new WallClock();
  const ttlDays = resolveTtlDays(deps, DEFAULT_RUN_TTL_DAYS);
  const cutoff = cutoffFor(clock, ttlDays);
  const kysely = kyselyOver(dsn);

  let totalRetired = 0;
  try {
    for (let batchIdx = 0; batchIdx < RETIRE_MAX_BATCHES; batchIdx += 1) {
      const pending = new PendingEmits();
      let batchHadCandidates = true;

      await kysely.transaction().execute(async (tx) => {
        // The Kysely transaction owns the connection; the SELECT … FOR UPDATE, the UPDATE … RETURNING,
        // every audit/workflow_event emit commit atomically per batch. Raw SQL is byte-faithful with the
        // Python `text(...)` candidate + UPDATE statements.
        // tenant:exempt reason=cross-tenant-run-retention-sweep follow_up=PERMANENT-EXEMPTION-run-id-retention
        const candidates = await txQuery<RetireCandidateRow>(tx, RETIRE_CANDIDATE_SQL, [
          cutoff,
          RETIRE_BATCH_SIZE,
        ]);

        if (candidates.length === 0) {
          batchHadCandidates = false;
          return;
        }

        const runIds = candidates.map((c) => c.run_id);
        const now = clock.now();

        // AUTHORITATIVE: UPDATE … RETURNING returns only rows that actually transitioned. A concurrent
        // supersede that flipped one of our candidates is naturally excluded by the WHERE guards; the
        // `retired_at IS NULL` guard makes the UPDATE idempotent under Temporal retry.
        const retiredRows = await txQuery<{ run_id: string; started_at: Date }>(tx, RETIRE_UPDATE_SQL, [
          now,
          runIds,
        ]);

        if (retiredRows.length === 0) {
          // All candidates lost the race to a concurrent supersede. Move on (this batch contributes 0).
          return;
        }
        const retiredIds = new Set(retiredRows.map((r) => r.run_id));

        // Audit emit ONLY for rows that actually transitioned (iterate candidates → filter to retiredIds
        // so the per-row installation_id context is preserved).
        for (const c of candidates) {
          if (!retiredIds.has(c.run_id)) continue;
          if (c.installation_id === null) {
            // Orphan: review row hard-deleted (no installation_id resolvable). Emit to workflow_events
            // under system context with a tagged orphan_reason — NOT audit_events (no tenancy to bind).
            console.info(
              `retention.workflow_run.retired_orphan run_id=${c.run_id} review_id=${c.review_id}`,
            );
            emitAfterCommit(pending, () => RUNS_RETIRED_ORPHAN.add(1));
            await emitWorkflowEvent({
              dbOrTx: tx,
              provider: "github",
              runId: c.run_id,
              reviewId: c.review_id,
              eventType: "lifecycle_transition",
              payload: {
                to: "retired_orphan",
                reason: "ttl_expired",
                note: "review row missing — system retire",
                orphan_reason: "orphan_retire",
              },
              installationId: null,
              clock,
            });
            continue;
          }
          // Bind the tenancy context on the SAME adapter object passed as `client` so getAuditContext
          // reads it back (the WeakMap keys on the client object).
          const auditClient = auditClientFor(tx);
          bindAuditContext(auditClient, { installationId: c.installation_id });
          await emitAuditEvent({
            client: auditClient,
            actorKind: "system",
            actorId: null,
            action: "retention.workflow_run.retired",
            targetKind: "workflow_run",
            targetId: String(c.run_id),
            before: { retired_at: null },
            after: { retired_at: now.toISOString(), retention_reason: "ttl_expired" },
            clock,
          });
        }

        const retiredCount = retiredRows.length;
        totalRetired += retiredCount;
        emitAfterCommit(pending, () =>
          RUNS_RETIRED.add(retiredCount, { retention_reason: "ttl_expired" }),
        );
      });

      pending.drain();
      if (!batchHadCandidates) break;
    }
  } finally {
    await kysely.destroy();
  }

  // total_retired already covers ALL rows the UPDATE … RETURNING confirmed-transitioned, orphans
  // included. The Python returns scanned=retired=total_retired.
  return RunsRetentionResultV1.parse({ scanned: totalRetired, retired: totalRetired });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
//  Sweep 3 — run_id_delete_old_events
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `runIdDeleteOldEventsActivity` (registered `run_id_delete_old_events`). Hard-deletes
 * `audit.workflow_events` rows older than ttl in bounded batches. 1:1 with `_delete_old_events_impl`:
 *   - No per-row audit emit (workflow_events are correlation transients, not tenant-scoped actions).
 *   - Each batch is its own transaction; `FOR UPDATE SKIP LOCKED` on the inner SELECT lets overlapping
 *     janitor runs coexist.
 *   - Composite-key `WHERE (event_id, received_at) IN (…)` DELETE — required by the partitioned-parent
 *     shape (PK = (event_id, received_at)) so the planner can prune partitions on received_at.
 *   - The OTel `events_deleted` counter is emitted INLINE per batch (1:1 — the Python `_events_deleted`
 *     emit is inline, NOT post-commit; a retry after partial completion may slightly overcount, which
 *     is acceptable for telemetry).
 *
 * Returns `EventsRetentionResultV1{scanned, deleted, batches}` with scanned===deleted (the DELETE fuses
 * candidate-selection with mutation).
 */
export async function runIdDeleteOldEventsActivity(
  deps: RetentionSweepDeps,
): Promise<EventsRetentionResultV1> {
  const dsn = resolveDsn(deps);
  const clock: Clock = deps.clock ?? new WallClock();
  const ttlDays = resolveTtlDays(deps, DEFAULT_EVENT_TTL_DAYS);
  const cutoff = cutoffFor(clock, ttlDays);
  const pool = getPool(dsn);

  let totalDeleted = 0;
  let batchesDone = 0;

  for (let batchIdx = 0; batchIdx < EVENTS_MAX_BATCHES; batchIdx += 1) {
    let rowCount = 0;
    await withPgTransaction(pool, async (client: PoolClient) => {
      // Composite-key DELETE — the partitioned-parent PK is (event_id, received_at), so the inner SELECT
      // returns BOTH and the outer DELETE matches the composite tuple (the planner prunes partitions on
      // received_at). FOR UPDATE SKIP LOCKED lets overlapping janitor runs coexist on hot partitions.
      // tenant:exempt reason=cross-tenant-workflow-events-correlation-transients follow_up=PERMANENT-EXEMPTION-run-id-retention
      const result = await client.query(
        "DELETE FROM audit.workflow_events " +
          "WHERE (event_id, received_at) IN (" +
          "  SELECT event_id, received_at " +
          "  FROM audit.workflow_events " +
          "  WHERE received_at < $1 " +
          "  ORDER BY received_at " +
          "  LIMIT $2 " +
          "  FOR UPDATE SKIP LOCKED" +
          ")",
        [cutoff, EVENTS_BATCH_SIZE],
      );
      rowCount = result.rowCount ?? 0;
    });

    if (rowCount === 0) break;
    totalDeleted += rowCount;
    batchesDone += 1;
    // Inline counter (1:1 with the Python `_events_deleted.add(row_count)` — NOT post-commit).
    EVENTS_DELETED.add(rowCount);
  }

  // Watermark log — surfaces retention lag (oldest still-living event vs cutoff). Always runs.
  await withPgTransaction(pool, async (client: PoolClient) => {
    // tenant:exempt reason=cross-tenant-workflow-events-watermark follow_up=PERMANENT-EXEMPTION-run-id-retention
    const meta = await client.query<{ oldest: Date | null }>(
      "SELECT MIN(received_at) AS oldest FROM audit.workflow_events",
    );
    const oldest = meta.rows[0]?.oldest ?? null;
    console.info(
      `retention.events.summary deleted=${totalDeleted} batches=${batchesDone} ttl_days=${ttlDays} ` +
        `cutoff=${cutoff.toISOString()} oldest_remaining_received_at=${
          oldest === null ? "null" : oldest.toISOString()
        }`,
    );
  });

  return EventsRetentionResultV1.parse({
    scanned: totalDeleted,
    deleted: totalDeleted,
    batches: batchesDone,
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
//  Registered Temporal boundary
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Construction options for {@link RunIdRetentionActivities}. The integrator injects the production
 * GitHub client (the Vault-token-backed {@link GitHubApiClient}) the PR-closer needs; `dsn` / `clock`
 * default to the env pool + {@link WallClock}. 1:1 in spirit with the Python `configure(*, github_client,
 * clock, session_factory)` DI hook.
 */
export type RunIdRetentionActivitiesOptions = {
  /** The Vault-token-backed GitHub client the PR-closer uses. REQUIRED to run the PR-closer in prod. */
  githubClient?: GitHubApiClient;
  /** DSN override; default `CODEMASTER_PG_CORE_DSN`. */
  dsn?: string;
  /** Clock override; default {@link WallClock}. */
  clock?: Clock;
};

/**
 * The registered Temporal-activity boundary holder. The integrator instantiates this once (injecting the
 * Vault-backed GitHub client), then registers each bound method under its snake_case Temporal name in
 * `worker/build_activities.ts`:
 *
 *   const ret = new RunIdRetentionActivities({ githubClient: <vault-backed GitHubApiClient> });
 *   activities["run_id_close_stale_prs"]   = ret.runIdCloseStalePrs.bind(ret);
 *   activities["run_id_retire_old_runs"]   = ret.runIdRetireOldRuns.bind(ret);
 *   activities["run_id_delete_old_events"] = ret.runIdDeleteOldEvents.bind(ret);
 *
 * Each method takes the workflow-supplied `ttlDays: number` (1:1 with the Python `@activity.defn`
 * boundary `(ttl_days: int)`) and delegates to the testable free-function impl with the injected deps.
 * The PR-closer throws a clear error if no `githubClient` was injected (fail-closed) — the activity
 * cannot list/close PRs without it.
 */
export class RunIdRetentionActivities {
  private readonly githubClient: GitHubApiClient | undefined;
  private readonly dsn: string | undefined;
  private readonly clock: Clock | undefined;

  public constructor(opts: RunIdRetentionActivitiesOptions = {}) {
    this.githubClient = opts.githubClient;
    this.dsn = opts.dsn;
    this.clock = opts.clock;
  }

  /** Registered `run_id_close_stale_prs`. */
  public async runIdCloseStalePrs(ttlDays: number): Promise<StalePrCloserResultV1> {
    if (this.githubClient === undefined) {
      throw new Error(
        "RunIdRetentionActivities.runIdCloseStalePrs requires a githubClient; inject one via " +
          "`new RunIdRetentionActivities({ githubClient })` at worker registration (fail-closed).",
      );
    }
    return runIdCloseStalePrsActivity({
      githubClient: this.githubClient,
      ttlDays,
      ...(this.dsn !== undefined ? { dsn: this.dsn } : {}),
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
    });
  }

  /** Registered `run_id_retire_old_runs`. */
  public async runIdRetireOldRuns(ttlDays: number): Promise<RunsRetentionResultV1> {
    return runIdRetireOldRunsActivity({
      ttlDays,
      ...(this.dsn !== undefined ? { dsn: this.dsn } : {}),
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
    });
  }

  /** Registered `run_id_delete_old_events`. */
  public async runIdDeleteOldEvents(ttlDays: number): Promise<EventsRetentionResultV1> {
    return runIdDeleteOldEventsActivity({
      ttlDays,
      ...(this.dsn !== undefined ? { dsn: this.dsn } : {}),
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
    });
  }
}
