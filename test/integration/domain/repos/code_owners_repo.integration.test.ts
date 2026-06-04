import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresCodeOwnersRepo } from "#backend/domain/repos/code_owners_repo.js";

import { disposeAllPools, tenantKysely } from "#platform/db/database.js";
import { TenancyViolation } from "#platform/db/tenancy_plugin.js";

import type { CodeOwnerRuleV1 } from "#contracts/code_owner_rule.v1.js";

import { describeDb, INTEGRATION_DSN } from "../../_db.js";

// DB-gated integration test against a DISPOSABLE Postgres (migrations applied). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast stays green
// without a DB. We NEVER touch any other DB. Each test owns a UNIQUE installation_id (+ unique
// github_installation_id / github_repo_id bigints) so per-org rows never collide, and cleans up.

// Minimal typing for the FK-parent seeding + read-back assertions (NOT part of the repo's surface).
type SeedDb = {
  "core.code_owners": {
    code_owner_id: string;
    installation_id: string;
    repository_id: string;
    path_pattern: string;
    owner_logins: Array<string>;
    source_file_sha: string;
    synced_at: Date;
  };
};

let db: Kysely<SeedDb>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  // ADR-0062: the repo + the seed/assert Kysely share the ONE process-wide pool from the central
  // factory (tenantKysely routes through getPool) — never a private per-file pool. tenantKysely
  // installs the TenancyPlugin centrally, so installation_id scoping is enforced on builder-shaped
  // queries; the raw seed/cleanup statements use sql`` over this same shared-pool Kysely.
  db = tenantKysely<SeedDb>(INTEGRATION_DSN);
});

afterAll(async () => {
  // ADR-0062 teardown: end the shared pool(s) via the central seam — NOT a private destroy.
  await disposeAllPools();
});

