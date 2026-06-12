// W2.7 / EH9 — admin-read keyset PUSHDOWN tests. The three fetch-all-then-slice reads
// (listLearningsPage / listProposalsPage / listIntegrationsPage) must push the keyset predicate,
// the ORDER BY, and `LIMIT size+1` into SQL (the listFindings/listPullRequests idiom) instead of
// loading the whole table into Node and slicing in memory. These tests pin the compiled SQL shape
// via a recording fake driver, plus the cursor contract: the next_cursor `ts` carries the RAW
// Postgres microsecond-precision text (EM7 class: a millisecond-truncated cursor silently skips
// rows at page seams).

import { describe, expect, it } from "vitest";

import { decodeTsIdCursor, encodeTsIdCursor } from "#backend/api/admin/_keyset_cursor.js";
import {
  listIntegrationsPage,
  listLearningsPage,
  listProposalsPage,
} from "#backend/api/admin/admin_read_repo.js";

import { recordingKysely } from "./_recording_kysely.js";

const INST = "3a3a3a3a-1111-2222-3333-444444444444";

// ── row fixtures (superset of the columns either implementation reads) ───────────────────────────

function learningRow(id: string, lastFired: Date | null, cursorTs: string | null) {
  return {
    learning_id: id,
    title: "t",
    body_markdown: "b",
    version: 1,
    repo: null,
    state: "active",
    fired_count: 1,
    accepted_count: 1,
    feedback_count: 2,
    last_fired_at: lastFired,
    cursor_ts: cursorTs,
  };
}

function proposalRow(id: string, createdAt: Date, cursorTs: string) {
  return {
    proposal_id: id,
    title: "t",
    body_markdown: "b",
    repo: null,
    proposed_by_user_id: "00000000-0000-0000-0000-0000000000aa",
    created_at: createdAt,
    cursor_ts: cursorTs,
  };
}

function integrationRow(id: string, createdAt: Date, cursorTs: string) {
  return {
    integration_id: id,
    kind: "confluence_space",
    config_json: "{}",
    enabled: true,
    last_validated_at: null,
    last_validation_error: null,
    created_at: createdAt,
    updated_at: createdAt,
    trust_tier: "semi",
    default_governance_ack_at: null,
    visibility: "default_on",
    strict_label_mode: false,
    cursor_ts: cursorTs,
  };
}

const T1 = new Date("2026-06-07T12:00:01.000Z");
const T2 = new Date("2026-06-07T12:00:02.000Z");
const RAW1 = "2026-06-07 12:00:01.123456+00";
const RAW2 = "2026-06-07 12:00:02.654321+00";

