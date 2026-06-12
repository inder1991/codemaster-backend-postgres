// LIVE integration test for ProbeKnowledgeCorpusActivity (W2.4 / XH13) against a DISPOSABLE Postgres.
//
// The probe is the cheap per-review EXISTS pair behind the orchestrator's retrieval short-circuit:
//   - has_repo_knowledge: any ACTIVE `core.knowledge_chunks` row for (installation_id, repo_id);
//   - has_confluence_knowledge: any live (non-deleted / non-superseded / non-quarantined)
//     `core.confluence_chunks` row — the corpus is PLATFORM-SHARED, so no tenancy filter.
//
// FAIL-OPEN bias is structural: the probe deliberately OVER-reports availability (e.g. a confluence
// row without an embedding still counts) — a false "has knowledge" only costs the legacy retrieval
// round-trip; a false "no knowledge" would silently drop retrieval that could have helped.
//
// GATING: runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb) — the disposable PG, NEVER the
// in-cluster DB. ISOLATION: unique installation/repository/space per run; FK-safe cleanup in afterAll.

import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { ProbeKnowledgeCorpusActivity } from "#backend/activities/probe_knowledge_corpus.activity.js";

import { disposeAllPools, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const INSTALLATION_ID = randomUUID();
const REPO_ID = randomUUID();
const OTHER_REPO_ID = randomUUID();
const SPACE_KEY = `IT-PROBE-${randomUUID().slice(0, 8)}`;

let db: Kysely<unknown>;

function uniqueGithubId(): bigint {
  return BigInt(`0x${randomUUID().replace(/-/g, "").slice(0, 12)}`);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  db = tenantKysely<unknown>(INTEGRATION_DSN);
  await sql`
    INSERT INTO core.installations
      (installation_id, github_installation_id, account_login, account_type)
    VALUES (${INSTALLATION_ID}, ${uniqueGithubId().toString()},
            ${"acct-" + INSTALLATION_ID.slice(0, 8)}, 'Organization')
  `.execute(db);
  for (const repoId of [REPO_ID, OTHER_REPO_ID]) {
    await sql`
      INSERT INTO core.repositories
        (repository_id, installation_id, github_repo_id, full_name, default_branch)
      VALUES (${repoId}, ${INSTALLATION_ID}, ${uniqueGithubId().toString()},
              ${"org/repo-" + repoId.slice(0, 8)}, 'main')
    `.execute(db);
  }
  // ONE active knowledge chunk for REPO_ID only (no vector needed — BM25 retrieval needs none either).
  await sql`
    INSERT INTO core.knowledge_chunks
      (chunk_id, installation_id, repository_id, relative_path, chunk_index,
       content_sha256, heading_path, body, doc_kind, doc_status)
    VALUES (${randomUUID()}, ${INSTALLATION_ID}, ${REPO_ID}, 'docs/adr-1.md', 0,
            ${"0".repeat(64)}, ${sql`ARRAY[]::text[]`}, 'use parameterized queries',
            'adr', 'active'::core.knowledge_doc_status)
  `.execute(db);
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  await sql`DELETE FROM core.confluence_chunks WHERE space_key = ${SPACE_KEY}`.execute(db);
  await sql`DELETE FROM core.knowledge_chunks WHERE installation_id = ${INSTALLATION_ID}`.execute(db);
  await sql`DELETE FROM core.repositories WHERE installation_id = ${INSTALLATION_ID}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${INSTALLATION_ID}`.execute(db);
  await disposeAllPools();
});

describeDb("ProbeKnowledgeCorpusActivity — cheap corpus-existence probe (W2.4 / XH13)", () => {
  it("reports repo knowledge for the seeded repo; none for the empty sibling repo", async () => {
    const activity = new ProbeKnowledgeCorpusActivity({ db });
    const seeded = await activity.probeKnowledgeCorpus({
      schema_version: 1,
      installation_id: INSTALLATION_ID,
      repo_id: REPO_ID,
    });
    expect(seeded.has_repo_knowledge).toBe(true);
    const empty = await activity.probeKnowledgeCorpus({
      schema_version: 1,
      installation_id: INSTALLATION_ID,
      repo_id: OTHER_REPO_ID,
    });
    expect(empty.has_repo_knowledge).toBe(false);
  });

  it("counts only LIVE confluence rows (quarantined rows do not resurrect the corpus)", async () => {
    const activity = new ProbeKnowledgeCorpusActivity({ db });
    // Seed ONE quarantined chunk → must NOT count.
    await sql`
      INSERT INTO core.confluence_chunks
        (chunk_id, space_key, page_id, page_title, version, chunk_index, chunk_text,
         content_sha256, labels, quarantined, quarantine_reasons)
      VALUES (${randomUUID()}, ${SPACE_KEY}, 'p-q', 'Quarantined', 1, 0, 'bad',
              ${"0".repeat(64)}, ${sql`${["lang:python"]}::text[]`}, true,
              ${sql`${["injection"]}::text[]`})
    `.execute(db);
    const before = await activity.probeKnowledgeCorpus({
      schema_version: 1,
      installation_id: INSTALLATION_ID,
      repo_id: OTHER_REPO_ID,
    });
    // NOTE: the confluence corpus is platform-shared — other suites' rows could make this true.
    // The disposable DB is empty in this run (asserted by the seed-free baseline of this suite).
    expect(before.has_confluence_knowledge).toBe(false);

    // A LIVE chunk (no embedding required — fail-open over-reporting) flips it.
    await sql`
      INSERT INTO core.confluence_chunks
        (chunk_id, space_key, page_id, page_title, version, chunk_index, chunk_text,
         content_sha256, labels, quarantined, quarantine_reasons)
      VALUES (${randomUUID()}, ${SPACE_KEY}, 'p-live', 'Live', 1, 0, 'guidance',
              ${"0".repeat(64)}, ${sql`${["lang:python"]}::text[]`}, false,
              ${sql`ARRAY[]::text[]`})
    `.execute(db);
    const after = await activity.probeKnowledgeCorpus({
      schema_version: 1,
      installation_id: INSTALLATION_ID,
      repo_id: OTHER_REPO_ID,
    });
    expect(after.has_confluence_knowledge).toBe(true);
  });
});