/** A unique positive int64-safe bigint for github_* UNIQUE columns. */
function uniqueGithubId(): bigint {
  // Map a random uint48 onto a positive bigint comfortably under 2^53 to stay collision-free.
  return BigInt(`0x${randomUUID().replace(/-/g, "").slice(0, 12)}`);
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** A 40-char lowercase-hex SHA derived from a tag char (matches the contract's pattern). */
function shaFor(tag: string): string {
  return tag.repeat(40).slice(0, 40);
}

/** Seed the FK parents (installation + repository) a code_owners row requires. Returns ids. */
async function seedParents(args: {
  installationId: string;
  repositoryId: string;
}): Promise<void> {
  // INSERT is not gated by the tenancy plugin (no WHERE to scope) — matches the Python hook scope.
  await sql`
    INSERT INTO core.installations
      (installation_id, github_installation_id, account_login, account_type)
    VALUES (${args.installationId}, ${uniqueGithubId().toString()}, ${"acct-" +
    args.installationId.slice(0, 8)}, 'Organization')
  `.execute(db);
  await sql`
    INSERT INTO core.repositories
      (repository_id, installation_id, github_repo_id, full_name, default_branch)
    VALUES (${args.repositoryId}, ${args.installationId}, ${uniqueGithubId().toString()}, ${"org/repo-" +
    args.repositoryId.slice(0, 8)}, 'main')
  `.execute(db);
}

/** Delete every row a test created, FK-safe order (children before parents). */
async function cleanup(args: {
  installationIds: ReadonlyArray<string>;
  repositoryIds: ReadonlyArray<string>;
}): Promise<void> {
  for (const rid of args.repositoryIds) {
    await sql`DELETE FROM core.code_owners WHERE repository_id = ${rid}`.execute(db);
    await sql`DELETE FROM core.repositories WHERE repository_id = ${rid}`.execute(db);
  }
  for (const iid of args.installationIds) {
    await sql`DELETE FROM core.installations WHERE installation_id = ${iid}`.execute(db);
  }
}

/** Build a CodeOwnerRuleV1 wire row for a given installation/repository. */
function rule(args: {
  installationId: string;
  repositoryId: string;
  pathPattern: string;
  ownerLogins: ReadonlyArray<string>;
  sourceFileSha: string;
}): CodeOwnerRuleV1 {
  return {
    schema_version: 1,
    code_owner_id: randomUUID(),
    installation_id: args.installationId,
    repository_id: args.repositoryId,
    path_pattern: args.pathPattern,
    owner_logins: [...args.ownerLogins],
    source_file_sha: args.sourceFileSha,
    synced_at: null,
  };
}

function repo(): PostgresCodeOwnersRepo {
  // Exercise the repo's default ADR-0062 entry point: fromDsn routes through tenantKysely over the
  // ONE process-wide pool (TenancyPlugin installed centrally) — never one pool/Kysely per call.
  return PostgresCodeOwnersRepo.fromDsn(INTEGRATION_DSN ?? "");
}

describeDb("PostgresCodeOwnersRepo (integration, disposable PG)", () => {
  // ── upsertRules: round-trip insert + read-back equals ──
  it("upsertRules inserts every rule; listRulesForRepository reads them back (text[] byte-faithful)", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    try {
      const r = repo();
      const rules = [
        rule({
          installationId,
          repositoryId,
          pathPattern: "/src/**",
          ownerLogins: ["@indersingh", "@org/platform-team"],
          sourceFileSha: SHA_A,
        }),
        rule({
          installationId,
          repositoryId,
          pathPattern: "/docs/*",
          ownerLogins: ["@org/docs-team"],
          sourceFileSha: SHA_A,
        }),
      ];

      const written = await r.upsertRules({ installationId, repositoryId, rules });
      expect(written).toBe(2);

      const read = await r.listRulesForRepository({ installationId, repositoryId });
      // ORDER BY path_pattern ASC → /docs/* before /src/**.
      expect(read.map((x) => x.path_pattern)).toEqual(["/docs/*", "/src/**"]);
      // owner_logins text[] round-trips byte-faithfully (order + values preserved).
      const bySrc = read.find((x) => x.path_pattern === "/src/**");
      expect(bySrc?.owner_logins).toEqual(["@indersingh", "@org/platform-team"]);
      // line_number is always 0 (DB persists by-rule, not by-line) — 1:1 with the Python source.
      for (const x of read) expect(x.line_number).toBe(0);
    } finally {
      await cleanup({ installationIds: [installationId], repositoryIds: [repositoryId] });
    }
  });

  // ── ON CONFLICT idempotency: replay with the same SHA writes 0 ──
  it("upsertRules is idempotent under replay — same SHA returns 0 on the second call", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    try {
      const r = repo();
      const rules = [
        rule({
          installationId,
          repositoryId,
          pathPattern: "/a",
          ownerLogins: ["@u1"],
          sourceFileSha: SHA_A,
        }),
        rule({
          installationId,
          repositoryId,
          pathPattern: "/b",
          ownerLogins: ["@u2"],
          sourceFileSha: SHA_A,
        }),
      ];

      const first = await r.upsertRules({ installationId, repositoryId, rules });
      expect(first).toBe(2);
      // Replay the SAME (repository_id, path_pattern, source_file_sha) tuples → all no-op.
      const second = await r.upsertRules({ installationId, repositoryId, rules });
      expect(second).toBe(0);

      // Still exactly 2 rows persisted (no duplicates).
      const count = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM core.code_owners
        WHERE installation_id = ${installationId} AND repository_id = ${repositoryId}
      `.execute(db);
      expect(Number(count.rows[0]?.n)).toBe(2);
    } finally {
      await cleanup({ installationIds: [installationId], repositoryIds: [repositoryId] });
    }
  });

  // ── Empty rules: no-op without touching the DB ──
  it("upsertRules returns 0 for an empty rules tuple without writing", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    try {
      const r = repo();
      const written = await r.upsertRules({ installationId, repositoryId, rules: [] });
      expect(written).toBe(0);
      const read = await r.listRulesForRepository({ installationId, repositoryId });
      expect(read).toEqual([]);
    } finally {
      await cleanup({ installationIds: [installationId], repositoryIds: [repositoryId] });
    }
  });

  // ── latest-SHA dedup: list returns ONLY the most-recently-synced batch ──
  it("listRulesForRepository returns only the most-recently-synced source_file_sha", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    try {
      const r = repo();
      // First batch under SHA_A (older).
      await r.upsertRules({
        installationId,
        repositoryId,
        rules: [
          rule({
            installationId,
            repositoryId,
            pathPattern: "/old-only",
            ownerLogins: ["@old"],
            sourceFileSha: SHA_A,
          }),
        ],
      });
      // Force a strictly-later synced_at so the CTE's ORDER BY synced_at DESC is deterministic.
      await sql`
        UPDATE core.code_owners SET synced_at = now() - interval '1 hour'
        WHERE installation_id = ${installationId} AND repository_id = ${repositoryId}
          AND source_file_sha = ${SHA_A}
      `.execute(db);
      // Second batch under SHA_B (newer).
      await r.upsertRules({
        installationId,
        repositoryId,
        rules: [
          rule({
            installationId,
            repositoryId,
            pathPattern: "/new-only",
            ownerLogins: ["@new"],
            sourceFileSha: SHA_B,
          }),
        ],
      });

      const read = await r.listRulesForRepository({ installationId, repositoryId });
      // Only the SHA_B (latest) rule is returned; the SHA_A rule is filtered out by the CTE.
      expect(read.map((x) => x.path_pattern)).toEqual(["/new-only"]);
      expect(read[0]?.owner_logins).toEqual(["@new"]);
    } finally {
      await cleanup({ installationIds: [installationId], repositoryIds: [repositoryId] });
    }
  });

  // ── ordering: path_pattern ASC ──
  it("listRulesForRepository orders rules by path_pattern ASC", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    try {
      const r = repo();
      const sha = shaFor("c");
      const patterns = ["/zeta", "/alpha", "/mid/path", "/beta"];
      await r.upsertRules({
        installationId,
        repositoryId,
        rules: patterns.map((p) =>
          rule({ installationId, repositoryId, pathPattern: p, ownerLogins: ["@o"], sourceFileSha: sha }),
        ),
      });
      const read = await r.listRulesForRepository({ installationId, repositoryId });
      expect(read.map((x) => x.path_pattern)).toEqual([...patterns].sort());
    } finally {
      await cleanup({ installationIds: [installationId], repositoryIds: [repositoryId] });
    }
  });

  // ── tenant isolation: a query for installation A does not see B's rows ──
  it("listRulesForRepository is tenant-isolated — installation A does not see B's rows", async () => {
    const installA = randomUUID();
    const installB = randomUUID();
    const repoA = randomUUID();
    const repoB = randomUUID();
    await seedParents({ installationId: installA, repositoryId: repoA });
    await seedParents({ installationId: installB, repositoryId: repoB });
    try {
      const r = repo();
      const sha = shaFor("d");
      await r.upsertRules({
        installationId: installA,
        repositoryId: repoA,
        rules: [
          rule({
            installationId: installA,
            repositoryId: repoA,
            pathPattern: "/a-owned",
            ownerLogins: ["@a"],
            sourceFileSha: sha,
          }),
        ],
      });
      await r.upsertRules({
        installationId: installB,
        repositoryId: repoB,
        rules: [
          rule({
            installationId: installB,
            repositoryId: repoB,
            pathPattern: "/b-owned",
            ownerLogins: ["@b"],
            sourceFileSha: sha,
          }),
        ],
      });

      const readA = await r.listRulesForRepository({
        installationId: installA,
        repositoryId: repoA,
      });
      expect(readA.map((x) => x.path_pattern)).toEqual(["/a-owned"]);

      // Cross-tenant read: A's installation_id with B's repository → zero rows (no leak).
      const crossed = await r.listRulesForRepository({
        installationId: installA,
        repositoryId: repoB,
      });
      expect(crossed).toEqual([]);
    } finally {
      await cleanup({
        installationIds: [installA, installB],
        repositoryIds: [repoA, repoB],
      });
    }
  });

  // ── TenancyPlugin proof: a builder SELECT on core.code_owners WITHOUT an installation_id
  //    equality filter is refused at query-build time (defense-in-depth the repo installs). ──
  it("the installed TenancyPlugin refuses an unscoped builder SELECT on core.code_owners", async () => {
    await expect(
      db.selectFrom("core.code_owners").select("path_pattern").execute(),
    ).rejects.toBeInstanceOf(TenancyViolation);

    // A scoped builder SELECT (installation_id equality) passes the plugin (0 rows for a random id).
    const ok = await db
      .selectFrom("core.code_owners")
      .select("path_pattern")
      .where("installation_id", "=", randomUUID())
      .execute();
    expect(ok).toEqual([]);
  });
});
