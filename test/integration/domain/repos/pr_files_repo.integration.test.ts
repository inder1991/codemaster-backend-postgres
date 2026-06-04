import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  derivePrFileId,
  PostgresPrFilesRepo,
} from "#backend/domain/repos/pr_files_repo.js";

import { FakeClock } from "#platform/clock.js";
import { TenancyViolation } from "#platform/db/tenancy_plugin.js";

import { type PrFileV1 } from "#contracts/pr_file.v1.js";

import { describeDb, INTEGRATION_DSN } from "../../_db.js";

// DB-gated integration test against a DISPOSABLE Postgres (migrations applied). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast stays green
// without a DB. We NEVER touch any other DB. Every test uses a UNIQUE installation_id so rows never
// collide, and cleans up the installation subtree (pr_files cascade-deletes with the PR) in finally.

const FIXED_CLOCK = new FakeClock({ now: new Date("2099-01-01T00:00:00.000Z") });

let pool: Pool;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  // ADR-0062: ONE memoized pool for raw seeding/asserts; the repo memoizes its OWN pool+Kysely by DSN.
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
});

afterAll(async () => {
  await pool?.end();
});

/** A positive bigint that fits Postgres `bigint` and is unique per call (github_* id columns). */
function uniqueBigint(): number {
  return (parseInt(randomUUID().replace(/-/g, "").slice(0, 12), 16) % 9_000_000_000) + 1;
}

/** A minimal valid PrFileV1 (the contract's identity columns are unused by the repo's binds). */
function makeFile(overrides: Partial<PrFileV1> & { file_path: string }): PrFileV1 {
  return {
    schema_version: 1,
    pr_file_id: randomUUID(),
    pr_id: randomUUID(),
    installation_id: randomUUID(),
    repository_id: randomUUID(),
    status: "modified",
    additions: 1,
    deletions: 0,
    previous_path: null,
    language: null,
    created_at: null,
    ...overrides,
  };
}

type Fixture = {
  installationId: string;
  repositoryId: string;
  ghUserId: string;
  prId: string;
};

/** Seed the FK parent rows (installation → repository → gh_user → pull_request) via RAW SQL (the
 *  tenancy plugin only fires on Kysely-built SELECT/UPDATE/DELETE, so raw seeding is unaffected). */
