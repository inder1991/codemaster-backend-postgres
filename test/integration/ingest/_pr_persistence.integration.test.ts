/**
 * Integration test for the PR-metadata persistence port (S3) against the DISPOSABLE Postgres (set
 * CODEMASTER_PG_CORE_DSN at a throwaway DB with the migrations applied — NEVER the cluster; SKIPs otherwise).
 *
 * Proves the chain the review pipeline depends on:
 *   - maybePersistPr writes the trio gh_users → pull_requests → pr_state_transitions for an `opened` PR, and
 *   - a subsequent core.pr_files INSERT against the derived pr_id SUCCEEDS (the fk_pr_files_pr_id_pull_requests
 *     constraint that was violating before S3 — the live-smoke `enrich_pr_files` failure).
 *   - idempotency: a redelivery (same payload + delivery_id) leaves exactly one pull_requests + one transition.
 *   - fail-open: safePersistPr swallows a persistence fault (FK violation) WITHOUT poisoning the outer
 *     transaction — a subsequent write in the same tx still succeeds.
 */

import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { extractPrMetadata } from "#backend/ingest/_webhook_extractors.js";
import { derivePrId } from "#backend/ingest/_pr_id.js";
import { maybePersistPr, safePersistPr } from "#backend/ingest/_pr_persistence.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const CLOCK = new FakeClock({ now: new Date("2099-07-08T09:10:11.000Z") });

