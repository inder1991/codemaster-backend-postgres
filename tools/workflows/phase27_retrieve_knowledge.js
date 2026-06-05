export const meta = {
  name: 'phase27-retrieve-knowledge',
  description: 'The last core-loop activity: retrieve_knowledge (default production path = embed_query + pgvector ANN + Postgres BM25 + RRF fusion). embed_query (1024 dim guard) + AnnRetriever + PostgresAnnPort (_sql_no_cache) + Bm25Retriever + PostgresBm25Port (ts_rank_cd) + rrf_combine + the RetrieveKnowledgeActivity legacy path + wiring. Tested REAL against the disposable PG + live Ollama mxbai-embed-large (1024-dim). The marker-gated HybridRetriever/Confluence + the no-op-everywhere LLM rerank are deferred-faithful.',
  phases: [
    { title: 'EmbedQueryAnn', detail: 'embed_query activity (purpose in_repo_doc, 1024 dim guard) + AnnPort + AnnRetriever (override-or-embed, degraded-empty fallback) + PostgresAnnPort (_sql_no_cache: vector text-bind, CAST AS vector, 1-distance, ORDER BY, installation_id+repository_id+doc_status filter) + InMemoryAnnPort. Live-Ollama+PG integration test.' },
    { title: 'Bm25RrfActivity', detail: 'Bm25Port + Bm25Retriever + PostgresBm25Port (ts_rank_cd over body_tsv, plainto_tsquery) + InMemoryBm25Port + rrf_combine (k=60) + the RetrieveKnowledgeActivity legacy path (gather bm25+ann over PRE_FUSION_TOP_K → rrf → top_k → items, degraded propagation) + build wiring. Full-path integration test.' },
    { title: 'Verify', detail: 'adversarial: the full legacy retrieve (embed → ANN+BM25 → RRF → RetrieveKnowledgeResultV1.items) byte-parity vs frozen Python over the SAME disposable PG + the SAME query vector; ANN _sql_no_cache + BM25 ts_rank SQL parity; RRF fusion; degraded fallback on embed error; embed_query 1024 dim guard.' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const PGDSN = 'postgresql://postgres:postgres@localhost:5434/codemaster'
const OLLAMA = 'http://localhost:11434'
const RET = REPO + '/vendor/codemaster-py/codemaster/retrieval'
const ACTS = REPO + '/vendor/codemaster-py/codemaster/activities'
const WIRE = REPO + '/vendor/codemaster-py/codemaster/wiring/retrievers.py'

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['component', 'files_written', 'commands', 'all_green', 'notes'],
  properties: {
    component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'passed'], properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } } } },
    all_green: { type: 'boolean' }, notes: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'checks', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['SOUND', 'WEAK', 'INCONCLUSIVE'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = [
  'WORKING DIR: ' + REPO + '. ABSOLUTE paths. Bash cwd RESETS — prefix EVERY command with (cd ' + REPO + ' && ...).',
  'TS STYLE: ESM .js specifiers; "type" not "interface"; Array<T>; NO any (unknown+narrow); named exports; explicit return types; import { type X }; no unused vars; snake_case FILENAMES; camelCase members.',
  'IMPORTS: #contracts/* , #platform/* , #backend/* ; same-dir relative ./x.js.',
  'PRODUCTION CODE MUST BE REAL — NO stub/no-op on the shipped path. The ANN/BM25 ports really query Postgres; the embedder really embeds. Test doubles (InMemoryAnnPort/InMemoryBm25Port, the recording embedder) ONLY in test files.',
  'REUSE (already REAL): #backend/adapters/embeddings_port.js (EmbeddingsPort + EmbedRequest/Result + errors + EMBEDDING_DIM=1024) + #backend/integrations/openai_compat/adapter.js (the Ollama path) + #backend/adapters/resolve_embeddings.js. #platform/db/database.js (tenantKysely/getPool — the shared pool; ports take an injected Kysely). #platform/clock.js. CONTRACTS DONE — reuse: #contracts/embed_query.v1.js (EmbedQueryInputV1/ResultV1), #contracts/retrieve_knowledge.v1.js (RetrieveKnowledgeInputV1/ResultV1), #contracts/knowledge_chunks.v1.js (KnowledgeChunkV1, KnowledgeQueryV1, ScoredKnowledgeChunkV1, RetrievedKnowledgeV1, RetrievalStage). grep retrieval/constants.py for PRE_FUSION_TOP_K + the RRF k.',
  'GATE: check_clock_random (Clock seam). check_tenant_scoped_raw_sql: core.knowledge_chunks IS tenant-scoped (installation_id NOT NULL) — every ANN/BM25 SQL filters installation_id=:iid AND repository_id=:rid (carry the token; the gate is satisfied). The DISPOSABLE PG is ' + PGDSN + ' — NEVER the in-cluster DB. core.knowledge_chunks + body_tsv + the vector extension ALREADY EXIST in the baseline (no migration); the seed has ZERO knowledge_chunks rows so tests seed their own. Integration tests SERIAL (--no-file-parallelism), UNIQUE installation_id/repository_id per test (randomUUID) for isolation.',
  'LIVE OLLAMA: ' + OLLAMA + ' /v1/embeddings, model "mxbai-embed-large" (1024-dim — matches knowledge_chunks.vector(1024) + the embed_query 1024 guard). Use the OpenAICompatibleEmbeddingsAdapter(base_url=' + OLLAMA + ', model_name="mxbai-embed-large", api_key="x") as the REAL embedder for integration tests (seed chunk bodies + embed the query with it).',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix; NO git add/commit; CLEAN UP scratch. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN=' + PGDSN + ' npx vitest run --no-file-parallelism <your test files>).',
].join('\n')

