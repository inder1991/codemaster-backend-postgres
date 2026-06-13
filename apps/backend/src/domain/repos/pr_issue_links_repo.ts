/**
 * PostgresLinkedIssuesRepo — the READ slice consumed by `fetchLinkedIssues` (DM-WIRE T4 / S22.DM.16):
 * the `list_links_for_pr` query.
 *
 * Single operation:
 *   - {@link PostgresLinkedIssuesRepo.listLinksForPr} — SELECT every link row for one PR, returning the
 *     full `(github_issue_number, linkage_kind, source)` triple per row so the walkthrough assembler has
 *     what it needs without a second DB hop. Tenancy-isolated by `installation_id`; ordered by
 *     `(github_issue_number ASC, source ASC)` so the activity's downstream dedup is deterministic.
 *
 * The producer-side `replace_links` / `derive_pr_issue_link_id` (the webhook-path DELETE-then-INSERT)
 * are NOT consumed by this activity — they belong to the webhook persistence path. Only the read slice
 * the consumer needs is included here.
 *
 * ADR-0062: this repo is handed a `Kysely<PrIssueLinksDb>` over the process-wide single pool from
 * {@link tenantKysely}. {@link PostgresLinkedIssuesRepo.fromDsn} is the default entry point. Pool
 * teardown is the shared `disposeAllPools` / `disposePool` seam, NOT a per-repo close.
 *
 * Schema (confirmed live against the disposable PG, `\d core.pr_issue_links`):
 *   pr_issue_link_id    uuid    PK, default gen_random_uuid()
 *   installation_id     uuid    NOT NULL
 *   pr_id               uuid    NOT NULL
 *   github_issue_number bigint  NOT NULL, CHECK >= 1
 *   linkage_kind        text    NOT NULL, CHECK in ('closes','fixes','resolves','mentioned')
 *   source              text    NOT NULL, CHECK in ('description','title','branch_name','commit_message')
 *   created_at          timestamptz NOT NULL, default now()
 *   UNIQUE (pr_id, github_issue_number, linkage_kind, source)
 */

import { type Kysely, sql } from "kysely";

import { tenantKysely } from "#platform/db/database.js";
import { type Clock } from "#platform/clock.js";
import { uuid5 } from "#platform/randomness.js";

import type { IssueLink, LinkageKind, LinkageSource } from "#contracts/issue_link.v1.js";

/**
 * uuid5 namespace for `derivePrIssueLinkId`. MUST NOT change: it is stable across replays so the same
 * `(pr_id, github_issue_number, linkage_kind, source)` tuple always maps to the same `pr_issue_link_id`.
 * Paired with the UNIQUE constraint, this makes the DELETE-then-INSERT idempotent on webhook re-delivery
 * / replay.
 */
export const PR_ISSUE_LINK_UUID5_NAMESPACE = "8d8c9d14-0a3e-5e0f-9b7e-fc2c3a8d9704";

/**
 * Stable per-link UUID5. Used so a PR-edit-after-error does not drift the row id. The name string is
 * `"{prId}|{githubIssueNumber}|{linkageKind}|{source}"`.
 */
export function derivePrIssueLinkId(args: {
  prId: string;
  githubIssueNumber: number;
  linkageKind: LinkageKind;
  source: LinkageSource;
}): string {
  const name = `${args.prId}|${args.githubIssueNumber}|${args.linkageKind}|${args.source}`;
  return uuid5(PR_ISSUE_LINK_UUID5_NAMESPACE, name);
}

/**
 * Atomic DELETE-then-INSERT of `core.pr_issue_links` rows for one PR. Runs inside the CALLER's
 * transaction (`tx`); on outer rollback both writes vanish, so it shares fate with the gh_users +
 * pull_requests + pr_state_transitions chain (ADR-0026 §4).
 *
 * Semantics (faithful to Python):
 *   1. `DELETE … WHERE installation_id = :iid AND pr_id = :pid` (tenancy-filtered — REQUIRED so the tenancy
 *      gate accepts the raw SQL; pr_id is already PR-unique). Capture the deleted rowcount.
 *   2. If `links` is empty → return `{ deleted, inserted: 0 }` (DELETE-then-INSERT collapses to just-DELETE
 *      when the author removed every `Closes #N` in an edit).
 *   3. Otherwise bulk INSERT under `ON CONFLICT (pr_id, github_issue_number, linkage_kind, source)
 *      DO NOTHING` — the UNIQUE constraint absorbs any caller-side dedup miss + makes a concurrent webhook
 *      race safe. `created_at = clock.now()` (ONE read for the whole batch); `pr_issue_link_id` is the
 *      deterministic {@link derivePrIssueLinkId} per row.
 *
 * `inserted`: when the DB reports 0 affected rows (all conflicted), it falls back to `links.length`.
 */
