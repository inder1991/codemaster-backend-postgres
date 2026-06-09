// Status page reads — port of codemaster/api/admin/postgres_status_repo.py.
// Two public methods: getPipelineStatus, getPilotProgress. Computes health states from raw signal
// windows (bedrock error rates, postgres xact_rollback, temporal probe). These are cross-tenant
// PLATFORM-operator aggregates (counts across all installations) — no installation_id filter applies,
// so each tenant-scoped raw SELECT carries a `// tenant:exempt reason=operator-inspection` marker
// mirroring the Python @privileged_path decorator.
//
// Live-schema adaptations vs the Python-derived plan:
//   - core.review_runs has NO `state` column; lifecycle is `lifecycle_state` ∈
//     {PENDING,RUNNING,WAITING_RETRY,COMPLETED,FAILED,CANCELLED,PARTIAL}. In-flight =
//     {PENDING,RUNNING,WAITING_RETRY}; completed = COMPLETED.
//   - telemetry.llm_calls.status CHECK = {ok,refused_cost_cap,failed,timeout}; "errored" = `status != 'ok'`.

import { type Kysely, sql } from "kysely";

import type { HealthStateV1, PilotProgressV1, PipelineStatusV1 } from "#contracts/admin.v1.js";

// Locked thresholds (S16.D.3 review v2)
const BEDROCK_DOWN_WINDOW_MS = 60 * 1000; // 1 minute
const BEDROCK_DOWN_MIN_VOLUME = 10;
const BEDROCK_DOWN_ERROR_RATE = 0.9;
const BEDROCK_DEGRADED_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const BEDROCK_DEGRADED_MIN_VOLUME = 10;
const BEDROCK_DEGRADED_ERROR_RATE = 0.5;

const PG_DOWN_ROLLBACK_RATE = 0.5;
const PG_DEGRADED_ROLLBACK_RATE = 0.1;

const PILOT_DEFAULT_TARGET_ORGS = 10;

export type TemporalProbePort = {
  check(now: Date): Promise<HealthStateV1>;
};

export class StatusRepo {
  public constructor(
    private db: Kysely<unknown>,
    private targetOrgs: number = PILOT_DEFAULT_TARGET_ORGS,
    private temporalProbe?: TemporalProbePort,
  ) {}

  public async getPipelineStatus(now: Date): Promise<PipelineStatusV1> {
    const inFlight = await this.readInFlightReviewCount();
    const counts = await this.readLast24hCounts(now);
    const bedrockHealth = await this.computeBedrockHealth(now);
    const postgresHealth = await this.computePostgresHealth();
    const temporalHealth: HealthStateV1 = this.temporalProbe
      ? await this.temporalProbe.check(now)
      : "healthy";

    return {
      schema_version: 1,
      in_flight_review_count: inFlight,
      last_24h_review_count: counts.reviewCount,
      last_24h_findings_count: counts.findingsCount,
      last_24h_avg_latency_seconds: counts.avgLatencySeconds,
      bedrock_health: bedrockHealth,
      postgres_health: postgresHealth,
      temporal_health: temporalHealth,
      sampled_at: now,
    };
  }

  public async getPilotProgress(now: Date): Promise<PilotProgressV1> {
    const onboarded = await this.readOnboardedOrgCount();
    const thisWeek = await this.readReviewsThisWeek(now);
    const sprintDay = computeSprintDay(now);

    return {
      schema_version: 1,
      total_orgs_onboarded: onboarded,
      target_orgs: this.targetOrgs,
      total_prs_reviewed_this_week: thisWeek,
      sprint_day: sprintDay,
      sampled_at: now,
    };
  }