phase('EmbedQueryAnn')

const P1 = [
  'Port the REAL embed_query activity + the pgvector ANN retriever (de-stub-adjacent; retrieve_knowledge step 1). NO stub.',
  STYLE,
  'READ FULLY: ' + ACTS + '/embed_query.py (EmbedQueryActivity.embed_query: embed [query], purpose="in_repo_doc"; vector=result.vectors[0]; if len(vector)!=EMBEDDING_DIM(1024) → raise ValueError "embed_query: vector dim mismatch"; return EmbedQueryResultV1(vector)) and ' + RET + '/ann_retriever.py (AnnPort Protocol; AnnRetriever.retrieve: if query.query_vector_override → use it [skip embed]; else embeddings.embed(EmbedRequest(texts=[query.query], model_name, purpose="review_query")); on EmbeddingsConnectivityError/RateLimited → degraded-empty RetrievedKnowledgeV1(items=(), degraded=True, degradation_reason); wrap hits in ScoredKnowledgeChunkV1(chunk, score, stage="ann"); top_k is the only cut) and ' + RET + '/postgres_ann_port.py (the _sql_no_cache branch ONLY: vector bind "qvec" = "[" + ",".join(str(x)) + "]"; SQL `... (1 - (kc.vector <=> CAST(:qvec AS vector))) AS score FROM core.knowledge_chunks kc WHERE kc.installation_id=:iid AND kc.repository_id=:rid [AND kc.doc_status=\'active\' when not include_stale] ORDER BY kc.vector <=> CAST(:qvec AS vector) LIMIT :top_k`; the selected columns chunk_id/installation_id/repository_id/relative_path/chunk_index/heading_path/body/doc_kind/doc_status/score; _row_to_chunk_and_score → KnowledgeChunkV1. DEFER _sql_phase_a/_sql_phase_c (embedder_cache is None → never taken).',
  'PORT TO: ' + REPO + '/apps/backend/src/backend/activities/embed_query.activity.ts (EmbedQueryActivity + the 1024 dim guard) + ' + REPO + '/apps/backend/src/backend/retrieval/ann_port.ts (AnnPort type + PostgresAnnPort[_sql_no_cache, injected Kysely] + InMemoryAnnPort[unit-test double]) + ' + REPO + '/apps/backend/src/backend/retrieval/ann_retriever.ts (AnnRetriever).',
  'TEST: test/integration/retrieval/ann.integration.test.ts (disposable PG ' + PGDSN + ', serial, unique ids): seed ~5 knowledge_chunks rows for one (installation_id, repository_id) with doc_status=active + bodies embedded via the REAL OpenAICompatibleEmbeddingsAdapter(Ollama mxbai-embed-large) [insert the 1024-vec literal]; embed a query with the same adapter; PostgresAnnPort.search returns the top_k ordered by cosine similarity (the nearest body first); doc_status filter excludes a stale row. + test/unit/retrieval/ann_retriever.test.ts (InMemoryAnnPort: override-path skips embed; embed-error → degraded-empty; stage="ann"). + test/unit/activities/embed_query.test.ts (the 1024 guard: a wrong-dim vector → throws).',
  'Return component="embed_query_ann", files_written, commands, all_green, notes: the exact ANN _sql_no_cache SQL + the vector text-bind, the embed_query dim guard, the AnnRetriever override/degraded paths, the live-Ollama mxbai dim, divergence risk.',
].join('\n')

const p1 = await agent(P1, { label: 'port:embed+ann', phase: 'EmbedQueryAnn', schema: BUILD_SCHEMA })

phase('Bm25RrfActivity')