let pool: Pool;
let db: Kysely<unknown>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }), plugins: [new TenancyPlugin()] });
});
afterAll(async () => {
  await db?.destroy();
});

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}
function newUuid(): string {
  const h = createHash("sha1")
    .update(Buffer.from(`${process.hrtime.bigint()}-${randomInt(0, 1 << 30)}`, "utf-8"))
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x40, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hx = b.toString("hex");
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20, 32)}`;
}

type Seed = {
  installationId: string;
  repositoryId: string;
  githubRepoId: number;
  prNumber: number;
  githubUserId: number;
};

async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const githubInstallationId = uniqueBigint();
  const githubRepoId = uniqueBigint();
  const prNumber = (uniqueBigint() % 9000) + 1;
  const githubUserId = uniqueBigint();
  await pool.query(
    `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, 'octo', 'Organization')`,
    [installationId, githubInstallationId],
  );
  const repo = await pool.query<{ repository_id: string }>(
    `INSERT INTO core.repositories (installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, 'main', true) RETURNING repository_id`,
    [installationId, githubRepoId, `octo/repo-${githubRepoId}`],
  );
  return { installationId, repositoryId: repo.rows[0]!.repository_id, githubRepoId, prNumber, githubUserId };
}

function prBody(seed: Seed, action = "opened"): Uint8Array {
  const account = { id: seed.githubUserId, login: "octocat", type: "User" };
  return Buffer.from(
    JSON.stringify({
      action,
      number: seed.prNumber,
      pull_request: {
        number: seed.prNumber,
        title: "Add widget",
        body: "a description",
        node_id: `PR_kw${seed.prNumber}`,
        head: { sha: "a".repeat(40), repo: { full_name: `octo/repo-${seed.githubRepoId}` }, ref: "feat/x" },
        base: { sha: "b".repeat(40), repo: { full_name: `octo/repo-${seed.githubRepoId}` }, ref: "main" },
        user: account,
        draft: false,
        merged: false,
        id: uniqueBigint(),
        created_at: "2026-01-01T00:00:00Z",
      },
      repository: {
        id: seed.githubRepoId,
        full_name: `octo/repo-${seed.githubRepoId}`,
        owner: { id: 1, login: "octo", type: "Organization" },
      },
      installation: { id: 1 },
      sender: account,
    }),
  );
}

describeDb("S3 PR-metadata persistence (maybePersistPr / safePersistPr) [integration]", () => {
  it("persists gh_users → pull_requests → pr_state_transitions for an opened PR, and a pr_files insert against the derived pr_id then SUCCEEDS (the FK chain)", async () => {
    const seed = await seedTenant();
    const prMeta = extractPrMetadata(prBody(seed));
    expect(prMeta).not.toBeNull();

    await db.transaction().execute(async (tx) => {
      await maybePersistPr(tx, {
        prMeta: prMeta!,
        internalIid: seed.installationId,
        internalRepoId: seed.repositoryId,
        deliveryId: `del-${seed.prNumber}-1`,
        clock: CLOCK,
      });
    });

    const prId = derivePrId({
      installationId: seed.installationId,
      repositoryId: seed.repositoryId,
      prNumber: seed.prNumber,
    });

    // gh_users (author) — the FK pull_requests requires.
    const ghu = await pool.query(
      `SELECT login, user_type FROM core.gh_users WHERE github_user_id = $1`,
      [seed.githubUserId],
    );
    expect(ghu.rows).toHaveLength(1);
    expect(ghu.rows[0]).toMatchObject({ login: "octocat", user_type: "User" });

    // pull_requests — keyed row with the derived pr_id, state=open, author FK set.
    const pr = await pool.query<{ pr_id: string; state: string; author_gh_user_id: string; title: string }>(
      `SELECT pr_id, state, author_gh_user_id, title FROM core.pull_requests
       WHERE installation_id = $1 AND repository_id = $2 AND pr_number = $3`,
      [seed.installationId, seed.repositoryId, seed.prNumber],
    );
    expect(pr.rows).toHaveLength(1);
    expect(pr.rows[0]!.pr_id).toBe(prId);
    expect(pr.rows[0]!.state).toBe("open");
    expect(pr.rows[0]!.title).toBe("Add widget");

    // pr_state_transitions — first-seen open: from_state NULL → to_state open.
    const tr = await pool.query<{ from_state: string | null; to_state: string }>(
      `SELECT from_state, to_state FROM core.pr_state_transitions WHERE pr_id = $1`,
      [prId],
    );
    expect(tr.rows).toHaveLength(1);
    expect(tr.rows[0]).toMatchObject({ from_state: null, to_state: "open" });

    // THE POINT: a pr_files insert against the derived pr_id now satisfies fk_pr_files_pr_id_pull_requests.
    await expect(
      pool.query(
        `INSERT INTO core.pr_files (installation_id, pr_id, repository_id, file_path, status, additions, deletions)
         VALUES ($1, $2, $3, 'src/a.ts', 'modified', 1, 0)`,
        [seed.installationId, prId, seed.repositoryId],
      ),
    ).resolves.toBeDefined();
  });

  it("is idempotent on redelivery — same payload + delivery_id leaves exactly one PR row and one transition", async () => {
    const seed = await seedTenant();
    const prMeta = extractPrMetadata(prBody(seed))!;
    const deliveryId = `del-${seed.prNumber}-dup`;
    for (let i = 0; i < 2; i += 1) {
      await db.transaction().execute(async (tx) => {
        await maybePersistPr(tx, {
          prMeta,
          internalIid: seed.installationId,
          internalRepoId: seed.repositoryId,
          deliveryId,
          clock: CLOCK,
        });
      });
    }
    const prId = derivePrId({
      installationId: seed.installationId,
      repositoryId: seed.repositoryId,
      prNumber: seed.prNumber,
    });
    const pr = await pool.query(
      `SELECT 1 FROM core.pull_requests WHERE installation_id = $1 AND repository_id = $2 AND pr_number = $3`,
      [seed.installationId, seed.repositoryId, seed.prNumber],
    );
    expect(pr.rows).toHaveLength(1);
    const tr = await pool.query(`SELECT 1 FROM core.pr_state_transitions WHERE pr_id = $1`, [prId]);
    expect(tr.rows).toHaveLength(1);
  });

  it("fail-open: safePersistPr swallows a persistence fault (unknown repository_id → FK violation) WITHOUT poisoning the outer transaction", async () => {
    const seed = await seedTenant();
    const prMeta = extractPrMetadata(prBody(seed))!;
    const bogusRepoId = newUuid(); // not in core.repositories → pull_requests FK violation

    let postWriteSucceeded = false;
    await db.transaction().execute(async (tx) => {
      // Must NOT throw despite the inner FK violation.
      await safePersistPr(tx, {
        prMeta,
        internalIid: seed.installationId,
        internalRepoId: bogusRepoId,
        deliveryId: `del-${seed.prNumber}-fail`,
        clock: CLOCK,
      });
      // The outer transaction is still usable (savepoint rollback did not poison it).
      const r = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(tx);
      postWriteSucceeded = r.rows[0]?.ok === 1;
    });
    expect(postWriteSucceeded).toBe(true);

    // No PR row was written for the bogus repo.
    const pr = await pool.query(
      `SELECT 1 FROM core.pull_requests WHERE installation_id = $1 AND repository_id = $2`,
      [seed.installationId, bogusRepoId],
    );
    expect(pr.rows).toHaveLength(0);
  });
});
