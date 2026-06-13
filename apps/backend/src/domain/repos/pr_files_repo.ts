/**
 * PrFilesRepo — async repo over `core.pr_files` (Sprint 21 / S21.DM.9). Two public operations:
 *
 *   - {@link PostgresPrFilesRepo.upsertFiles} — writes one row per {@link PrFileV1} in the input
 *     tuple. Idempotent via the `(pr_id, file_path)` UNIQUE index (`uq_pr_files_pr_path`) — workflow
 *     retries replay the same upsert without duplicating rows. Returns the count of rows written
 *     (insert or update; `ON CONFLICT (pr_id, file_path) DO UPDATE` applies the new GitHub-API
 *     values, so retries that observe a renamed file pick up the change).
 *   - {@link PostgresPrFilesRepo.listFilePathsForPr} — (S23.AR.3 / S23.AR.6) returns the file paths
 *     for one PR, ordered by `file_path ASC`. Tenancy-isolated by `installation_id`.
 *
 * Tenancy: every tenant-scoped query carries `installation_id`. The shared-pool Kysely this repo is
 * handed has the {@link TenancyPlugin} (`#platform/db/tenancy_plugin.js`) installed centrally by
 * {@link tenantKysely}, so a SELECT/UPDATE/DELETE on `core.pr_files` without an `installation_id`
 * equality predicate is refused at query-build time (invariant #10, "default deny everywhere"). The
 * `upsertFiles` INSERT is out of the plugin's scope (it has no WHERE), so it carries `installation_id`
 * as an explicit per-row column value instead.
 *
 * ADR-0062 (Postgres connection-pool lifecycle): this repo NO LONGER owns a `pg.Pool` or constructs a
 * `new Kysely(...)`. It is handed a `Kysely<PrFilesDb>` over the process-wide single pool from
 * {@link tenantKysely} (`#platform/db/database.js`) — the structural fix that replaces the old
 * per-DSN pool+Kysely cache so a worker no longer fans out to `N × max` connections.
 * {@link PostgresPrFilesRepo.fromDsn} is the default entry point; it routes through
 * {@link tenantKysely} so every repo over the same DSN shares ONE pool. Pool teardown is the shared
 * `disposeAllPools` / `disposePool` seam, NOT a per-repo `close()` — a Kysely from {@link tenantKysely}
 * must NOT be `destroy()`-ed by a repo, because doing so would end the shared pool out from under every
 * other repo bound to the same DSN.
 *
 * Implementation notes:
 *   - `pr_file_id` is a stable UUIDv5 of `(pr_id, file_path)` under a fixed namespace — workflow
 *     replays produce the same id so the ON CONFLICT clause is idempotent. Re-authored from
 *     `node:crypto` (no `uuid` npm dep).
 *   - `created_at` is taken from the injected {@link Clock} seam — the `check_clock_random` gate
 *     forbids a raw `new Date()` here.
 */

import { createHash } from "node:crypto";

import { type Kysely } from "kysely";

import { tenantKysely } from "#platform/db/database.js";

import type { Clock } from "#platform/clock.js";

import { type PrFileV1 } from "#contracts/pr_file.v1.js";

// ─── Kysely schema (scoped to this repo) ─────────────────────────────────────

/** Column shape of `core.pr_files` (see migration; matches the live `\d core.pr_files`). */
type PrFilesTable = {
  pr_file_id: string;
  installation_id: string;
  pr_id: string;
  repository_id: string;
  file_path: string;
  status: string;
  additions: number;
  deletions: number;
  previous_path: string | null;
  language: string | null;
  created_at: Date;
};

/**
 * The Kysely database type this repo operates against. Keyed by the schema-qualified table name
 * (`"core.pr_files"`) so `selectFrom("core.pr_files")` emits a TableNode with `schema=core`,
 * which is exactly the form the {@link TenancyPlugin} walks to match the tenant-scoped registry.
 */
type PrFilesDb = {
  "core.pr_files": PrFilesTable;
};

// ─── Stable per-file UUIDv5 ───────────────────────────────────────────────────

/**
 * uuid5 namespace — stable across replays so the same `(pr_id, file_path)` tuple always maps to the
 * same `pr_file_id`. Workflow retries get idempotency for free; pairs with the `(pr_id, file_path)`
 * UNIQUE constraint.
 */
const PR_FILE_UUID5_NAMESPACE = "8b8c9d12-0a3e-5e0f-9b7e-fc2c3a8d9702";

/**
 * RFC-4122 v5 UUID (SHA-1 of namespace bytes ++ name bytes) in canonical dashed form. Re-authored
 * from `node:crypto` (no `uuid` npm dep).
 */
function uuid5(namespaceHex: string, name: string): string {
  const nsBytes = Buffer.from(namespaceHex.replace(/-/g, ""), "hex"); // 16 bytes
  const digest = createHash("sha1")
    .update(nsBytes)
    .update(Buffer.from(name, "utf-8"))
    .digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8); // RFC-4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Stable per-file UUID5. Workflow replays produce the same `pr_file_id` so the ON CONFLICT clause
 * makes upsert idempotent. Name: `"{prId}|{filePath}"`.
 */