const P2 = [
  'Port the REAL BM25 + RRF + the RetrieveKnowledgeActivity legacy path (retrieve_knowledge step 2). Depends on part 1.',
  STYLE,
  'Part-1 built: ' + JSON.stringify(p1).slice(0, 300),
  'READ FULLY: ' + RET + '/postgres_bm25_port.py (PostgresBm25Port: `ts_rank_cd(kc.body_tsv, plainto_tsquery(\'english\', :query)) AS score FROM core.knowledge_chunks kc WHERE kc.installation_id=:iid AND kc.repository_id=:rid AND kc.doc_status=\'active\' AND kc.body_tsv @@ plainto_tsquery(\'english\', :query) ORDER BY score DESC LIMIT :top_k`; same column projection → KnowledgeChunkV1) and ' + RET + '/bm25_retriever.py (Bm25Retriever wraps with stage="bm25") and ' + RET + '/rrf_combiner.py (rrf_combine(lists, *, top_k, k=60): score = sum 1/(k+rank) over each list, rank 1-based; dedup by chunk_id; degraded propagates if any input degraded; returns the fused top_k) and ' + ACTS + '/retrieve_knowledge.py (the LEGACY path: asyncio.gather(bm25.retrieve, ann.retrieve) over PRE_FUSION_TOP_K → rrf_combine(..., top_k=input.top_k) → RetrieveKnowledgeResultV1(items=tuple of the bare KnowledgeChunkV1, retrieval_degraded, degradation_reason); NO rerank on the legacy path; the query_vector_override is threaded into the AnnRetriever query) and ' + WIRE + ' (build_retrieve_knowledge_activity — the legacy wiring: build_bm25_port + build_ann_port(embedder_cache=None) + AnnRetriever(embeddings) + the activity). DEFER the hybrid/_should_use_hybrid branch + HybridRetriever + Confluence + rerank (marker-gated off by default — note it).',
  'PORT TO: ' + REPO + '/apps/backend/src/backend/retrieval/bm25_port.ts (Bm25Port + PostgresBm25Port + InMemoryBm25Port) + ' + REPO + '/apps/backend/src/backend/retrieval/bm25_retriever.ts + ' + REPO + '/apps/backend/src/backend/retrieval/rrf.ts (rrfCombine) + ' + REPO + '/apps/backend/src/backend/activities/retrieve_knowledge.activity.ts (the legacy RetrieveKnowledgeActivity) + ' + REPO + '/apps/backend/src/backend/wiring/retrievers.ts (buildRetrieveKnowledgeActivity — legacy wiring; embedderCache=undefined). Add a header note that the hybrid/Confluence path + the real LLM rerank are DEFERRED (marker-gated off; FOLLOW-UP-retrieve-knowledge-hybrid-confluence + FOLLOW-UP-retrieve-knowledge-llm-rerank), faithful to the Python default.',
  'TEST: test/integration/retrieval/retrieve_knowledge.activity.integration.test.ts (disposable PG, serial, unique ids, real Ollama mxbai): seed knowledge_chunks (some lexically-matching the query for BM25, some semantically-near for ANN); run the legacy RetrieveKnowledgeActivity → RetrieveKnowledgeResultV1.items fused via RRF; a chunk that ranks in BOTH BM25 and ANN floats to the top (RRF). + test/unit/retrieval/rrf.test.ts (the RRF math: 1/(k+rank), dedup, degraded propagation). + a degraded case (embed unreachable → ANN degraded-empty → BM25-only result, retrieval_degraded=true).',
  'Return component="bm25_rrf_activity", files_written, commands, all_green, notes: the BM25 ts_rank SQL, the RRF k + math, the legacy activity fusion + degraded propagation, the deferred-hybrid note, divergence risk.',
].join('\n')

const p2 = await agent(P2, { label: 'port:bm25+rrf+activity', phase: 'Bm25RrfActivity', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL Tier-1 verifier for retrieve_knowledge (the legacy default path). REFUTE that the TS retrieve (embed → ANN+BM25 → RRF → items) matches the frozen Python over the SAME disposable PG + the SAME query.',
  STYLE,
  'Built: ' + JSON.stringify({ p1: p1.component, p2: p2.component }).slice(0, 300),
  '1. ANN PARITY (disposable PG ' + PGDSN + ' + live Ollama mxbai): seed N knowledge_chunks (real mxbai 1024-vecs). Drive BOTH the frozen Python PostgresAnnPort and the TS PostgresAnnPort with the SAME query vector (a fixed override) over the SAME rows → identical ordered chunk_ids + scores (the 1 - cosine). The _sql_no_cache SQL + the [..] vector text-bind match.',
  '2. BM25 PARITY: the SAME query string → frozen Python PostgresBm25Port vs TS → identical ts_rank_cd ordering + the doc_status/@@-filter.',
  '3. RRF FUSION: rrf_combine(bm25, ann, top_k, k=60) — the TS rrfCombine fuses identically to the Python (same 1/(k+rank), same dedup-by-chunk_id, same fused order). A chunk in both lists ranks above singletons.',
  '4. FULL ACTIVITY: the legacy RetrieveKnowledgeActivity end-to-end (embed via Ollama OR a fixed override → ANN+BM25 → RRF → RetrieveKnowledgeResultV1.items) byte-equal to the frozen Python activity over the SAME PG + query.',
  '5. DEGRADED + DIM GUARD: embed-unreachable → ANN degraded-empty → BM25-only + retrieval_degraded=true on both sides; embed_query with a wrong-dim vector → raises on both sides.',
  'Run (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN=' + PGDSN + ' npx vitest run --no-file-parallelism <the new tests>) + check_clock_random; tsc clean. verdict=WEAK if the ANN/BM25 SQL, the RRF fusion, the activity items, or the degraded/dim behavior diverges from Python; SOUND otherwise. Give the exact diverging query/row/field. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:retrieve', phase: 'Verify', schema: VERIFY_SCHEMA })

return { p1, p2, verify }
