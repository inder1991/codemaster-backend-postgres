/**
 * Integration test for the `sync_code_owners_activity` holder — REAL ported port of the frozen Python
 * `@activity.defn("sync_code_owners_activity")`
 * (vendor/codemaster-py/codemaster/activities/sync_code_owners.py::SyncCodeOwnersActivity.sync_code_owners),
 * against a DISPOSABLE Postgres (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the
 * in-cluster DB). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise.
 *
 * The GitHub side is a STUB CodeOwnersFilePort (no live calls): it returns a base64-encoded CODEOWNERS body
 * + a 40-hex blob SHA, exactly the [contentBytes, blobSha] shape the production spine adapter yields from
 * `GitHubApiClient.getContents`. The activity parses it via the ported `parseCodeowners` and upserts each
 * rule into `core.code_owners` through the REAL {@link PostgresCodeOwnersRepo}.
 *
 * Assertions (1:1 with the Python behaviour):
 *   - flag ON  → real rows written to core.code_owners for the repo (count == returned int; rows readable
 *     back via listRulesForRepository, owner_logins text[] byte-faithful, source_file_sha == blob SHA).
 *   - flag ON, replay same SHA → ON CONFLICT DO NOTHING → second call returns 0 (idempotent).
 *   - flag OFF → no-op: returns 0, the stub GitHub client is NEVER called, zero rows written.
 *   - flag ON, no CODEOWNERS file (stub returns null) → returns 0, zero rows.
 *
 * Each test owns a UNIQUE installation_id / repository_id (+ unique github_* bigints) so per-org rows never
 * collide, and cleans up (children before parents).
 */

import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { SyncCodeOwnersActivity } from "#backend/activities/sync_code_owners.activity.js";
import { PostgresCodeOwnersRepo } from "#backend/domain/repos/code_owners_repo.js";

import type { SyncCodeOwnersPayloadV1 } from "#contracts/sync_code_owners_payload.v1.js";

import { WallClock } from "#platform/clock.js";
import { disposeAllPools, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// Minimal typing for the FK-parent seeding + read-back assertions (NOT part of the activity's surface).
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
  db = tenantKysely<SeedDb>(INTEGRATION_DSN);
});

afterAll(async () => {
  await disposeAllPools();
});

/** A unique positive int64-safe bigint for github_* UNIQUE columns. */
function uniqueGithubId(): bigint {
  return BigInt(`0x${randomUUID().replace(/-/g, "").slice(0, 12)}`);
}

/** Seed the FK parents (installation + repository) a code_owners row requires. */
async function seedParents(args: {
  installationId: string;
  repositoryId: string;
}): Promise<void> {
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
  installationId: string;
  repositoryId: string;
}): Promise<void> {
  await sql`DELETE FROM core.code_owners WHERE repository_id = ${args.repositoryId}`.execute(db);
  await sql`DELETE FROM core.repositories WHERE repository_id = ${args.repositoryId}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${args.installationId}`.execute(db);
}