export function derivePrFileId(args: { prId: string; filePath: string }): string {
  return uuid5(PR_FILE_UUID5_NAMESPACE, `${args.prId}|${args.filePath}`);
}

// ─── Repo Port + Postgres impl ───────────────────────────────────────────────

/** Repo Protocol consumed by `enrich_pr_files_activity`. */
export type PrFilesRepoPort = {
  upsertFiles(args: {
    prId: string;
    installationId: string;
    repositoryId: string;
    files: ReadonlyArray<PrFileV1>;
  }): Promise<number>;

  listFilePathsForPr(args: {
    installationId: string;
    prId: string;
  }): Promise<ReadonlyArray<string>>;
};

/** Implements {@link PrFilesRepoPort} against `core.pr_files`. */
export class PostgresPrFilesRepo implements PrFilesRepoPort {
  // The injected, shared-pool Kysely (ADR-0062). NOT owned by this repo — never `destroy()`-ed here.
  readonly #db: Kysely<PrFilesDb>;
  readonly #clock: Clock;

  /**
   * Construct from an injected `Kysely<PrFilesDb>` — the tenant-scoped, shared-pool instance from
   * {@link tenantKysely} — plus the injected clock. The {@link TenancyPlugin} is already installed by
   * {@link tenantKysely}; do NOT re-install it here.
   */
  public constructor(args: { db: Kysely<PrFilesDb>; clock: Clock }) {
    this.#db = args.db;
    this.#clock = args.clock;
  }

  /**
   * Default entry point (ADR-0062): build a repo over the process-wide single pool for `dsn` via
   * {@link tenantKysely}. Every repo over the same DSN shares ONE pool — no per-repo pool cache.
   */
  public static fromDsn(args: { dsn: string; clock: Clock }): PostgresPrFilesRepo {
    return new PostgresPrFilesRepo({ db: tenantKysely<PrFilesDb>(args.dsn), clock: args.clock });
  }

  /**
   * Upsert per-file rows for one PR. Returns the count of rows the bulk INSERT touched.
   *
   * The activity calls this after fetching the file list from GitHub. `ON CONFLICT (pr_id, file_path)
   * DO UPDATE` picks up renames + status changes on subsequent webhook deliveries (e.g. a file added
   * in commit 1, removed in commit 3 of the same PR — the latest webhook's row wins).
   *
   * Bulk-INSERT shape (one round-trip), matching the Python `upsert_files`. `installation_id`,
   * `pr_id`, `repository_id` are caller-supplied (the contract's per-row copies are NOT trusted —
   * the Python source ignores `f.installation_id` etc. and binds the method args, so we do the same).
   */
  public async upsertFiles(args: {
    prId: string;
    installationId: string;
    repositoryId: string;
    files: ReadonlyArray<PrFileV1>;
  }): Promise<number> {
    if (args.files.length === 0) {
      return 0;
    }

    const now = this.#clock.now();
    const values = args.files.map((f) => ({
      pr_file_id: derivePrFileId({ prId: args.prId, filePath: f.file_path }),
      installation_id: args.installationId,
      pr_id: args.prId,
      repository_id: args.repositoryId,
      file_path: f.file_path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      previous_path: f.previous_path,
      language: f.language,
      created_at: now,
    }));

    // ON CONFLICT (pr_id, file_path) DO UPDATE — picks up status/rename/language changes on retry.
    // created_at + identity columns are NOT updated.
    const result = await this.#db
      .insertInto("core.pr_files")
      .values(values)
      .onConflict((oc) =>
        oc.columns(["pr_id", "file_path"]).doUpdateSet((eb) => ({
          status: eb.ref("excluded.status"),
          additions: eb.ref("excluded.additions"),
          deletions: eb.ref("excluded.deletions"),
          previous_path: eb.ref("excluded.previous_path"),
          language: eb.ref("excluded.language"),
        })),
      )
      .executeTakeFirst();

    // `numInsertedOrUpdatedRows` is a bigint; fall back to the row count on a falsy value.
    const affected = result.numInsertedOrUpdatedRows;
    return affected === undefined ? values.length : Number(affected);
  }

  /**
   * S23.AR.3 / S23.AR.6 — return the file paths for one PR, ordered by `file_path ASC`.
   *
   * Used by `fetch_suggested_reviewers_activity` (the first real consumer of `core.pr_files`).
   * Tenancy-isolated by `installation_id` (the TenancyPlugin enforces the predicate's presence).
   * Ordered for deterministic output; the ranker doesn't depend on order so this is purely a
   * stability concern.
   */
  public async listFilePathsForPr(args: {
    installationId: string;
    prId: string;
  }): Promise<ReadonlyArray<string>> {
    const rows = await this.#db
      .selectFrom("core.pr_files")
      .select("file_path")
      .where("installation_id", "=", args.installationId)
      .where("pr_id", "=", args.prId)
      .orderBy("file_path", "asc")
      .execute();
    return rows.map((r) => r.file_path);
  }
}
