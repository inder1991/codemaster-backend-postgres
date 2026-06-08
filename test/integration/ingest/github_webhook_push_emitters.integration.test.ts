/**
 * Integration test for the PUSH-event webhook emitters (DM-WIRE T0 + Sprint 26 / B-3) — persistWebhook
 * against the DISPOSABLE Postgres (:5434, NEVER the cluster). Proves the 1:1 port of the frozen Python
 * `_maybe_emit_sync_code_owners` + `_maybe_emit_refresh_semantic_docs`: a signed `push` to the
 * repository's DEFAULT BRANCH emits EXACTLY 2 temporal_workflow_start outbox rows
 * (workflow_type syncCodeOwners + refreshSemanticDocs, correct SyncCodeOwnersPayloadV1 /
 * RefreshSemanticDocsInputV1 args); a NON-default-branch push, a deduped re-delivery, and a non-push
 * event all emit 0.
 */

import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { persistWebhook } from "#backend/ingest/github_webhook_persistence.js";

import { RefreshSemanticDocsInputV1 } from "#contracts/refresh_semantic_docs.v1.js";
import { SyncCodeOwnersPayloadV1 } from "#contracts/sync_code_owners_payload.v1.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const CLOCK = new FakeClock({ now: new Date("2099-07-08T09:10:11.000Z") });
const HEAD_SHA = "c".repeat(40);

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
  githubInstallationId: number;
  githubRepoId: number;
  defaultBranch: string;
  owner: string;
  repoName: string;
};

async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const githubInstallationId = uniqueBigint();
  const githubRepoId = uniqueBigint();
  const defaultBranch = "main";
  const owner = "octo";
  const repoName = `repo-${githubRepoId}`;
  await pool.query(
    `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, 'octo', 'Organization')`,
    [installationId, githubInstallationId],
  );
  await pool.query(
    `INSERT INTO core.repositories (installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, true)`,
    [installationId, githubRepoId, `${owner}/${repoName}`, defaultBranch],
  );
  return { installationId, githubInstallationId, githubRepoId, defaultBranch, owner, repoName };
}

/** A GitHub `push` webhook body — `ref` defaults to the repo's default branch (refs/heads/main). */
function pushBody(seed: Seed, ref = `refs/heads/${seed.defaultBranch}`): string {
  return JSON.stringify({
    ref,
    after: HEAD_SHA,
    repository: {
      id: seed.githubRepoId,
      name: seed.repoName,
      full_name: `${seed.owner}/${seed.repoName}`,
      default_branch: seed.defaultBranch,
      owner: { id: 1, login: seed.owner, type: "Organization" },
    },
    installation: { id: seed.githubInstallationId },
    sender: { id: 7, login: "octocat", type: "User" },
  });
}

async function outboxRows(
  seed: Seed,
): Promise<Array<{ sink: string; payload: Record<string, unknown> }>> {
  const r = await pool.query<{ sink: string; payload: Record<string, unknown> }>(
    `SELECT sink, payload FROM core.outbox WHERE installation_id = $1 ORDER BY created_at`,
    [seed.installationId],
  );
  return r.rows;
}