async function seedFixture(installationId: string): Promise<Fixture> {
  const repositoryId = randomUUID();
  const ghUserId = randomUUID();
  const prId = randomUUID();
  const opened = new Date("2099-01-01T00:00:00.000Z");

  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, uniqueBigint(), `acct-${installationId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO core.repositories
       (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, 'main', true)`,
    [repositoryId, installationId, uniqueBigint(), `org/repo-${repositoryId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type)
     VALUES ($1, $2, $3, 'User')`,
    [ghUserId, uniqueBigint(), `user-${ghUserId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO core.pull_requests
       (pr_id, installation_id, repository_id, github_pull_request_id, pr_number,
        author_gh_user_id, state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', 'test pr', 'main', $7, 'feature', $8, $9)`,
    [
      prId,
      installationId,
      repositoryId,
      uniqueBigint(),
      (uniqueBigint() % 100_000) + 1,
      ghUserId,
      "a".repeat(40),
      "b".repeat(40),
      opened,
    ],
  );

  return { installationId, repositoryId, ghUserId, prId };
}

/** Delete the whole installation subtree (pr_files cascade-delete with the PR). */
async function cleanup(fx: Fixture): Promise<void> {
  // pr_files → pull_requests cascade. Order respects ON DELETE RESTRICT on repositories/gh_users.
  // Delete ONLY the gh_user this fixture created (scoped by PK) — a table-wide orphan sweep races
  // sibling integration tests' live rows under vitest's default file-parallelism + shuffle.
  await pool.query(`DELETE FROM core.pull_requests WHERE installation_id = $1`, [fx.installationId]);
  await pool.query(`DELETE FROM core.repositories WHERE installation_id = $1`, [fx.installationId]);
  await pool.query(`DELETE FROM core.gh_users WHERE gh_user_id = $1`, [fx.ghUserId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [fx.installationId]);
}

function repoFor(): PostgresPrFilesRepo {
  // The repo memoizes its own pool+Kysely by DSN (ADR-0062), separate from the test's seed pool.
  return PostgresPrFilesRepo.fromDsn({ dsn: INTEGRATION_DSN as string, clock: FIXED_CLOCK });
}

describeDb("PostgresPrFilesRepo (integration, disposable PG)", () => {
  it("derivePrFileId matches the frozen Python uuid.uuid5 byte-for-byte", () => {
    const prId = "11111111-2222-3333-4444-555555555555";
    // Oracle values from vendor/codemaster-py/.venv/bin/python uuid.uuid5(NAMESPACE, f"{pr}|{path}").
    expect(derivePrFileId({ prId, filePath: "src/app.py" })).toBe(
      "a1c5ff57-6326-5330-8e23-21611d749031",
    );
    expect(derivePrFileId({ prId, filePath: "a" })).toBe(
      "0422c139-88f5-5a1d-a499-b45c9faafe7e",
    );
    expect(derivePrFileId({ prId, filePath: "path/with spaces/and-Unicode-cafe.ts" })).toBe(
      "38fb32a6-b44f-5d2a-9ac9-c1b24bf1c2f6",
    );
  });

  it("upsertFiles persists one row per file with the derived id; read-back equals", async () => {
    const installationId = randomUUID();
    const fx = await seedFixture(installationId);
    const repo = repoFor();
    try {
      const files: ReadonlyArray<PrFileV1> = [
        makeFile({ file_path: "src/b.ts", status: "added", additions: 10, deletions: 0 }),
        makeFile({
          file_path: "src/a.ts",
          status: "renamed",
          additions: 3,
          deletions: 4,
          previous_path: "src/old.ts",
          language: "TypeScript",
        }),
      ];
      const written = await repo.upsertFiles({
        prId: fx.prId,
        installationId,
        repositoryId: fx.repositoryId,
        files,
      });
      expect(written).toBe(2);

      const rows = await pool.query<{
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
      }>(
        `SELECT * FROM core.pr_files WHERE pr_id = $1 ORDER BY file_path ASC`,
        [fx.prId],
      );
      expect(rows.rows).toHaveLength(2);

      // Ordered by file_path ASC: src/a.ts then src/b.ts.
      const [a, b] = rows.rows;
      expect(a?.file_path).toBe("src/a.ts");
      expect(a?.pr_file_id).toBe(derivePrFileId({ prId: fx.prId, filePath: "src/a.ts" }));
      expect(a?.installation_id).toBe(installationId);
      expect(a?.repository_id).toBe(fx.repositoryId);
      expect(a?.status).toBe("renamed");
      expect(a?.additions).toBe(3);
      expect(a?.deletions).toBe(4);
      expect(a?.previous_path).toBe("src/old.ts");
      expect(a?.language).toBe("TypeScript");
      // created_at comes from the injected clock, not wall-clock.
      expect(a?.created_at.toISOString()).toBe("2099-01-01T00:00:00.000Z");

      expect(b?.file_path).toBe("src/b.ts");
      expect(b?.status).toBe("added");
      expect(b?.additions).toBe(10);
      expect(b?.previous_path).toBeNull();
      expect(b?.language).toBeNull();
    } finally {
      await cleanup(fx);
    }
  });

  it("upsertFiles is idempotent on (pr_id, file_path) and applies the new values on conflict", async () => {
    const installationId = randomUUID();
    const fx = await seedFixture(installationId);
    const repo = repoFor();
    try {
      await repo.upsertFiles({
        prId: fx.prId,
        installationId,
        repositoryId: fx.repositoryId,
        files: [makeFile({ file_path: "f.ts", status: "added", additions: 1, deletions: 0 })],
      });
      // Replay with a renamed/updated shape for the SAME (pr_id, file_path): the EXCLUDED.* values win.
      const written = await repo.upsertFiles({
        prId: fx.prId,
        installationId,
        repositoryId: fx.repositoryId,
        files: [
          makeFile({
            file_path: "f.ts",
            status: "renamed",
            additions: 99,
            deletions: 7,
            previous_path: "old-f.ts",
            language: "Python",
          }),
        ],
      });
      expect(written).toBe(1);

      const rows = await pool.query<{
        status: string;
        additions: number;
        deletions: number;
        previous_path: string | null;
        language: string | null;
      }>(`SELECT status, additions, deletions, previous_path, language FROM core.pr_files WHERE pr_id = $1`, [
        fx.prId,
      ]);
      // Still exactly ONE row (idempotent), carrying the updated values.
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.status).toBe("renamed");
      expect(rows.rows[0]?.additions).toBe(99);
      expect(rows.rows[0]?.deletions).toBe(7);
      expect(rows.rows[0]?.previous_path).toBe("old-f.ts");
      expect(rows.rows[0]?.language).toBe("Python");
    } finally {
      await cleanup(fx);
    }
  });

  it("upsertFiles returns 0 and writes nothing for an empty file list", async () => {
    const installationId = randomUUID();
    const fx = await seedFixture(installationId);
    const repo = repoFor();
    try {
      const written = await repo.upsertFiles({
        prId: fx.prId,
        installationId,
        repositoryId: fx.repositoryId,
        files: [],
      });
      expect(written).toBe(0);
      const rows = await pool.query(`SELECT 1 FROM core.pr_files WHERE pr_id = $1`, [fx.prId]);
      expect(rows.rowCount).toBe(0);
    } finally {
      await cleanup(fx);
    }
  });

  it("listFilePathsForPr returns paths ordered by file_path ASC, scoped by installation_id", async () => {
    const installationId = randomUUID();
    const fx = await seedFixture(installationId);
    const repo = repoFor();
    try {
      await repo.upsertFiles({
        prId: fx.prId,
        installationId,
        repositoryId: fx.repositoryId,
        files: [
          makeFile({ file_path: "z/last.ts" }),
          makeFile({ file_path: "a/first.ts" }),
          makeFile({ file_path: "m/middle.ts" }),
        ],
      });
      const paths = await repo.listFilePathsForPr({ installationId, prId: fx.prId });
      expect(paths).toEqual(["a/first.ts", "m/middle.ts", "z/last.ts"]);
    } finally {
      await cleanup(fx);
    }
  });

  it("tenant isolation: installation A's list query does not see installation B's rows", async () => {
    const installA = randomUUID();
    const installB = randomUUID();
    const fxA = await seedFixture(installA);
    const fxB = await seedFixture(installB);
    const repo = repoFor();
    try {
      await repo.upsertFiles({
        prId: fxA.prId,
        installationId: installA,
        repositoryId: fxA.repositoryId,
        files: [makeFile({ file_path: "a-only.ts" })],
      });
      await repo.upsertFiles({
        prId: fxB.prId,
        installationId: installB,
        repositoryId: fxB.repositoryId,
        files: [makeFile({ file_path: "b-only.ts" })],
      });

      // Querying A's installation but B's pr_id returns NOTHING (the installation_id predicate scopes).
      const crossTenant = await repo.listFilePathsForPr({
        installationId: installA,
        prId: fxB.prId,
      });
      expect(crossTenant).toEqual([]);

      // Each installation sees only its own row under its own PR.
      expect(await repo.listFilePathsForPr({ installationId: installA, prId: fxA.prId })).toEqual([
        "a-only.ts",
      ]);
      expect(await repo.listFilePathsForPr({ installationId: installB, prId: fxB.prId })).toEqual([
        "b-only.ts",
      ]);
    } finally {
      await cleanup(fxA);
      await cleanup(fxB);
    }
  });

  it("the tenancy plugin refuses a SELECT on core.pr_files with no installation_id predicate", async () => {
    // Defense-in-depth proof: a tenant-scoped SELECT built WITHOUT the installation_id filter is
    // refused at query-build time by the installed TenancyPlugin (invariant #10).
    const { Kysely, PostgresDialect } = await import("kysely");
    const { TenancyPlugin } = await import("#platform/db/tenancy_plugin.js");
    const db = new Kysely<{ "core.pr_files": { file_path: string; pr_id: string } }>({
      dialect: new PostgresDialect({ pool }),
      plugins: [new TenancyPlugin()],
    });
    await expect(
      db
        .selectFrom("core.pr_files")
        .select("file_path")
        .where("pr_id", "=", randomUUID())
        .execute(),
    ).rejects.toBeInstanceOf(TenancyViolation);
  });
});
