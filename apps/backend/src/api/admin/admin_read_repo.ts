// Admin read repo — net-new TS SELECTs for the admin READ endpoints (the Python orchestrating
// Postgres*Repo classes are not ported; these are the straight queries those endpoints actually run).
// Batch 1: listOrgs.

import { type Kysely, sql } from "kysely";

import type { TaxonomyGapEntryV1 } from "#contracts/admin.v1.js";

import { SUPER_ADMIN_PLATFORM_VIEW_UUID } from "#backend/infra/sentinels.js";

/**
 * Distinct GitHub orgs (core.installations.account_login) visible to the session, ordered. 1:1 with
 * postgres_reviews_repo.list_orgs: super_admin / platform view (installation_id == the platform-view
 * sentinel) sees ALL orgs; a tenant-scoped session sees only its own installation's org.
 */
export async function listOrgs(db: Kysely<unknown>, installationId: string): Promise<Array<string>> {
  const r = await sql<{ org: string }>`
    SELECT DISTINCT inst.account_login AS org
    FROM core.installations inst
    JOIN core.repositories r ON r.installation_id = inst.installation_id
    WHERE (${installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
           OR inst.installation_id = ${installationId})
    ORDER BY org
  `.execute(db);
  return r.rows.map((row) => row.org);
}

type TaxonomyGapRow = {
  label: string;
  chunks_carrying: string | number;
  pages_carrying: string | number;
  spaces_carrying: string | number;
  most_recent_use: Date;
};

/**
 * Top-N unrecognized-label entries from core.v_taxonomy_gaps, ordered by chunks_carrying DESC. 1:1 with
 * postgres_taxonomy_repo.top_n. The view's COUNT(*) columns come back as bigint strings — coerced to int.
 */
export async function listTaxonomyGaps(
  db: Kysely<unknown>,
  limit: number,
): Promise<Array<TaxonomyGapEntryV1>> {
  const r = await sql<TaxonomyGapRow>`
    SELECT label, chunks_carrying, pages_carrying, spaces_carrying, most_recent_use
    FROM core.v_taxonomy_gaps
    WHERE label LIKE 'unrecognized:%'
    ORDER BY chunks_carrying DESC
    LIMIT ${limit}
  `.execute(db);
  return r.rows.map((row) => ({
    schema_version: 1 as const,
    label: row.label,
    chunks_carrying: Number(row.chunks_carrying),
    pages_carrying: Number(row.pages_carrying),
    spaces_carrying: Number(row.spaces_carrying),
    most_recent_use: new Date(row.most_recent_use).toISOString(),
  }));
}
