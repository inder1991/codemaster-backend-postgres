/**
 * `persistReviewFindings` activity — takes the single typed input envelope, constructs the Postgres repo,
 * persists the aggregated findings, returns the ordered finding ids.
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. `node:crypto` is fully
 * available here (the repo's `deriveReviewFindingId` uses it transitively for its uuid5), and so is real
 * I/O (the `pg.Pool` the repo opens through the ADR-0062 shared seam). The ADR-0065 crypto boundary
 * constrains the WORKFLOW body + the payload converter, never the activity layer — minting / hashing /
 * DB writes all live here.
 *
 * ## Inputs (read off the actual contract shape — `persist_review_findings.v1.ts`)
 *
 * The single positional input is a {@link PersistReviewFindingsInputV1} (CLAUDE.md invariant 11). We pull:
 *   - `pr_id` / `installation_id` / `run_id` / `review_id` — the four UUID strings the repo's stale-write
 *     guard + tenancy + idempotency keys need.
 *   - `aggregated` — the {@link AggregatedFindingsV1} envelope (findings tuple + dedupe stats).
 *   - `precomputed_metadata` — the optional per-finding `FindingPolicyMetadataV1[] | null`, threaded into
 *     `persistAggregated`'s `policyMetadata` (index-aligned; the repo handles null / out-of-range → `{}`).
 *
 * ## Clock seam (determinism handle for the 2.5 dual-run)
 *
 * The repo records `created_at` from an injected {@link Clock}. By default we hand it a {@link WallClock}.
 * If `CODEMASTER_FAKE_CLOCK_ISO` is set to a parseable ISO-8601 instant, we instead hand it a
 * {@link FakeClock} pinned at that instant — so a later mini-dual-run can make the persisted `created_at`
 * column byte-deterministic across runners. Reading an env var and constructing a
 * `new Date(iso)` (a KNOWN instant, not a wall-clock read) is outside the clock/random gate's scope.
 *
 * ## DSN
 *
 * The Postgres DSN is read from `CODEMASTER_PG_CORE_DSN` (the canonical core-store env var). The repo's
 * `tenantKyselyForDsn` routes it through the ADR-0062 process-shared single pool per DSN — the activity
 * does NOT open its own pool. NOTE: this activity is CONSTRUCTED but not invoked during the skeleton BUILD
 * (no live Postgres); `persistAggregated` is integration-tested elsewhere.
 */

import { PostgresReviewFindingsRepo, tenantKyselyForDsn } from "#backend/domain/repos/review_findings_repo.js";

import { FakeClock, WallClock, type Clock } from "#platform/clock.js";

import type { PersistReviewFindingsInputV1 } from "#contracts/persist_review_findings.v1.js";

/**
 * Resolve the {@link Clock} seam: a {@link FakeClock} pinned at `CODEMASTER_FAKE_CLOCK_ISO` when that env
 * var is a parseable ISO instant (deterministic `created_at` for the 2.5 dual-run), else a
 * {@link WallClock}. An unparseable value throws loudly rather than silently falling back — a typo in the
 * pin must not degrade to wall-clock non-determinism under the operator's nose.
 */
function resolveClock(): Clock {
  const iso = process.env.CODEMASTER_FAKE_CLOCK_ISO;
  if (iso === undefined || iso === "") {
    return new WallClock();
  }
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(
      `CODEMASTER_FAKE_CLOCK_ISO=${JSON.stringify(iso)} is not a parseable ISO-8601 instant`,
    );
  }
  return new FakeClock({ now: instant });
}

/**
 * Persist the aggregated findings, return their ordered ids.
 *
 * Constructs {@link PostgresReviewFindingsRepo} over the ADR-0062 shared pool for the
 * `CODEMASTER_PG_CORE_DSN` DSN + the resolved {@link Clock}, then delegates to `persistAggregated`. The
 * returned `ReadonlyArray<string>` is spread into a fresh `Array<string>` so the wire return type matches
 * the workflow / proxy signature exactly (`Promise<Array<string>>`).
 */
export async function persistReviewFindings(
  input: PersistReviewFindingsInputV1,
): Promise<Array<string>> {
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error("CODEMASTER_PG_CORE_DSN is not set; cannot construct the review-findings repo");
  }

  const db = tenantKyselyForDsn(dsn);
  const repo = new PostgresReviewFindingsRepo({ db, clock: resolveClock() });

  const findingIds = await repo.persistAggregated({
    prId: input.pr_id,
    installationId: input.installation_id,
    aggregated: input.aggregated,
    runId: input.run_id,
    reviewId: input.review_id,
    policyMetadata: input.precomputed_metadata,
  });

  return [...findingIds];
}
