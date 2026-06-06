// Admin read repo — net-new TS SELECTs for the admin READ endpoints (the Python orchestrating
// Postgres*Repo classes are not ported; these are the straight queries those endpoints actually run).
// Batch 1: listOrgs.

import { type Kysely, sql } from "kysely";

import type { FindingRowV1, TaxonomyGapEntryV1 } from "#contracts/admin.v1.js";

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

export type ListFindingsArgs = {
  installationId: string;
  repositoryId?: string | null;
  severity?: string | null;
  category?: string | null;
  filePathSubstring?: string | null;
  createdAfter?: string | null;
  createdBefore?: string | null;
  cursorCreatedAt?: string | null;
  cursorFindingId?: string | null;
  /** The DB LIMIT — the route passes pageSize + 1 to over-fetch for has-more detection. */
  limit: number;
};

type FindingDbRow = {
  review_finding_id: string;
  installation_id: string;
  pr_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  severity: string;
  category: string;
  title: string;
  body: string;
  suggestion: string | null;
  confidence: string | number;
  github_comment_id: string | number | null;
  posted_review_pr_id: string | null;
  created_at: Date;
};

function mapFindingRow(row: FindingDbRow): FindingRowV1 {
  return {
    review_finding_id: row.review_finding_id,
    installation_id: row.installation_id,
    pr_id: row.pr_id,
    file_path: row.file_path,
    start_line: row.start_line,
    end_line: row.end_line,
    severity: row.severity,
    category: row.category,
    title: row.title,
    body: row.body,
    suggestion: row.suggestion,
    confidence: Number(row.confidence),
    github_comment_id: row.github_comment_id === null ? null : Number(row.github_comment_id),
    posted_review_pr_id: row.posted_review_pr_id,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/**
 * Keyset-paginated findings, ordered created_at DESC, review_finding_id ASC. 1:1 with
 * postgres_findings_repo.list_findings: tenancy-filtered on installation_id, optional repository_id JOIN to
 * pull_requests, severity/category/file-substring/date filters, and the (created_at, review_finding_id)
 * keyset cursor. (The mixed DESC/ASC keyset is carried verbatim from the frozen Python.)
 */
export async function listFindings(
  db: Kysely<unknown>,
  args: ListFindingsArgs,
): Promise<Array<FindingRowV1>> {
  const conditions = [sql`rf.installation_id = ${args.installationId}`];
  if (args.severity != null) {
    conditions.push(sql`rf.severity = ${args.severity}`);
  }
  if (args.category != null) {
    conditions.push(sql`rf.category = ${args.category}`);
  }
  if (args.filePathSubstring != null) {
    conditions.push(sql`rf.file_path ILIKE ${"%" + args.filePathSubstring + "%"}`);
  }
  if (args.createdAfter != null) {
    conditions.push(sql`rf.created_at >= ${args.createdAfter}`);
  }
  if (args.createdBefore != null) {
    conditions.push(sql`rf.created_at < ${args.createdBefore}`);
  }
  if (args.cursorCreatedAt != null && args.cursorFindingId != null) {
    conditions.push(
      sql`(rf.created_at, rf.review_finding_id) < (${args.cursorCreatedAt}, ${args.cursorFindingId})`,
    );
  }
  const joinClause =
    args.repositoryId != null
      ? sql`JOIN core.pull_requests pr ON pr.pr_id = rf.pr_id AND pr.repository_id = ${args.repositoryId}`
      : sql``;
  const whereClause = sql.join(conditions, sql` AND `);

  const r = await sql<FindingDbRow>`
    SELECT rf.review_finding_id, rf.installation_id, rf.pr_id, rf.file_path, rf.start_line, rf.end_line,
           rf.severity, rf.category, rf.title, rf.body, rf.suggestion, rf.confidence,
           rf.github_comment_id, rf.posted_review_pr_id, rf.created_at
    FROM core.review_findings rf
    ${joinClause}
    WHERE ${whereClause}
    ORDER BY rf.created_at DESC, rf.review_finding_id ASC
    LIMIT ${args.limit}
  `.execute(db);
  return r.rows.map(mapFindingRow);
}
