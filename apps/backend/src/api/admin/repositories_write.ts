// Repositories enable/disable write — 1:1 port of postgres_repositories_repo.py set_enabled +
// get_by_github_id. Single PUT surface: flip core.repositories.enabled with a race-free CAS UPDATE
// (`WHERE enabled <> :new`) that atomically decides change-vs-noop. Pure DB + audit (no Temporal).

import { type Kysely, sql } from "kysely";

import type { RepositoryV1 } from "#contracts/admin.v1.js";

type RepoSqlRow = {
  repository_id: string;
  installation_id: string;
  github_repo_id: string | number;
  full_name: string;
  default_branch: string;
  enabled: boolean;
  archived: boolean;
  updated_at: Date;
};

const REPO_COLS = sql`repository_id, installation_id, github_repo_id, full_name, default_branch, enabled, archived, updated_at`;

function mapRepo(r: RepoSqlRow): RepositoryV1 {
  return {
    schema_version: 1,
    repository_id: r.repository_id,
    installation_id: r.installation_id,
    github_repo_id: Number(r.github_repo_id), // bigint → number
    full_name: r.full_name,
    default_branch: r.default_branch,
    enabled: r.enabled,
    archived: r.archived,
    updated_at: r.updated_at.toISOString(),
  };
}

async function getByGithubId(db: Kysely<unknown>, githubRepoId: number): Promise<RepositoryV1 | null> {
  // tenant:exempt reason=PK-lookup-on-globally-unique-github-repo-id follow_up=PERMANENT-EXEMPTION-global-github-keys
  const r = await sql<RepoSqlRow>`
    SELECT ${REPO_COLS} FROM core.repositories WHERE github_repo_id = ${githubRepoId}
  `.execute(db);
  const row = r.rows[0];
  return row === undefined ? null : mapRepo(row);
}

/** CAS flip of `enabled`. Returns `{ repo, changed }`: `repo` is null when the github_repo_id doesn't exist
 *  (→ route 404); `changed` is false when the value already matched (idempotent no-op, no audit). */
export async function setEnabled(
  db: Kysely<unknown>,
  args: { githubRepoId: number; enabled: boolean; now: Date },
): Promise<{ repo: RepositoryV1 | null; changed: boolean }> {
  return db.transaction().execute(async (tx) => {
    // tenant:exempt reason=CAS-update-on-globally-unique-github-repo-id follow_up=PERMANENT-EXEMPTION-global-github-keys
    const cas = await sql<RepoSqlRow>`
      UPDATE core.repositories
      SET enabled = ${args.enabled}, updated_at = ${args.now}
      WHERE github_repo_id = ${args.githubRepoId} AND enabled <> ${args.enabled}
      RETURNING ${REPO_COLS}
    `.execute(tx);
    const casRow = cas.rows[0];
    if (casRow !== undefined) {
      return { repo: mapRepo(casRow), changed: true };
    }
    // No CAS row — either the id doesn't exist OR the value already matched. Distinguish via a read.
    const existing = await getByGithubId(tx, args.githubRepoId);
    return { repo: existing, changed: false };
  });
}
