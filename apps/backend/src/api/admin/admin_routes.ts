// Fastify admin router — port of the codemaster/api/admin/* READ endpoints (operator visibility).
// Each route sits behind the makeRequireRole gate (Stage 5) with the SAME per-route allow-set as the
// frozen Python require_role(...). Registered on an encapsulated scope (@fastify/cookie scoped here) like
// the auth router.
//
// Batch 1 (the tsReady=ready READ endpoints from the admin-read-endpoint survey):
//   GET /api/admin/orgs       — distinct orgs visible to the session (the Reviews org filter)
//   GET /api/admin/dashboard  — operator landing summary (static zero-DB shim, 1:1 with the shipped Python)

import cookie from "@fastify/cookie";
import { type Kysely } from "kysely";
import type { FastifyInstance } from "fastify";

import type { Clock } from "#platform/clock.js";

import { DashboardSummaryV1, OrgsListV1, TaxonomyGapListV1 } from "#contracts/admin.v1.js";

import { listOrgs, listTaxonomyGaps } from "#backend/api/admin/admin_read_repo.js";
import { makeRequireRole } from "#backend/api/admin/_authz.js";

const TAXONOMY_DEFAULT_LIMIT = 50;
const TAXONOMY_MAX_LIMIT = 200;

/** Parse + clamp the ?limit query param to [1, MAX] (mirrors taxonomy_gaps.list_gaps's clamp). */
function clampTaxonomyLimit(query: unknown): number {
  const raw = Number((query as { limit?: unknown }).limit ?? TAXONOMY_DEFAULT_LIMIT);
  if (!Number.isFinite(raw)) {
    return TAXONOMY_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(TAXONOMY_MAX_LIMIT, Math.floor(raw)));
}

export type AdminRoutesOptions = {
  db: Kysely<unknown>;
  signingKey: Buffer | Uint8Array;
  clock: Clock;
};

/** The static dashboard summary (1:1 with the shipped Python: _HealthyProbe for the 4 services +
 *  _ZeroMetrics). The real aggregating reader is unbuilt in the Python too. */
export function buildDashboardSummary(now: Date): DashboardSummaryV1 {
  const services = (["api", "workers", "postgres", "bedrock"] as const).map((name) => ({
    name,
    state: "healthy" as const,
    detail: "",
  }));
  return {
    schema_version: 1,
    services,
    reviews_this_hour: 0,
    latency_p95_ms: 0,
    in_flight_reviews: 0,
    last_updated_at: now.toISOString(),
  };
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  opts: AdminRoutesOptions,
): Promise<void> {
  const requireRole = makeRequireRole({ signingKey: opts.signingKey, clock: opts.clock });

  await app.register(async (scope) => {
    await scope.register(cookie);

    scope.get(
      "/api/admin/orgs",
      { preHandler: requireRole(["platform_operator", "platform_owner", "super_admin"]) },
      async (request, reply) => {
        const orgs = await listOrgs(opts.db, request.authPrincipal!.installationId);
        return reply.code(200).send(OrgsListV1.parse({ orgs }));
      },
    );

    scope.get(
      "/api/admin/taxonomy/gaps",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const rows = await listTaxonomyGaps(opts.db, clampTaxonomyLimit(request.query));
        return reply.code(200).send(TaxonomyGapListV1.parse({ rows }));
      },
    );

    scope.get(
      "/api/admin/dashboard",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (_request, reply) =>
        reply.code(200).send(DashboardSummaryV1.parse(buildDashboardSummary(opts.clock.now()))),
    );
  });
}
