// ProbeKnowledgeCorpusActivity — W2.4 (XH13) retrieval short-circuit probe.
//
// NEW activity introduced DURING the hardening waves (no frozen-Python counterpart — the Python ran
// the full per-chunk hybrid retrieval unconditionally; XH13). ONE cheap EXISTS pair per review,
// dispatched by the orchestrator BEFORE the chunk fan-out and memoized on the review state, so a
// 30–50-chunk PR against a knowledge-less repo no longer pays N embed RPCs + N hybrid retrievals
// (3+ DB queries each) for provably-empty results.
//
// FAIL-OPEN posture (load-bearing — the W2.4 contract is "a short-circuit must never drop a
// retrieval that WOULD have helped"):
//   - The probe OVER-reports availability: the confluence side counts any live row even when its
//     `embedding` is NULL (Phase-A/C reads may serve vectors from `core.chunk_embeddings`), and the
//     repo side requires only `doc_status='active'` (BM25 needs no vector). A false "has knowledge"
//     costs one legacy retrieval round-trip; a false "no knowledge" would silently drop retrieval.
//   - The orchestrator wraps the dispatch in a logger-only `stageOutcome`: a probe FAILURE means "no
//     short-circuit" (retrieval proceeds), never a degradation note — nothing was lost.
//
// ── Tenancy ──
// `core.knowledge_chunks` is tenant-scoped: the EXISTS filters `installation_id = :iid AND
// repository_id = :rid` (the `installation_id` token satisfies the raw-SQL tenancy gate).
// `core.confluence_chunks` is PLATFORM-SHARED (migration 0063 dropped `installation_id`) — the probe
// applies NO tenancy filter there, exactly like `PostgresConfluenceRetrieval` (same `tenant:exempt`
// posture + marker).

import { type Kysely, sql } from "kysely";

import { tenantKysely } from "#platform/db/database.js";

import type {
  KnowledgeCorpusProbeInputV1,
  KnowledgeCorpusProbeResultV1,
} from "#contracts/knowledge_corpus_probe.v1.js";

/** One EXISTS row (pg returns the alias lowercased). */
type ExistsRow = { has: boolean };

export class ProbeKnowledgeCorpusActivity {
  private readonly db: Kysely<unknown>;

  public constructor({ db }: { db: Kysely<unknown> }) {
    this.db = db;
  }

  /** Build over the shared ADR-0062 pool from a DSN (the composition-root convenience). */
  public static fromDsn(dsn: string): ProbeKnowledgeCorpusActivity {
    return new ProbeKnowledgeCorpusActivity({ db: tenantKysely<unknown>(dsn) });
  }

  /**
   * The two corpus-existence answers, computed in parallel (both are index-friendly EXISTS probes).
   * Read-only and idempotent — safe under any retry policy.
   */
  public probeKnowledgeCorpus = async (
    input: KnowledgeCorpusProbeInputV1,
  ): Promise<KnowledgeCorpusProbeResultV1> => {
    const repoProbe = sql<ExistsRow>`
      SELECT EXISTS(
        SELECT 1
          FROM core.knowledge_chunks
         WHERE installation_id = ${input.installation_id}::uuid
           AND repository_id = ${input.repo_id}::uuid
           AND doc_status = 'active'
      ) AS has
    `.execute(this.db);
    // tenant:exempt reason=platform-shared-confluence-corpus-no-installation_id follow_up=PERMANENT-EXEMPTION-confluence-platform-shared
    const confluenceProbe = sql<ExistsRow>`
      SELECT EXISTS(
        SELECT 1
          FROM core.confluence_chunks AS cc
         WHERE cc.superseded_at IS NULL
           AND cc.deleted_at IS NULL
           AND cc.quarantined = false
      ) AS has
    `.execute(this.db);
    const [repoResult, confluenceResult] = await Promise.all([repoProbe, confluenceProbe]);
    return {
      schema_version: 1,
      has_repo_knowledge: repoResult.rows[0]?.has === true,
      has_confluence_knowledge: confluenceResult.rows[0]?.has === true,
    };
  };
}