  private async readInFlightReviewCount(): Promise<number> {
    // tenant:exempt reason=operator-inspection-cross-tenant-aggregate follow_up=PERMANENT-EXEMPTION-status-platform-aggregate
    const res = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.review_runs
      WHERE lifecycle_state IN ('PENDING', 'RUNNING', 'WAITING_RETRY')
    `.execute(this.db);
    return Number(res.rows[0]?.count ?? 0);
  }

  private async readLast24hCounts(
    now: Date,
  ): Promise<{ reviewCount: number; findingsCount: number; avgLatencySeconds: number }> {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    // tenant:exempt reason=operator-inspection-cross-tenant-aggregate follow_up=PERMANENT-EXEMPTION-status-platform-aggregate
    const reviewRes = await sql<{
      review_count: string | number;
      avg_latency: string | number;
    }>`
      SELECT COUNT(*) AS review_count,
             COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at))), 0) AS avg_latency
      FROM core.review_runs
      WHERE completed_at >= ${since} AND lifecycle_state = 'COMPLETED'
    `.execute(this.db);
    const reviewData = reviewRes.rows[0];

    // tenant:exempt reason=operator-inspection-cross-tenant-aggregate follow_up=PERMANENT-EXEMPTION-status-platform-aggregate
    const findingsRes = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.review_findings WHERE created_at >= ${since}
    `.execute(this.db);

    return {
      reviewCount: Number(reviewData?.review_count ?? 0),
      findingsCount: Number(findingsRes.rows[0]?.count ?? 0),
      avgLatencySeconds: Number(reviewData?.avg_latency ?? 0),
    };
  }

  private async computeBedrockHealth(now: Date): Promise<HealthStateV1> {
    // Last-1m: flips to "down"
    const downMetrics = await this.bedrockWindowMetrics(
      new Date(now.getTime() - BEDROCK_DOWN_WINDOW_MS),
    );
    if (
      downMetrics.total >= BEDROCK_DOWN_MIN_VOLUME &&
      downMetrics.errorRate > BEDROCK_DOWN_ERROR_RATE
    ) {
      return "down";
    }

    // Last-5m: flips to "degraded"
    const degradedMetrics = await this.bedrockWindowMetrics(
      new Date(now.getTime() - BEDROCK_DEGRADED_WINDOW_MS),
    );
    if (
      degradedMetrics.total >= BEDROCK_DEGRADED_MIN_VOLUME &&
      degradedMetrics.errorRate > BEDROCK_DEGRADED_ERROR_RATE
    ) {
      return "degraded";
    }

    return "healthy";
  }

  private async bedrockWindowMetrics(
    since: Date,
  ): Promise<{ total: number; errored: number; errorRate: number }> {
    // tenant:exempt reason=operator-inspection-cross-tenant-aggregate follow_up=PERMANENT-EXEMPTION-status-platform-aggregate
    const res = await sql<{ total: string | number; errored: string | number }>`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status != 'ok') AS errored
      FROM telemetry.llm_calls
      WHERE created_at >= ${since}
    `.execute(this.db);
    const data = res.rows[0];
    const total = Number(data?.total ?? 0);
    const errored = Number(data?.errored ?? 0);
    return {
      total,
      errored,
      errorRate: total > 0 ? errored / total : 0,
    };
  }

  private async computePostgresHealth(): Promise<HealthStateV1> {
    const res = await sql<{
      rollback_total: string | number | null;
      xact_total: string | number | null;
    }>`
      SELECT SUM(xact_rollback) AS rollback_total,
             SUM(xact_commit) + SUM(xact_rollback) AS xact_total
      FROM pg_stat_database
      WHERE datname = current_database()
    `.execute(this.db);
    const data = res.rows[0];
    const rollback = Number(data?.rollback_total ?? 0);
    const total = Number(data?.xact_total ?? 0);

    if (total === 0) {
      return "healthy";
    }

    const rate = rollback / total;
    if (rate > PG_DOWN_ROLLBACK_RATE) {
      return "down";
    }
    if (rate > PG_DEGRADED_ROLLBACK_RATE) {
      return "degraded";
    }
    return "healthy";
  }

  private async readOnboardedOrgCount(): Promise<number> {
    // tenant:exempt reason=operator-inspection-cross-tenant-aggregate follow_up=PERMANENT-EXEMPTION-status-platform-aggregate
    const res = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.installations WHERE onboarded_at IS NOT NULL
    `.execute(this.db);
    return Number(res.rows[0]?.count ?? 0);
  }

  private async readReviewsThisWeek(now: Date): Promise<number> {
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    // tenant:exempt reason=operator-inspection-cross-tenant-aggregate follow_up=PERMANENT-EXEMPTION-status-platform-aggregate
    const res = await sql<{ count: string | number }>`
      SELECT COUNT(*) AS count FROM core.review_runs
      WHERE completed_at >= ${since} AND lifecycle_state = 'COMPLETED'
    `.execute(this.db);
    return Number(res.rows[0]?.count ?? 0);
  }
}

/**
 * Days since the most-recent Monday (UTC), clamped to [1, 14]. Pure heuristic; unit-tested directly.
 * `sprintStart`, when provided, overrides the Monday-of-this-week default (used to clamp far-past starts).
 */
export function computeSprintDay(now: Date, sprintStart?: Date): number {
  let start = sprintStart;
  if (!start) {
    const asUtc = new Date(now.toISOString());
    const dayOfWeek = asUtc.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    start = new Date(
      Date.UTC(
        asUtc.getUTCFullYear(),
        asUtc.getUTCMonth(),
        asUtc.getUTCDate() - daysSinceMonday,
        0,
        0,
        0,
        0,
      ),
    );
  }
  const elapsed = Math.floor((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  return Math.max(1, Math.min(14, elapsed));
}