/** Count code_owners rows for a repo (raw — bypasses the parser read-path's latest-SHA CTE). */
async function countRows(installationId: string, repositoryId: string): Promise<number> {
  const r = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM core.code_owners
    WHERE installation_id = ${installationId} AND repository_id = ${repositoryId}
  `.execute(db);
  return Number(r.rows[0]?.n);
}

const SHA = "a".repeat(40);

const CODEOWNERS_BODY = [
  "# A representative CODEOWNERS file",
  "*           @org/global-owners",
  "/docs/      @org/docs-team @writer",
  "src/**.ts   @indersingh   # trailing comment ignored",
  "",
  "malformed-no-owners",
].join("\n");

/**
 * A stub {@link CodeOwnersFilePort}. Returns the configured [contentBytes(base64-of-body), blobSha] tuple,
 * or null. Records every call so the flag-OFF test can assert the activity short-circuits BEFORE any fetch.
 */
function stubGithub(opts: {
  body: string | null;
  sha?: string;
}): {
  github: ConstructorParameters<typeof SyncCodeOwnersActivity>[0]["github"];
  callCount: () => number;
} {
  let calls = 0;
  return {
    github: {
      fetchCodeowners: async (): Promise<readonly [Uint8Array, string] | null> => {
        await Promise.resolve();
        calls += 1;
        if (opts.body === null) return null;
        // The production GitHubApiClient.getContents returns the BASE64-ASCII bytes (the contents API body
        // is base64); the activity base64-decodes. Mirror that here.
        const b64 = Buffer.from(opts.body, "utf-8").toString("base64");
        return [new Uint8Array(Buffer.from(b64, "ascii")), opts.sha ?? SHA] as const;
      },
    },
    callCount: () => calls,
  };
}

function activity(args: {
  github: ConstructorParameters<typeof SyncCodeOwnersActivity>[0]["github"];
  enabled: boolean;
}): SyncCodeOwnersActivity {
  return new SyncCodeOwnersActivity({
    github: args.github,
    repo: PostgresCodeOwnersRepo.fromDsn(INTEGRATION_DSN ?? ""),
    isEnabled: async (): Promise<boolean> => {
      await Promise.resolve();
      return args.enabled;
    },
    clock: new WallClock(),
  });
}

function input(installationId: string, repositoryId: string): SyncCodeOwnersPayloadV1 {
  return {
    schema_version: 1,
    installation_id_uuid: installationId,
    installation_id_int: 4242,
    repository_id: repositoryId,
    owner: "org",
    repo: "widgets",
    default_branch: "main",
  };
}

describeDb("sync_code_owners_activity (integration, disposable PG)", () => {
  it("flag ON: fetches + parses CODEOWNERS and writes real core.code_owners rows", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    try {
      const gh = stubGithub({ body: CODEOWNERS_BODY, sha: SHA });
      const act = activity({ github: gh.github, enabled: true });

      const written = await act.syncCodeOwners(input(installationId, repositoryId));

      // The parser yields 3 valid rules (the 4th line is a comment, the 6th has no owners → dropped).
      expect(written).toBe(3);
      expect(gh.callCount()).toBe(1);
      expect(await countRows(installationId, repositoryId)).toBe(3);

      // Read back via the repo's latest-SHA CTE; owner_logins text[] round-trips byte-faithfully.
      const read = await PostgresCodeOwnersRepo.fromDsn(INTEGRATION_DSN ?? "").listRulesForRepository({
        installationId,
        repositoryId,
      });
      const byPattern = new Map(read.map((r) => [r.path_pattern, r.owner_logins]));
      expect(byPattern.get("*")).toEqual(["@org/global-owners"]);
      expect(byPattern.get("/docs/")).toEqual(["@org/docs-team", "@writer"]);
      expect(byPattern.get("src/**.ts")).toEqual(["@indersingh"]);

      // source_file_sha persisted == the stub blob SHA.
      const shas = await sql<{ source_file_sha: string }>`
        SELECT DISTINCT source_file_sha FROM core.code_owners
        WHERE installation_id = ${installationId} AND repository_id = ${repositoryId}
      `.execute(db);
      expect(shas.rows.map((r) => r.source_file_sha.trim())).toEqual([SHA]);
    } finally {
      await cleanup({ installationId, repositoryId });
    }
  });

  it("flag ON: replaying the same SHA is idempotent — second call returns 0, no duplicate rows", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    try {
      const gh = stubGithub({ body: CODEOWNERS_BODY, sha: SHA });
      const act = activity({ github: gh.github, enabled: true });

      const first = await act.syncCodeOwners(input(installationId, repositoryId));
      expect(first).toBe(3);
      const second = await act.syncCodeOwners(input(installationId, repositoryId));
      expect(second).toBe(0); // ON CONFLICT (repository_id, path_pattern, source_file_sha) DO NOTHING
      expect(await countRows(installationId, repositoryId)).toBe(3);
    } finally {
      await cleanup({ installationId, repositoryId });
    }
  });

  it("flag OFF: short-circuits to 0 without calling GitHub or writing rows", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    try {
      const gh = stubGithub({ body: CODEOWNERS_BODY, sha: SHA });
      const act = activity({ github: gh.github, enabled: false });

      const written = await act.syncCodeOwners(input(installationId, repositoryId));

      expect(written).toBe(0);
      expect(gh.callCount()).toBe(0); // the flag gate fires BEFORE any GitHub fetch
      expect(await countRows(installationId, repositoryId)).toBe(0);
    } finally {
      await cleanup({ installationId, repositoryId });
    }
  });

  it("flag ON, no CODEOWNERS file: returns 0 and writes nothing", async () => {
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    await seedParents({ installationId, repositoryId });
    try {
      const gh = stubGithub({ body: null });
      const act = activity({ github: gh.github, enabled: true });

      const written = await act.syncCodeOwners(input(installationId, repositoryId));

      expect(written).toBe(0);
      expect(gh.callCount()).toBe(1); // the fetch IS attempted; it just yields null
      expect(await countRows(installationId, repositoryId)).toBe(0);
    } finally {
      await cleanup({ installationId, repositoryId });
    }
  });
});