export async function replaceLinks(
  tx: Kysely<unknown>,
  args: {
    prId: string;
    installationId: string;
    links: ReadonlyArray<IssueLink>;
    clock: Clock;
  },
): Promise<{ deleted: number; inserted: number }> {
  const { prId, installationId, links, clock } = args;

  const deleteResult = await sql`
    DELETE FROM core.pr_issue_links
     WHERE installation_id = ${installationId} AND pr_id = ${prId}
  `.execute(tx);
  const deleted = Number(deleteResult.numAffectedRows ?? 0n);

  if (links.length === 0) {
    return { deleted, inserted: 0 };
  }

  const now = clock.now();
  const valueTuples = links.map((link) => {
    const linkId = derivePrIssueLinkId({
      prId,
      githubIssueNumber: link.github_issue_number,
      linkageKind: link.linkage_kind,
      source: link.source,
    });
    return sql`(${linkId}, ${installationId}, ${prId}, ${link.github_issue_number}, ${link.linkage_kind}, ${link.source}, ${now})`;
  });

  const insertResult = await sql`
    INSERT INTO core.pr_issue_links
      (pr_issue_link_id, installation_id, pr_id, github_issue_number, linkage_kind, source, created_at)
    VALUES ${sql.join(valueTuples, sql`, `)}
    ON CONFLICT (pr_id, github_issue_number, linkage_kind, source) DO NOTHING
  `.execute(tx);
  // Fall back to links.length on a falsy count (matches `insert_result.rowcount or len(links)` semantics).
  const inserted = Number(insertResult.numAffectedRows ?? 0n) || links.length;

  return { deleted, inserted };
}

/** Minimal Kysely table typing for `core.pr_issue_links` (the only table this repo touches). */
type PrIssueLinksTable = {
  pr_issue_link_id: string;
  installation_id: string;
  pr_id: string;
  github_issue_number: number;
  linkage_kind: string;
  source: string;
  created_at: Date;
};

type PrIssueLinksDb = {
  "core.pr_issue_links": PrIssueLinksTable;
};

/**
 * The repo Port consumed by `fetchLinkedIssues`. The activity depends on this narrow surface, not the
 * concrete class.
 */
export type LinkedIssuesPort = {
  listLinksForPr(args: {
    installationId: string;
    prId: string;
  }): Promise<ReadonlyArray<IssueLink>>;
};

/** Implements {@link LinkedIssuesPort} against `core.pr_issue_links`. */
export class PostgresLinkedIssuesRepo implements LinkedIssuesPort {
  // The injected, shared-pool Kysely (ADR-0062). NOT owned by this repo — never `destroy()`-ed here.
  readonly #db: Kysely<PrIssueLinksDb>;

  /**
   * Construct from an injected `Kysely<PrIssueLinksDb>` — the tenant-scoped, shared-pool instance from
   * {@link tenantKysely}. The TenancyPlugin is already installed by {@link tenantKysely}; do NOT
   * re-install it here.
   */
  public constructor(args: { db: Kysely<PrIssueLinksDb> }) {
    this.#db = args.db;
  }

  /**
   * Default entry point (ADR-0062): build a repo over the process-wide single pool for `dsn` via
   * {@link tenantKysely}. Every repo over the same DSN shares ONE pool — no per-repo pool cache.
   */
  public static fromDsn(dsn: string): PostgresLinkedIssuesRepo {
    return new PostgresLinkedIssuesRepo({ db: tenantKysely<PrIssueLinksDb>(dsn) });
  }

  /**
   * SELECT every link row for one PR.
   *
   * Returns the full `(github_issue_number, linkage_kind, source)` triple per row so the walkthrough
   * assembler has what it needs without a second DB hop. Tenancy-isolated by `installation_id`. Sort by
   * `(github_issue_number ASC, source ASC)` so the activity's downstream dedup is deterministic.
   */
  public async listLinksForPr(args: {
    installationId: string;
    prId: string;
  }): Promise<ReadonlyArray<IssueLink>> {
    const { installationId, prId } = args;
    const result = await sql<{
      github_issue_number: string | number;
      linkage_kind: string;
      source: string;
    }>`
      SELECT github_issue_number, linkage_kind, source
      FROM core.pr_issue_links
      WHERE installation_id = ${installationId} AND pr_id = ${prId}
      ORDER BY github_issue_number ASC, source ASC
    `.execute(this.#db);

    return result.rows.map((row) => ({
      // bigint comes back as a string from node-postgres; coerce (issue numbers are < 2^53).
      github_issue_number: Number(row.github_issue_number),
      linkage_kind: row.linkage_kind as LinkageKind,
      source: row.source as LinkageSource,
    }));
  }
}
