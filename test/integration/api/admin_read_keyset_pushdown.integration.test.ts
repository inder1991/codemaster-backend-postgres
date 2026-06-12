// W2.7 / EH9 — end-to-end keyset-pushdown correctness for the three converted admin list reads
// against the DISPOSABLE Postgres. Pins the microsecond page-seam contract (EM7 class): rows whose
// timestamps differ only at MICROSECOND precision must order and paginate correctly. The legacy
// in-memory slice compared millisecond-truncated ISO strings, so same-millisecond rows fell back to
// id order — a silent mis-order the SQL pushdown fixes. Also re-pins tenancy + NULLS LAST + the
// cursor walk now that the predicate/LIMIT live in SQL.

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  listIntegrationsPage,
  listLearningsPage,
  listProposalsPage,
} from "#backend/api/admin/admin_read_repo.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const INST = "4a3a3a3a-1111-2222-3333-444444444444";
const INST_OTHER = "4b3b3b3b-1111-2222-3333-444444444444";
const U1 = "4d3d3d3d-1111-2222-3333-444444444444";

// Same-millisecond, different-microsecond pairs. Under a correct timestamptz DESC sort the HIGHER
// microsecond value comes first; ids are chosen so that an id-DESC tiebreak (the legacy truncated
// compare) would return the OPPOSITE order.
const L_HI = "4c000001-1111-2222-3333-444444444444"; // .123999 — true order: first
const L_LO = "4c000002-1111-2222-3333-444444444444"; // .123456 — true order: second
const L_NULL = "4c000003-1111-2222-3333-444444444444"; // null last_fired_at — sorts last
const L_OTHER = "4c000004-1111-2222-3333-444444444444";
const P_HI = "4e000001-1111-2222-3333-444444444444";
const P_LO = "4e000002-1111-2222-3333-444444444444";
const I_HI = "4f000001-1111-2222-3333-444444444444";
const I_LO = "4f000002-1111-2222-3333-444444444444";

const TS_HI = "2031-01-01T12:00:00.123999Z";
const TS_LO = "2031-01-01T12:00:00.123456Z";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.learnings WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
  await sql`DELETE FROM core.learning_proposals WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
  await sql`DELETE FROM core.integrations WHERE integration_id IN (${I_HI}, ${I_LO})`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  for (const [inst, gh] of [
    [INST, 980000110],
    [INST_OTHER, 980000120],
  ] as const) {
    await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
              VALUES (${inst}, ${gh}, ${"itest-push-" + String(gh)}, 'Organization')
              ON CONFLICT (installation_id) DO NOTHING`.execute(db);
  }
  for (const [id, inst, fired] of [
    [L_HI, INST, TS_HI],
    [L_LO, INST, TS_LO],
    [L_NULL, INST, null],
    [L_OTHER, INST_OTHER, TS_HI],
  ] as const) {
    await sql`INSERT INTO core.learnings
                (learning_id, installation_id, title, body_markdown, accepted_count, feedback_count, fired_count, last_fired_at)
              VALUES (${id}, ${inst}, 'L', 'body', 0, 0, 0, ${fired})`.execute(db);
  }
  for (const [id, ts] of [
    [P_HI, TS_HI],
    [P_LO, TS_LO],
  ] as const) {
    await sql`INSERT INTO core.learning_proposals
                (proposal_id, installation_id, repo_id, title, body, proposed_by_user_id, state, created_at)
              VALUES (${id}, ${INST}, NULL, 'P', 'body', ${U1}, 'pending_approval', ${ts})`.execute(db);
  }
  for (const [id, ts, spaceKey] of [
    [I_HI, TS_HI, "PUSHHI"],
    [I_LO, TS_LO, "PUSHLO"],
  ] as const) {
    await sql`INSERT INTO core.integrations (integration_id, kind, config_json, trust_tier, created_at, updated_at)
              VALUES (${id}, 'confluence_space', CAST(${JSON.stringify({ space_key: spaceKey })} AS jsonb),
                      'semi', ${ts}, ${ts})`.execute(db);
  }
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

describeDb("W2.7/EH9 admin-read keyset pushdown (disposable PG)", () => {
  it("learnings: same-millisecond rows order by TRUE microsecond DESC; NULL last_fired_at last; tenancy preserved", async () => {
    const { rows } = await listLearningsPage(db, INST, null, 50);
    expect(rows.map((r) => r.learning_id)).toEqual([L_HI, L_LO, L_NULL]);
    expect(rows.find((r) => r.learning_id === L_OTHER)).toBeUndefined();
  });

  it("learnings: a size-1 cursor walk visits every row exactly once across the microsecond seam", async () => {
    const seen: Array<string> = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await listLearningsPage(db, INST, cursor, 1);
      seen.push(...page.rows.map((r) => r.learning_id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([L_HI, L_LO, L_NULL]);
  });

  it("proposals: microsecond DESC order + size-1 cursor walk without skip or duplicate", async () => {
    const all = await listProposalsPage(db, INST, null, 50);
    expect(all.rows.map((r) => r.proposal_id)).toEqual([P_HI, P_LO]);

    const page1 = await listProposalsPage(db, INST, null, 1);
    expect(page1.rows.map((r) => r.proposal_id)).toEqual([P_HI]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listProposalsPage(db, INST, page1.nextCursor, 1);
    expect(page2.rows.map((r) => r.proposal_id)).toEqual([P_LO]);
    expect(page2.nextCursor).toBeNull();
  });

  it("integrations: microsecond DESC order + cursor walk (platform-shared, future-dated rows page first)", async () => {
    const page1 = await listIntegrationsPage(db, null, 1);
    expect(page1.rows.map((r) => r.integration_id)).toEqual([I_HI]);
    const page2 = await listIntegrationsPage(db, page1.nextCursor, 1);
    expect(page2.rows.map((r) => r.integration_id)).toEqual([I_LO]);
  });
});
