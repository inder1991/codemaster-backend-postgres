/**
 * Integration test for the auto-registration RECONCILE-EMIT wiring (the INTEGRATOR coupling) — drives
 * `persistWebhook` end-to-end against the DISPOSABLE Postgres (CODEMASTER_PG_CORE_DSN → localhost:5433,
 * NEVER the cluster) and asserts the producer writes the `installation_reconcile` outbox row with the
 * combined-pod envelope (workflow_type "reconcileRepositories" / "reconcileInstallation", task_queue
 * "review-default", id policies ALLOW_DUPLICATE / USE_EXISTING, args[0] = the typed payload).
 *
 * This proves the webhook → outbox leg of the chain: GitHub installation_repositories / installation events
 * → maybeEmitInstallationReconcile → PostgresOutboxRepo.appendReconcile → core.outbox row (sink
 * installation_reconcile, run_id NULL, installation_id NULL). The outbox → workflow leg (the
 * installation_reconcile sink + the worker registration) is exercised by the worker/sink unit tests.
 */

import { randomInt } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { persistWebhook } from "#backend/ingest/github_webhook_persistence.js";

import {
  GitHubInstallationPayloadV1,
  GitHubInstallationRepositoriesPayloadV1,
} from "#contracts/github_installation_payload.v1.js";

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

/** A reconcile outbox row, projected for assertions. */
type ReconcileOutboxRow = {
  sink: string;
  run_id: string | null;
  installation_id: string | null;
  payload: Record<string, unknown>;
};

async function fetchReconcileRows(deliveryId: string): Promise<Array<ReconcileOutboxRow>> {
  const res = await pool.query<ReconcileOutboxRow>(
    `SELECT sink, run_id, installation_id, payload FROM core.outbox
     WHERE delivery_id = $1 AND sink = 'installation_reconcile'`,
    [deliveryId],
  );
  return res.rows;
}

async function cleanupDelivery(githubIid: number, deliveryId: string): Promise<void> {
  await pool.query(`DELETE FROM core.outbox WHERE delivery_id = $1`, [deliveryId]);
  await pool.query(`DELETE FROM audit.webhook_events WHERE delivery_id = $1`, [deliveryId]);
  await pool.query(`DELETE FROM cache.cache_idempotency WHERE cache_key LIKE $1`, [
    `github-webhook:${githubIid}:%`,
  ]);
}

describeDb("auto-registration reconcile-emit wiring (integration, disposable PG :5433)", () => {
  it("installation_repositories.added → ONE installation_reconcile row → reconcileRepositories / review-default", async () => {
    const githubIid = uniqueBigint();
    const githubRepoId = uniqueBigint();
    const delivery = `recon-repos-${githubRepoId}`;
    const body = JSON.stringify({
      action: "added",
      installation: { id: githubIid },
      sender: { id: 7, login: "octocat", type: "User" },
      repositories_added: [
        {
          id: githubRepoId,
          full_name: `octo/repo-${githubRepoId}`,
          default_branch: "main",
          archived: false,
          owner: { id: 1, login: "octo", type: "Organization" },
        },
      ],
      repositories_removed: [],
    });
    try {
      const result = await persistWebhook({
        db,
        body: new TextEncoder().encode(body),
        headers: { "x-github-delivery": delivery, "x-github-event": "installation_repositories" },
        signatureValid: true,
        clock: CLOCK,
      });
      expect(result.deduped).toBe(false);

      const rows = await fetchReconcileRows(delivery);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // The reconcile sink carries NULL run_id + NULL installation_id (the schema exemption).
      expect(row.run_id).toBeNull();
      expect(row.installation_id).toBeNull();

      const payload = row.payload;
      expect(payload["workflow_type"]).toBe("reconcileRepositories");
      expect(payload["task_queue"]).toBe("review-default");
      expect(payload["workflow_id"]).toBe(`reconcile-repositories/${githubIid}`);
      expect(payload["id_reuse_policy"]).toBe("ALLOW_DUPLICATE");
      expect(payload["id_conflict_policy"]).toBe("USE_EXISTING");

      // args[0] is a valid GitHubInstallationRepositoriesPayloadV1 carrying the added repo.
      const argsArr = payload["args"] as Array<unknown>;
      const parsed = GitHubInstallationRepositoriesPayloadV1.parse(argsArr[0]);
      expect(parsed.action).toBe("added");
      expect(parsed.installation.id).toBe(githubIid);
      expect(parsed.repositories_added).toHaveLength(1);
      expect(parsed.repositories_added[0]!.id).toBe(githubRepoId);
    } finally {
      await cleanupDelivery(githubIid, delivery);
    }
  });

  it("installation.created → ONE installation_reconcile row → reconcileInstallation / review-default (suspend→suspended normalized)", async () => {
    const githubIid = uniqueBigint();
    const delivery = `recon-install-${githubIid}`;
    // Use action "suspend" to also assert the producer normalizes suspend → suspended before validation.
    const body = JSON.stringify({
      action: "suspend",
      installation: { id: githubIid, account: { id: 1, login: "octo", type: "Organization" } },
      sender: { id: 7, login: "octocat", type: "User" },
    });
    try {
      const result = await persistWebhook({
        db,
        body: new TextEncoder().encode(body),
        headers: { "x-github-delivery": delivery, "x-github-event": "installation" },
        signatureValid: true,
        clock: CLOCK,
      });
      expect(result.deduped).toBe(false);

      const rows = await fetchReconcileRows(delivery);
      expect(rows).toHaveLength(1);
      const payload = rows[0]!.payload;
      expect(payload["workflow_type"]).toBe("reconcileInstallation");
      expect(payload["task_queue"]).toBe("review-default");
      expect(payload["workflow_id"]).toBe(`reconcile-installation/${githubIid}`);

      const argsArr = payload["args"] as Array<unknown>;
      const parsed = GitHubInstallationPayloadV1.parse(argsArr[0]);
      expect(parsed.action).toBe("suspended"); // normalized from "suspend"
      expect(parsed.installation.id).toBe(githubIid);
    } finally {
      await cleanupDelivery(githubIid, delivery);
    }
  });

  it("re-delivery (deduped) emits NO second reconcile row", async () => {
    const githubIid = uniqueBigint();
    const delivery = `recon-dedup-${githubIid}`;
    const body = new TextEncoder().encode(
      JSON.stringify({
        action: "created",
        installation: { id: githubIid, account: { id: 1, login: "octo", type: "Organization" } },
        sender: { id: 7, login: "octocat", type: "User" },
      }),
    );
    try {
      const first = await persistWebhook({
        db,
        body,
        headers: { "x-github-delivery": delivery, "x-github-event": "installation" },
        signatureValid: true,
        clock: CLOCK,
      });
      const second = await persistWebhook({
        db,
        body,
        headers: { "x-github-delivery": delivery, "x-github-event": "installation" },
        signatureValid: true,
        clock: CLOCK,
      });
      expect(first.deduped).toBe(false);
      expect(second.deduped).toBe(true);
      const rows = await fetchReconcileRows(delivery);
      expect(rows).toHaveLength(1); // not two
    } finally {
      await cleanupDelivery(githubIid, delivery);
    }
  });
});
