export const meta = {
  name: 'phase26-embedder-semantic',
  description: 'DE-STUB the Qwen semantic-merge (aggregation_semantic embedder always undefined → merge never runs). Port the EmbeddingsPort + both real adapters (QwenEmbeddingsConsumer /embed for prod + OpenAICompatibleEmbeddingsAdapter /v1/embeddings for Ollama) + env selection, then grow the real aggregateSemantic merge branch (body-embed → same-file cosine ≥0.92 → higher-confidence absorbs) + thread the embedder through doAggregate. Tested: OpenAI-compat LIVE vs Ollama (real Qwen); QwenEmbeddingsConsumer recorded wire; merge-logic parity vs frozen Python with a deterministic embedder.',
  phases: [
    { title: 'Embedder', detail: 'EmbeddingsPort + EmbedRequest/EmbedResult + typed errors + RecordingEmbeddingsClient + QwenEmbeddingsConsumer (/embed) + OpenAICompatibleEmbeddingsAdapter (/v1/embeddings) + the CODEMASTER_EMBEDDINGS_PROVIDER env selection. LIVE Ollama test + recorded /embed wire test.' },
    { title: 'SemanticMerge', detail: 'grow the real aggregateSemantic branch (embed each finding .body; same-file cosine ≥ SEMANTIC_MERGE_THRESHOLD=0.92; higher-confidence absorbs; merged body=absorber+\\n---\\n+absorbed, max severity/confidence, title/file/lines follow absorber) + thread the embedder through aggregate_findings.activity doAggregate. Merge-logic parity vs frozen Python + a live-Ollama end-to-end merge.' },
    { title: 'Verify', detail: 'adversarial: merge-logic byte-parity vs frozen Python (deterministic embedder both sides); fail-open on embedder error; the OpenAI-compat adapter really embeds against Ollama (deterministic, dim noted); the QwenEmbeddingsConsumer /embed wire; doAggregate now threads the embedder (semanticMerged no longer always 0).' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const OLLAMA = 'http://localhost:11434'
const PORT_EMB = REPO + '/vendor/codemaster-py/codemaster/adapters/embeddings_port.py'
const QWEN = REPO + '/vendor/codemaster-py/codemaster/integrations/qwen/consumer.py'
const OAI = REPO + '/vendor/codemaster-py/codemaster/integrations/openai_compat/adapter.py'
const AGG = REPO + '/vendor/codemaster-py/codemaster/review/aggregation_semantic.py'
const AGGACT = REPO + '/vendor/codemaster-py/codemaster/review/aggregate_activity.py'
const MAIN = REPO + '/vendor/codemaster-py/codemaster/worker/main.py'

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
  'PRODUCTION CODE MUST BE REAL — NO stub/no-op on the shipped path. The embedder really embeds (HTTP). Test doubles (RecordingEmbeddingsClient, a recording transport) ONLY in test files. EmbedRequest/EmbedResult/EmbeddingsPort are ADAPTER-LOCAL types (Python __contract_internal__) — NOT #contracts schema-version models; put them in apps/backend.',
  'REUSE: the fetch-transport seam pattern from #backend/observability/langfuse_exporter.ts (FetchLangfuseHttpClient) / #backend/adapters/vault_http.ts — an injectable fetch-based HTTP client (production: global fetch; tests inject a recording/mock transport); timeout via #platform/transport_timeout.js (transportAbortSignal) to stay clock_random-clean. #contracts/review_findings.v1.js (ReviewFindingV1 — the merge operates on these; confidence is the bare-float field). #platform/clock.js. The existing #backend/review/aggregation_semantic.js (the skip-path to grow) + #backend/activities/aggregate_findings.activity.js (doAggregate, today calls aggregateSemantic(afterExact, undefined)).',
  'GATE: check_clock_random (no raw Date.now/Math.random/setTimeout — use the transport_timeout seam for HTTP timeouts). NO new deps (global fetch). No DB in this slice.',
  'LIVE OLLAMA: ' + OLLAMA + ' serves /v1/embeddings (OpenAI-compat). Model "qwen3-embedding" (4096-dim, DETERMINISTIC) — that is the REAL-Qwen live test target for the OpenAI-compat adapter. (Note: prod EMBEDDING_DIM=1024 for the platform model; the merge uses cosine which is dim-agnostic so 4096 is fine here — do NOT assert dim==1024 in the merge path; only embed_query/pgvector cares, which is the NEXT piece.)',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix; NO git add/commit; CLEAN UP scratch. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

phase('Embedder')

const P1 = [
  'Port the REAL embedder to TypeScript (de-stub step 1): the EmbeddingsPort + both production adapters + the env selection. NO stub on the shipped path.',
  STYLE,
  'READ FULLY: ' + PORT_EMB + ' (EmbedRequest{texts: 1..128, model_name, purpose}, EmbedResult{vectors, model_name, model_version, cache_hits=0}, EmbeddingsPort.embed, the typed errors EmbeddingsError/Connectivity/RateLimited/Validation, EMBEDDING_DIM=1024, RecordingEmbeddingsClient[per-text hash-seeded deterministic vector — port FAITHFULLY so the vectors match Python for the merge parity, OR document the exact hash so the verifier can reproduce]) and ' + QWEN + ' (QwenEmbeddingsConsumer.embed: POST {dsn}/embed, body=EmbedRequest dump {texts,model_name,purpose}, NO auth, timeout 10s, NO retry; status map 200→EmbedResult / bad-200→Connectivity / 429→RateLimited / 5xx→Connectivity / other-4xx→Validation / ConnectError·Timeout→Connectivity) and ' + OAI + ' (OpenAICompatibleEmbeddingsAdapter.embed: POST {base_url}/v1/embeddings, body {model: self._model_name [EmbedRequest.model_name IGNORED], input: texts}, headers Authorization: Bearer <api_key>; response {data:[{embedding:[...]}], model} → EmbedResult[model_version echoes response model, cache_hits=0]; same error taxonomy) and ' + MAIN + ':1836 _resolve_embeddings_consumer (CODEMASTER_EMBEDDINGS_PROVIDER ∈ {platform,openai_compat} default platform; platform→ CODEMASTER_QWEN_DSN [stub://recording→RecordingEmbeddingsClient] else QwenEmbeddingsConsumer; openai_compat→ CODEMASTER_EMBEDDER_BASE_URL/API_KEY/MODEL_NAME → OpenAICompatibleEmbeddingsAdapter; fail-loud RuntimeError on missing).',
  'PORT TO: ' + REPO + '/apps/backend/src/backend/adapters/embeddings_port.ts (EmbeddingsPort type + EmbedRequest/EmbedResult types + the typed errors + EMBEDDING_DIM + RecordingEmbeddingsClient) + ' + REPO + '/apps/backend/src/backend/integrations/qwen/consumer.ts (QwenEmbeddingsConsumer) + ' + REPO + '/apps/backend/src/backend/integrations/openai_compat/adapter.ts (OpenAICompatibleEmbeddingsAdapter) + ' + REPO + '/apps/backend/src/backend/adapters/resolve_embeddings.ts (resolveEmbeddingsConsumer env-selection). Both adapters take an injectable HTTP transport (default global fetch via a FetchEmbeddingsHttpClient; transport_timeout seam).',
  'TESTS: test/integration/embeddings/openai_compat_ollama.integration.test.ts — LIVE against ' + OLLAMA + ' (skip-if-unreachable guard): OpenAICompatibleEmbeddingsAdapter(base_url=' + OLLAMA + ', model_name="qwen3-embedding", api_key="x").embed(["hello"]) → a non-empty deterministic vector (assert vectors.length===1, vector length>0, same-input→same-vector). test/unit/embeddings/qwen_consumer.test.ts — recording transport: assert POST {dsn}/embed body {texts,model_name,purpose} + the status→error mapping. test/unit/embeddings/recording_client.test.ts — deterministic vectors.',
  'Return component="embedder", files_written, commands, all_green, notes: the EmbedRequest/Result shapes, the /embed vs /v1/embeddings wires (+ model_name-ignored), the env selection, the RecordingEmbeddingsClient hash (for the verifier), the live Ollama dim observed, the transport seam, divergence risk.',
].join('\n')

const p1 = await agent(P1, { label: 'port:embedder', phase: 'Embedder', schema: BUILD_SCHEMA })

phase('SemanticMerge')

const P2 = [
  'Grow the REAL aggregateSemantic merge branch + thread the embedder through doAggregate (de-stub step 2). Depends on part 1 (EmbeddingsPort).',
  STYLE,
  'Part-1 built: ' + JSON.stringify(p1).slice(0, 300),
  'READ FULLY: ' + AGG + ' (aggregate_semantic(findings, *, embedder, threshold=0.92, embedder_model="qwen3-embed-0.6b") -> (out, semantic_skipped): len<2→(findings,False); bodies=[f.body]; embedder.embed(EmbedRequest(texts=bodies, model_name=embedder_model, purpose="review_query")); any EmbeddingsError/Exception or vector-count-mismatch → (findings, True) [fail-open]; greedy walk input order, for surviving i scan j>i, SKIP if f_j.file != absorber.file, _cosine(vec_i, vec_j); if sim >= SEMANTIC_MERGE_THRESHOLD(0.92) merge: higher-confidence absorbs [if f_j.confidence > absorber.confidence → f_j absorbs + slot vector becomes f_j; else absorber absorbs f_j]; _merge: merged body=absorber.body + "\\n---\\n" + absorbed.body [dedup-guard], severity=max rank(blocker3>issue2>suggestion1>nit0), confidence=max, title/suggestion/category/file/lines follow ABSORBER; return (tuple(out), False)) and ' + AGGACT + ':77 _do_aggregate (the stage chain ...→aggregate_semantic→rank_and_cap; semantic_merged=len(after_exact)-len(after_semantic); semantic_skipped→DedupeStatsV1).',
  'PORT TO: grow ' + REPO + '/apps/backend/src/backend/review/aggregation_semantic.ts — change the signature to accept a REAL `embedder?: EmbeddingsPort` and implement the merge branch behind `if (embedder !== undefined)` (keep the skip-path as the no-embedder fallback). 1:1 with the Python (the cosine, the 0.92 threshold, the same-file guard, the higher-confidence-absorbs, the body join, max severity/confidence). Then EDIT ' + REPO + '/apps/backend/src/backend/activities/aggregate_findings.activity.ts::doAggregate to thread an injected embedder into aggregateSemantic (today it hardcodes undefined) — the AggregateFindingsActivity/doAggregate gains an `embedder?: EmbeddingsPort` collaborator (production injects the resolved one; tests inject a double).',
  'TESTS: test/parity/aggregate_semantic.parity.test.ts — drive BOTH the frozen Python aggregate_semantic and the TS aggregateSemantic with an embedder that returns DETERMINISTIC vectors (use the RecordingEmbeddingsClient on BOTH sides, OR inject EXPLICIT known vectors so cosine pairs are controlled — construct findings where two same-file bodies have cosine ≥0.92 and others <0.92, and a cross-file near-duplicate that must NOT merge); byte-compare the merged ReviewFindingV1 list (confidence is a bare float — strip+assert structurally per the established pattern) + the skipped flag. Cover: <2 findings (skip), embedder-error (fail-open True), a real merge (2→1 same-file), cross-file no-merge, higher-confidence-absorbs direction. Plus test/integration/review/semantic_merge_ollama.integration.test.ts — the real OpenAICompatibleEmbeddingsAdapter (LIVE Ollama) → aggregateSemantic over a couple findings (proves the real adapter→merge chain composes end-to-end; skip-if-Ollama-unreachable).',
  'Return component="semantic_merge", files_written, commands, all_green, notes: the cosine+threshold+greedy+absorb logic, the body join, the doAggregate threading (semanticMerged now non-zero), the parity-embedder approach, divergence risk.',
].join('\n')

const p2 = await agent(P2, { label: 'port:semantic-merge', phase: 'SemanticMerge', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL verifier for the embedder + semantic-merge de-stub. REFUTE that the TS aggregateSemantic merges identically to the frozen Python and that the embedder really embeds (no stub on the shipped path).',
  STYLE,
  'Built: ' + JSON.stringify({ p1: p1.component, p2: p2.component }).slice(0, 300),
  '1. MERGE PARITY: drive BOTH the frozen Python aggregate_semantic and the TS aggregateSemantic with the SAME deterministic embedder (RecordingEmbeddingsClient or explicit injected vectors) over the SAME findings; byte-compare the merged ReviewFindingV1 tuple (confidence stripped+structural) + the skipped flag. Cover <2, embedder-error fail-open, same-file merge (2→1), cross-file NO-merge, higher-confidence-absorbs, the \\n---\\n body join, max severity/confidence. ANY divergence = WEAK.',
  '2. EMBEDDER REAL (no stub): grep — the production aggregate path resolves a REAL adapter (QwenEmbeddingsConsumer or OpenAICompatibleEmbeddingsAdapter); RecordingEmbeddingsClient only in test files. The OpenAI-compat adapter LIVE against ' + OLLAMA + ' returns real deterministic vectors (skip-if-unreachable, note the dim). The QwenEmbeddingsConsumer POSTs the exact /embed body.',
  '3. doAggregate THREADING: aggregate_findings.activity now threads the embedder into aggregateSemantic (semanticMerged is no longer hardcoded 0 — a real merge reduces the count). With NO embedder injected it falls back to the skip-path (semantic_skipped) — faithful to the prior behavior.',
  '4. FAIL-OPEN: an embedder that raises EmbeddingsError → aggregateSemantic returns (findings unchanged, skipped=true) on BOTH sides; never throws into the aggregate pipeline.',
  'Run (cd ' + REPO + ' && npx vitest run <the new tests>) + check_clock_random; tsc clean (delete scratch first). verdict=WEAK if the merge diverges from Python, a stub remains on the production embed path, doAggregate does not thread the embedder, or fail-open differs; SOUND otherwise. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:embedder-semantic', phase: 'Verify', schema: VERIFY_SCHEMA })

return { p1, p2, verify }
