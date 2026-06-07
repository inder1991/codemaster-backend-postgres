/**
 * Integration test for `mutexJanitorActivity` — 1:1 port of the frozen Python
 * codemaster/activities/mutex_janitor.py::mutex_janitor_activity. Runs against a DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set (describeDb); SKIPS otherwise.
 *
 * Coverage (the activity's observable behaviour):
 *   - the sweep SELECT claims rows that are LIVE (released_at IS NULL) AND lease-expired
 *     (lease_expires_at < now()); rows whose lease is still valid, or that are already released, are
 *     NOT claimed.
 *   - each claimed row's released_at is stamped from the INJECTED clock (here a WallClock — we assert it
 *     is non-null) and ONE audit row (action='mutex.swept', actor_kind='system', target_id=mutex_id) is
 *     written for it.
 *   - the result is MutexJanitorResultV1 with scanned == swept == #eligible.
 *
 * Every seeded row is scoped to a UNIQUE random installation_id and DELETEd in a `finally`.
 */
import { createHash, randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { mutexJanitorActivity } from "#backend/activities/mutex_janitor.activity.js";

import { resetAuditKeyRegistryForTesting, setAuditKeyRegistry } from "#backend/security/audit_field_codec.js";

import { getPool, disposePool } from "#platform/db/database.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;

if (INTEGRATION_DSN) {
  pool = getPool(INTEGRATION_DSN);
}

/** Install a deterministic dev key registry so the audit before/after encrypt has a key without Vault. */
beforeAll(() => {
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(0x42)]]) }));
  setAuditKeyRegistry(reg);
});

afterAll(async () => {
  resetAuditKeyRegistryForTesting();
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

/** Deterministic-but-unique v4 UUID for fixtures. */
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

/** A bigint that fits the `bigint`/`integer` GitHub-id columns and is process-unique. */
function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = { installationId: string; repositoryId: string };

/** Seed the FK chain (installation → repository) the mutex FKs point at. */
async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const repositoryId = newUuid();
  const ghInstall = uniqueBigint();
  const ghRepo = uniqueBigint();

  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, ghInstall, `acct-${ghInstall}`],
  );
  await pool.query(
    `INSERT INTO core.repositories
       (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, 'main', true)`,
    [repositoryId, installationId, ghRepo, `org/repo-${ghRepo}`],
  );
  return { installationId, repositoryId };
}

/** Insert one mutex row; lease/released expressed as raw SQL fragments so we can use `now()±interval`. */
async function seedMutex(
  seed: Seed,
  prNumber: number,
  opts: { releasedAtSql: string; leaseExpiresAtSql: string; holder: string },
): Promise<string> {
  const mutexId = newUuid();
  await pool.query(
    `INSERT INTO core.pr_review_mutex
       (mutex_id, installation_id, repository_id, pr_number, holder_workflow_id,
        released_at, lease_expires_at)
     VALUES ($1, $2, $3, $4, $5, ${opts.releasedAtSql}, ${opts.leaseExpiresAtSql})`,
    [mutexId, seed.installationId, seed.repositoryId, prNumber, opts.holder],
  );
  return mutexId;
}

async function cleanup(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM audit.audit_events WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.pr_review_mutex WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.repositories WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [seed.installationId]);
}

type MutexRow = { mutex_id: string; released_at: Date | null };

async function fetchMutex(mutexId: string): Promise<MutexRow | undefined> {
  const r = await pool.query<MutexRow>(
    `SELECT mutex_id, released_at FROM core.pr_review_mutex WHERE mutex_id = $1`,
    [mutexId],
  );
  return r.rows[0];
}

type AuditRow = { action: string; target_id: string | null; actor_kind: string };

async function fetchAuditRows(installationId: string): Promise<ReadonlyArray<AuditRow>> {
  const r = await pool.query<AuditRow>(
    `SELECT action, target_id, actor_kind FROM audit.audit_events WHERE installation_id = $1`,
    [installationId],
  );
  return r.rows;
}

describeDb("mutexJanitorActivity (integration, disposable PG)", () => {
  it("sweeps lease-expired live rows, preserves valid + already-released rows, emits one audit/row", async () => {
    const seed = await seedTenant();
    // Row A — ELIGIBLE: live (released_at NULL) AND lease expired (now()-1h).
    const mutexA = await seedMutex(seed, 11, {
      releasedAtSql: "NULL",
      leaseExpiresAtSql: "now() - interval '1 hour'",
      holder: "wf-A",
    });
    // Row B — live but lease still VALID (now()+1h): the eligibility predicate excludes it.
    const mutexB = await seedMutex(seed, 22, {
      releasedAtSql: "NULL",
      leaseExpiresAtSql: "now() + interval '1 hour'",
      holder: "wf-B",
    });
    // Row C — already RELEASED (released_at set): the SELECT filters `released_at IS NULL`, so skipped.
    const mutexC = await seedMutex(seed, 33, {
      releasedAtSql: "now()",
      leaseExpiresAtSql: "now() - interval '1 hour'",
      holder: "wf-C",
    });
    // NOTE: a (released_at NULL, lease_expires_at NULL) row is FORBIDDEN by the CHECK constraint
    // `pr_review_mutex_live_has_lease` ((released_at IS NOT NULL) OR (lease_expires_at IS NOT NULL)), so
    // it cannot be seeded here. The activity's `lease_expires_at IS NULL` disjunct is defensive for
    // pre-CHECK legacy rows and is structurally unreachable in this DB — hence not exercised by a fixture.
    try {
      // INTEGRATION_DSN is defined inside `describeDb` (the block is `describe.skip` otherwise); the `??`
      // narrows `string | undefined` -> `string` for `exactOptionalPropertyTypes` without changing behaviour.
      const result = await mutexJanitorActivity({ dsn: INTEGRATION_DSN ?? "" });

      // Only Row A was claimed + swept.
      expect(result.scanned).toBe(1);
      expect(result.swept).toBe(1);
      expect(result.schema_version).toBe(1);

      // Row A is now released; Rows B and C are unchanged (B still null, C still set).
      const rowA = await fetchMutex(mutexA);
      const rowB = await fetchMutex(mutexB);
      const rowC = await fetchMutex(mutexC);
      expect(rowA?.released_at).not.toBeNull();
      expect(rowB?.released_at).toBeNull();
      expect(rowC?.released_at).not.toBeNull(); // was already released; left as-is

      // Exactly ONE audit row — for Row A — with the swept shape.
      const audits = await fetchAuditRows(seed.installationId);
      expect(audits.length).toBe(1);
      const audit = audits[0]!;
      expect(audit.action).toBe("mutex.swept");
      expect(audit.target_id).toBe(mutexA);
      expect(audit.actor_kind).toBe("system");
    } finally {
      await cleanup(seed);
    }
  });
});
