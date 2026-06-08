// Real-DB integration test for the Confluence page-approvals data-layer repo — the 1:1 TS port of the
// frozen Python vendor/codemaster-py/codemaster/domain/repos/confluence_page_approvals_repo.py.
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (the shared describeDb gate) — pointing at the
// DISPOSABLE Postgres (postgresql://postgres:postgres@localhost:5434/codemaster). SKIPS otherwise.
// NEVER hard-defaults the DSN and NEVER touches the in-cluster DB. Seeds are scoped to a unique
// test space_key and cleaned up in afterEach/afterAll.
//
// Coverage (the task test plan):
//  - upsertApproval inserts a row (actor_email from the keyword arg, never the request body).
//  - getActiveApproval returns the active row and EXCLUDES a revoked one (revoked_at IS NULL filter).
//  - re-upsert revokes the prior active row (revoked_by = actor) then inserts the new one — the
//    partial-unique index (space_key, page_id) WHERE revoked_at IS NULL stays satisfied.
//  - listForSpace returns active rows (and revoked too with includeRevoked).
//  - revoke flips revoked_at + revoked_by and returns whether a row changed.
//  - the biconditional revocation CHECK (mig 0106) is satisfied on every write.

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { PostgresConfluencePageApprovalsRepo } from "#backend/domain/repos/confluence_page_approvals_repo.js";

import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const TEST_SPACE = `ZZINTTEST_APPROVALS_${process.pid}`;

function makeRequest(pageId: string, justification = "Approved for the universal default scope by platform.") {
  return {
    schema_version: 1 as const,
    space_key: TEST_SPACE,
    page_id: pageId,
    approved_at_utc: "2026-05-01T00:00:00+00:00",
    approval_artifact_url: "https://wiki.example.com/approval/artifact",
    scope_justification: justification,
    default_scope: "universal" as const,
  };
}

describeDb("PostgresConfluencePageApprovalsRepo (integration)", () => {
  const db = tenantKysely<unknown>(INTEGRATION_DSN as string);
  const repo = new PostgresConfluencePageApprovalsRepo({ db });
  const pool = getPool(INTEGRATION_DSN as string);

  const cleanup = async (): Promise<void> => {
    await pool.query("DELETE FROM core.confluence_page_approvals WHERE space_key = $1", [TEST_SPACE]);
  };

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM core.confluence_page_approvals WHERE false");
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await disposeAllPools();
  });

  it("upsertApproval inserts a row with actor_email from the keyword arg (NOT the request body)", async () => {
    const id = await repo.upsertApproval(makeRequest("pg1"), { actorEmail: "operator@example.com" });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const r = await pool.query(
      "SELECT approval_id, approver_email, default_scope, revoked_at, revoked_by FROM core.confluence_page_approvals WHERE space_key = $1 AND page_id = 'pg1'",
      [TEST_SPACE],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].approval_id).toBe(id);
    expect(r.rows[0].approver_email).toBe("operator@example.com");
    expect(r.rows[0].default_scope).toBe("universal");
    // biconditional CHECK: active row → revoked_at IS NULL AND revoked_by IS NULL.
    expect(r.rows[0].revoked_at).toBeNull();
    expect(r.rows[0].revoked_by).toBeNull();
  });

  it("getActiveApproval returns the active row and returns null for an absent page", async () => {
    await repo.upsertApproval(makeRequest("pg2"), { actorEmail: "operator@example.com" });

    const active = await repo.getActiveApproval({ spaceKey: TEST_SPACE, pageId: "pg2" });
    expect(active).not.toBeNull();
    expect(active?.page_id).toBe("pg2");
    expect(active?.approver_email).toBe("operator@example.com");
    expect(active?.revoked_at).toBeNull();

    expect(await repo.getActiveApproval({ spaceKey: TEST_SPACE, pageId: "nope" })).toBeNull();
  });

  it("re-upsert revokes the prior active row (revoked_by = actor) then inserts a fresh active row", async () => {
    const first = await repo.upsertApproval(makeRequest("pg3"), { actorEmail: "alice@example.com" });
    const second = await repo.upsertApproval(makeRequest("pg3"), { actorEmail: "bob@example.com" });
    expect(second).not.toBe(first);

    // The prior row is revoked WITH revoked_by set (F-28 / biconditional CHECK).
    const firstRow = await pool.query(
      "SELECT revoked_at, revoked_by FROM core.confluence_page_approvals WHERE approval_id = $1",
      [first],
    );
    expect(firstRow.rows[0].revoked_at).not.toBeNull();
    expect(firstRow.rows[0].revoked_by).toBe("bob@example.com");

    // Exactly ONE active row remains (the partial-unique index is satisfied).
    const active = await pool.query(
      "SELECT approval_id FROM core.confluence_page_approvals WHERE space_key = $1 AND page_id = 'pg3' AND revoked_at IS NULL",
      [TEST_SPACE],
    );
    expect(active.rowCount).toBe(1);
    expect(active.rows[0].approval_id).toBe(second);

    // getActiveApproval returns the NEW active one, excluding the revoked one.
    const got = await repo.getActiveApproval({ spaceKey: TEST_SPACE, pageId: "pg3" });
    expect(got?.approval_id).toBe(second);
    expect(got?.approver_email).toBe("bob@example.com");
  });

  it("listForSpace returns active rows; includeRevoked also returns the revoked ones", async () => {
    await repo.upsertApproval(makeRequest("pg4"), { actorEmail: "operator@example.com" });
    await repo.upsertApproval(makeRequest("pg5"), { actorEmail: "operator@example.com" });
    // Revoke pg5 so it drops out of the active-only list.
    await repo.revoke({ spaceKey: TEST_SPACE, pageId: "pg5", revokedBy: "operator@example.com" });

    const activeOnly = await repo.listForSpace({ spaceKey: TEST_SPACE });
    expect(activeOnly.map((a) => a.page_id).sort()).toEqual(["pg4"]);

    const withRevoked = await repo.listForSpace({ spaceKey: TEST_SPACE, includeRevoked: true });
    expect(withRevoked.map((a) => a.page_id).sort()).toEqual(["pg4", "pg5"]);
  });

  it("revoke flips revoked_at + revoked_by and returns true; a no-op revoke returns false", async () => {
    await repo.upsertApproval(makeRequest("pg6"), { actorEmail: "operator@example.com" });

    const did = await repo.revoke({ spaceKey: TEST_SPACE, pageId: "pg6", revokedBy: "revoker@example.com" });
    expect(did).toBe(true);

    const r = await pool.query(
      "SELECT revoked_at, revoked_by FROM core.confluence_page_approvals WHERE space_key = $1 AND page_id = 'pg6'",
      [TEST_SPACE],
    );
    expect(r.rows[0].revoked_at).not.toBeNull();
    expect(r.rows[0].revoked_by).toBe("revoker@example.com");
    // Now there is no active row → getActiveApproval is null.
    expect(await repo.getActiveApproval({ spaceKey: TEST_SPACE, pageId: "pg6" })).toBeNull();

    // A second revoke (nothing active) is a no-op → false.
    expect(await repo.revoke({ spaceKey: TEST_SPACE, pageId: "pg6", revokedBy: "revoker@example.com" })).toBe(false);
  });
});