async function cleanup(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM core.outbox WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM audit.webhook_events WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM cache.cache_idempotency WHERE cache_key LIKE $1`, [
    `github-webhook:${seed.githubInstallationId}:%`,
  ]);
  await pool.query(`DELETE FROM core.repositories WHERE github_repo_id = $1`, [seed.githubRepoId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [seed.installationId]);
}

describeDb("github webhook push emitters (integration, disposable PG)", () => {
  it("default-branch push → EXACTLY 2 outbox rows (syncCodeOwners + refreshSemanticDocs, valid payloads)", async () => {
    const seed = await seedTenant();
    const delivery = `push-${seed.githubRepoId}-default`;
    try {
      const result = await persistWebhook({
        db,
        body: new TextEncoder().encode(pushBody(seed)),
        headers: { "x-github-delivery": delivery, "x-github-event": "push" },
        signatureValid: true,
        clock: CLOCK,
      });
      expect(result.deduped).toBe(false);

      const rows = await outboxRows(seed);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.sink === "temporal_workflow_start")).toBe(true);

      const byType = new Map(
        rows.map((r) => [(r.payload as { workflow_type: string }).workflow_type, r.payload]),
      );

      // (1) syncCodeOwners
      const sco = byType.get("syncCodeOwners");
      expect(sco).toBeDefined();
      expect(sco!["task_queue"]).toBe("review-default");
      expect(sco!["workflow_id"]).toBe(
        `sync-code-owners/${seed.installationId}/${(
          await pool.query<{ repository_id: string }>(
            `SELECT repository_id FROM core.repositories WHERE github_repo_id = $1`,
            [seed.githubRepoId],
          )
        ).rows[0]!.repository_id}/${HEAD_SHA}`,
      );
      const scoArgs = sco!["args"] as Array<unknown>;
      const scoPayload = SyncCodeOwnersPayloadV1.parse(scoArgs[0]);
      expect(scoPayload.installation_id_uuid).toBe(seed.installationId);
      expect(scoPayload.installation_id_int).toBe(seed.githubInstallationId);
      expect(scoPayload.owner).toBe(seed.owner);
      expect(scoPayload.repo).toBe(seed.repoName);
      expect(scoPayload.default_branch).toBe(seed.defaultBranch);

      // (2) refreshSemanticDocs
      const rsd = byType.get("refreshSemanticDocs");
      expect(rsd).toBeDefined();
      expect(rsd!["task_queue"]).toBe("review-default");
      const rsdArgs = rsd!["args"] as Array<unknown>;
      const rsdPayload = RefreshSemanticDocsInputV1.parse(rsdArgs[0]);
      expect(rsdPayload.installation_id).toBe(seed.installationId);
      expect(rsdPayload.triggered_by).toBe("default_branch_push");
      expect(rsdPayload.head_sha).toBe(HEAD_SHA);
      expect(scoPayload.repository_id).toBe(rsdPayload.repository_id);
    } finally {
      await cleanup(seed);
    }
  });

  it("non-default-branch push → 0 outbox rows", async () => {
    const seed = await seedTenant();
    const delivery = `push-${seed.githubRepoId}-feature`;
    try {
      const result = await persistWebhook({
        db,
        body: new TextEncoder().encode(pushBody(seed, "refs/heads/feature/x")),
        headers: { "x-github-delivery": delivery, "x-github-event": "push" },
        signatureValid: true,
        clock: CLOCK,
      });
      expect(result.deduped).toBe(false);
      expect(await outboxRows(seed)).toHaveLength(0);
    } finally {
      await cleanup(seed);
    }
  });

  it("deduped re-delivery of a default-branch push → 0 NEW outbox rows on the second delivery", async () => {
    const seed = await seedTenant();
    const delivery = `push-${seed.githubRepoId}-redeliver`;
    const body = new TextEncoder().encode(pushBody(seed));
    try {
      const first = await persistWebhook({
        db,
        body,
        headers: { "x-github-delivery": delivery, "x-github-event": "push" },
        signatureValid: true,
        clock: CLOCK,
      });
      const second = await persistWebhook({
        db,
        body,
        headers: { "x-github-delivery": delivery, "x-github-event": "push" },
        signatureValid: true,
        clock: CLOCK,
      });
      expect(first.deduped).toBe(false);
      expect(second.deduped).toBe(true);
      // First emitted 2; the deduped second emits 0 → total stays 2.
      expect(await outboxRows(seed)).toHaveLength(2);
    } finally {
      await cleanup(seed);
    }
  });

  it("non-push event (pull_request) → push emitters add 0 rows of their workflow types", async () => {
    const seed = await seedTenant();
    const delivery = `push-${seed.githubRepoId}-nonpush`;
    try {
      // A push body delivered under the `pull_request` event header — extractPrMetadata returns null (no
      // pull_request object), so NO review dispatch + the push emitters skip on event_type !== "push".
      const result = await persistWebhook({
        db,
        body: new TextEncoder().encode(pushBody(seed)),
        headers: { "x-github-delivery": delivery, "x-github-event": "pull_request" },
        signatureValid: true,
        clock: CLOCK,
      });
      expect(result.deduped).toBe(false);
      const rows = await outboxRows(seed);
      const types = new Set(rows.map((r) => (r.payload as { workflow_type?: string }).workflow_type));
      expect(types.has("syncCodeOwners")).toBe(false);
      expect(types.has("refreshSemanticDocs")).toBe(false);
    } finally {
      await cleanup(seed);
    }
  });
});
