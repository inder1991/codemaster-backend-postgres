import { z } from "zod";

// Zod port of contracts/admin/v1.py — the admin-console read contracts. `.strict()` (Pydantic
// extra="forbid"). Batch 1: orgs filter + dashboard summary.

/** Per-service health row in the dashboard summary (Pydantic __contract_internal__; no schema_version). */
export const ServiceHealthV1 = z
  .object({
    name: z.enum(["api", "workers", "postgres", "bedrock"]),
    state: z.enum(["healthy", "degraded", "down"]),
    detail: z.string().max(200).default(""),
  })
  .strict();
export type ServiceHealthV1 = z.infer<typeof ServiceHealthV1>;

/** GET /api/admin/orgs — the distinct GitHub orgs (core.installations.account_login) visible to the session. */
export const OrgsListV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    orgs: z.array(z.string()),
  })
  .strict();
export type OrgsListV1 = z.infer<typeof OrgsListV1>;

/** GET /api/admin/dashboard — the operator landing summary. */
export const DashboardSummaryV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    services: z.array(ServiceHealthV1),
    reviews_this_hour: z.number().int().min(0),
    latency_p95_ms: z.number().int().min(0),
    in_flight_reviews: z.number().int().min(0),
    last_updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type DashboardSummaryV1 = z.infer<typeof DashboardSummaryV1>;