describe("W2.7/EH9 listLearningsPage pushdown", () => {
  it("pushes LIMIT size+1 + (last_fired_at DESC NULLS LAST, learning_id DESC) ORDER BY into SQL", async () => {
    const { db, queries } = recordingKysely([
      [learningRow("3c000002-1111-2222-3333-444444444444", T2, RAW2)],
    ]);
    await listLearningsPage(db, INST, null, 2);
    expect(queries).toHaveLength(1);
    const q = queries[0]!;
    expect(q.sql).toMatch(/limit/i);
    expect(q.parameters).toContain(3); // size+1 over-fetch for has-more
    expect(q.sql).toMatch(/order by\s+l\.last_fired_at desc nulls last\s*,\s*l\.learning_id desc/i);
    expect(q.sql).toMatch(/installation_id/i); // tenancy filter preserved
    expect(q.parameters).toContain(INST);
  });

  it("pushes the cursor predicate into SQL (non-null ts: < ts OR (= ts AND id <) OR IS NULL)", async () => {
    const { db, queries } = recordingKysely([[]]);
    const cursor = encodeTsIdCursor(RAW2, "3c000002-1111-2222-3333-444444444444");
    await listLearningsPage(db, INST, cursor, 2);
    const q = queries[0]!;
    expect(q.sql).toMatch(/last_fired_at\s*</i);
    expect(q.sql).toMatch(/last_fired_at is null/i);
    expect(q.parameters).toContain(RAW2);
    expect(q.parameters).toContain("3c000002-1111-2222-3333-444444444444");
  });

  it("null-ts cursor (the NULLS LAST tail) → IS NULL AND id < :id predicate", async () => {
    const { db, queries } = recordingKysely([[]]);
    const cursor = encodeTsIdCursor("", "3c000003-1111-2222-3333-444444444444");
    await listLearningsPage(db, INST, cursor, 2);
    const q = queries[0]!;
    expect(q.sql).toMatch(/last_fired_at is null and l\.learning_id </i);
    expect(q.parameters).toContain("3c000003-1111-2222-3333-444444444444");
  });

  it("next_cursor carries the RAW microsecond cursor_ts, has-more via the size+1 over-fetch", async () => {
    const rows = [
      learningRow("3c000002-1111-2222-3333-444444444444", T2, RAW2),
      learningRow("3c000001-1111-2222-3333-444444444444", T1, RAW1),
      learningRow("3c000000-1111-2222-3333-444444444444", T1, RAW1),
    ];
    const { db } = recordingKysely([rows]);
    const page = await listLearningsPage(db, INST, null, 2);
    expect(page.rows.map((r) => r.learning_id)).toEqual([
      "3c000002-1111-2222-3333-444444444444",
      "3c000001-1111-2222-3333-444444444444",
    ]);
    expect(page.nextCursor).not.toBeNull();
    const decoded = decodeTsIdCursor(page.nextCursor!);
    expect(decoded.ts).toBe(RAW1); // raw µs text, NOT the ms-truncated ISO
    expect(decoded.id).toBe("3c000001-1111-2222-3333-444444444444");
  });

  it("page that exhausts the result set → null next_cursor", async () => {
    const { db } = recordingKysely([[learningRow("3c000001-1111-2222-3333-444444444444", T1, RAW1)]]);
    const page = await listLearningsPage(db, INST, null, 2);
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("null last_fired_at rows encode the empty-string cursor ts (NULLS LAST contract)", async () => {
    const rows = [
      learningRow("3c000002-1111-2222-3333-444444444444", null, null),
      learningRow("3c000001-1111-2222-3333-444444444444", null, null),
    ];
    const { db } = recordingKysely([rows]);
    const page = await listLearningsPage(db, INST, null, 1);
    expect(decodeTsIdCursor(page.nextCursor!).ts).toBe("");
  });
});

describe("W2.7/EH9 listProposalsPage pushdown", () => {
  it("pushes LIMIT size+1 + (created_at DESC, proposal_id DESC) ORDER BY + tenancy into SQL", async () => {
    const { db, queries } = recordingKysely([
      [proposalRow("3e000002-1111-2222-3333-444444444444", T2, RAW2)],
    ]);
    await listProposalsPage(db, INST, null, 2);
    const q = queries[0]!;
    expect(q.sql).toMatch(/limit/i);
    expect(q.parameters).toContain(3);
    expect(q.sql).toMatch(/order by\s+p\.created_at desc\s*,\s*p\.proposal_id desc/i);
    expect(q.sql).toMatch(/installation_id/i);
    expect(q.parameters).toContain(INST);
  });

  it("pushes the (created_at, proposal_id) tuple cursor predicate into SQL", async () => {
    const { db, queries } = recordingKysely([[]]);
    const cursor = encodeTsIdCursor(RAW2, "3e000002-1111-2222-3333-444444444444");
    await listProposalsPage(db, INST, cursor, 2);
    const q = queries[0]!;
    expect(q.sql).toMatch(/\(p\.created_at,\s*p\.proposal_id\)\s*</i);
    expect(q.parameters).toContain(RAW2);
    expect(q.parameters).toContain("3e000002-1111-2222-3333-444444444444");
  });

  it("next_cursor carries the RAW microsecond cursor_ts", async () => {
    const rows = [
      proposalRow("3e000002-1111-2222-3333-444444444444", T2, RAW2),
      proposalRow("3e000001-1111-2222-3333-444444444444", T1, RAW1),
    ];
    const { db } = recordingKysely([rows]);
    const page = await listProposalsPage(db, INST, null, 1);
    expect(page.rows.map((r) => r.proposal_id)).toEqual(["3e000002-1111-2222-3333-444444444444"]);
    expect(decodeTsIdCursor(page.nextCursor!).ts).toBe(RAW2);
  });
});

describe("W2.7/EH9 listIntegrationsPage pushdown", () => {
  it("pushes LIMIT size+1 + (created_at DESC, integration_id DESC) ORDER BY into SQL", async () => {
    const { db, queries } = recordingKysely([
      [integrationRow("3f000002-1111-2222-3333-444444444444", T2, RAW2)],
    ]);
    await listIntegrationsPage(db, null, 2);
    const q = queries[0]!;
    expect(q.sql).toMatch(/limit/i);
    expect(q.parameters).toContain(3);
    expect(q.sql).toMatch(/order by\s+created_at desc\s*,\s*integration_id desc/i);
  });

  it("pushes the tuple cursor predicate into SQL", async () => {
    const { db, queries } = recordingKysely([[]]);
    const cursor = encodeTsIdCursor(RAW2, "3f000002-1111-2222-3333-444444444444");
    await listIntegrationsPage(db, cursor, 2);
    const q = queries[0]!;
    expect(q.sql).toMatch(/\(created_at,\s*integration_id\)\s*</i);
    expect(q.parameters).toContain(RAW2);
  });

  it("next_cursor carries the RAW microsecond cursor_ts", async () => {
    const rows = [
      integrationRow("3f000002-1111-2222-3333-444444444444", T2, RAW2),
      integrationRow("3f000001-1111-2222-3333-444444444444", T1, RAW1),
    ];
    const { db } = recordingKysely([rows]);
    const page = await listIntegrationsPage(db, null, 1);
    expect(page.rows.map((r) => r.integration_id)).toEqual(["3f000002-1111-2222-3333-444444444444"]);
    expect(decodeTsIdCursor(page.nextCursor!).ts).toBe(RAW2);
  });
});
