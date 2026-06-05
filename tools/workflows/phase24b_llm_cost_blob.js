export const meta = {
  name: 'phase24b-llm-cost-blob',
  description: 'DE-STUB LLM part 2: replace the faking AllowAllCostCap + discard-InMemoryBlobStore defaults with the REAL production impls (1:1 with frozen Python, which wires these always-on). PostgresCostCapEnforcer (telemetry.cost_daily reservation) + BlobStorePostgresAdapter (telemetry.llm_payloads) + the llm_calls telemetry write + wire them into LlmClientCache so forRole builds a fully-real LlmClient + move cassette_sdk→test/. Langfuse/OTel stay faithfully-off (env-gated in Python). Tested against the disposable PG.',
  phases: [
    { title: 'CostCap', detail: 'PostgresCostCapEnforcer: telemetry.cost_daily INSERT-ON-CONFLICT + SELECT FOR UPDATE reservation, lock_timeout=2s → CostCapLockTimeoutError, per_org + global caps, check_or_raise + record_call_cost (diff). Disposable-PG integration test.' },
    { title: 'BlobTelemetry', detail: 'BlobStorePostgresAdapter (telemetry.llm_payloads, zstd via node:zlib, 50MiB cap, put/get/delete) + the llm_calls telemetry write in LlmClient + wire the REAL archive PII-redactor. Integration tests.' },
    { title: 'WireAndMove', detail: 'wire PostgresCostCapEnforcer + BlobStorePostgresAdapter into the LlmClientCache client_factory so forRole builds a fully-REAL LlmClient; make the client.ts AllowAll/InMemory defaults test-only (or remove); move cassette_sdk.ts → test/ + fix its one importer; document Langfuse/OTel as faithfully-off (not stubbed).' },
    { title: 'Verify', detail: 'adversarial: the real LlmClient path against the disposable PG — cost-cap reserves a cost_daily row + denies over-cap; blob archives a real llm_payloads row (round-trips); a llm_calls telemetry row is written; SQL parity vs frozen Python; NO faking stub remains on the production LLM path.' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const PGDSN = 'postgresql://postgres:postgres@localhost:5434/codemaster'
const COST = REPO + '/vendor/codemaster-py/codemaster/cost/postgres_enforcer.py'
const BLOB = REPO + '/vendor/codemaster-py/codemaster/adapters/blobstore_postgres.py'
const CLIENT = REPO + '/vendor/codemaster-py/codemaster/integrations/llm/client.py'

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
  'PRODUCTION CODE MUST BE REAL — NO stubs/mocks/no-ops on the shipped path. Test doubles ONLY in test files. The frozen Python wires PostgresCostCapEnforcer + BlobStorePostgresAdapter ALWAYS-ON in production — match that (no AllowAll/discard defaults on the real path).',
  'REUSE (already REAL): #platform/db/database.js (tenantKysely/getPool — the real Kysely pool). #backend/redact/* (the ported PII redactor — the LlmClient archive redaction reuses it). #backend/integrations/llm/client.js (LlmClient — wire cost-cap+blob+telemetry into it) + client_cache.js (the client_factory — inject the real collaborators) from part 1. #platform/clock.js. node:zlib has zstd (zstdCompressSync/zstdDecompressSync on Node 22+ — this repo is Node 25; NO new dep for compression). #contracts/* for BlobRef (grep — blob_ref.v1.ts was ported in bedrock sub-part 3).',
  'GATE: check_clock_random (Clock seam, no raw Date/Math.random). check_tenant_scoped_raw_sql: telemetry.{cost_daily,llm_calls,llm_payloads} carry installation_id / scope_id — grep whether they are in TENANT_SCOPED_TABLES; follow the same idiom the part-1 settings repo + the existing repos use (installation_id token in the SQL, OR the platform-config tenant:exempt marker — mirror the Python). The DISPOSABLE PG is ' + PGDSN + ' — NEVER the in-cluster DB. The tables ALREADY EXIST (cost_daily/llm_calls/llm_payloads) — NO migration needed; verify columns by introspection.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit; integration tests run SERIALLY (the suite already sets --no-file-parallelism); CLEAN UP scratch. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN=' + PGDSN + ' npx vitest run --no-file-parallelism <your test files>).',
].join('\n')

phase('CostCap')

const P1 = [
  'Port the REAL PostgresCostCapEnforcer to TypeScript (de-stub LLM part 2, step 1). This is the PRODUCTION cost-cap (the frozen worker wires it; InMemoryCostCapEnforcer is Python\'s unit-test double). NO stub.',
  STYLE,
  'READ FULLY: ' + COST + ' (the production enforcer). The CostCapEnforcer interface (check_or_raise / record_call_cost). The reservation mechanism: open txn with SET LOCAL lock_timeout=\'2s\' (SQLSTATE 55P03 → CostCapLockTimeoutError); idempotent row creation INSERT INTO telemetry.cost_daily ... ON CONFLICT DO NOTHING for the global row (scope=\'global\', scope_id=zero-uuid) + the per_org row (scope=\'per_org\', scope_id=installation_id; SKIP for zero-uuid platform calls); cap refresh (read_caps_from_db from core.cost_cap_overrides + core.cost_cap_settings, else constructor fallback); SELECT ... FOR UPDATE on both rows; budget validation → BedrockBudgetExceededError when over cap; atomic reservation UPDATE daily_total_cents += estimated_cents; record_call_cost applies the diff (cost_cents - estimated_cents) under the same row lock (refund when actual<estimated). The zero-uuid sentinel + the skip-per-org-for-platform branch.',
  'PORT TO: ' + REPO + '/apps/backend/src/backend/cost/postgres_enforcer.ts — PostgresCostCapEnforcer(sessionFactory/kysely, clock, readCapsFromDb=true) implementing the SAME CostCapEnforcer interface as the existing #backend/cost/enforcer.js InMemoryCostCapEnforcer (so it is a drop-in). Mirror the SQL verbatim via Kysely sql``. Errors: reuse/extend the existing BedrockBudgetExceededError + add CostCapLockTimeoutError.',
  'TEST: test/integration/cost/postgres_enforcer.integration.test.ts (disposable PG, serial): a reservation creates+increments cost_daily; an over-cap reservation raises BedrockBudgetExceededError; record_call_cost applies the diff (over-estimate refund, under-estimate top-up); the lock_timeout path (a concurrent FOR UPDATE → CostCapLockTimeoutError) if feasible. Clean its own rows (scope-keyed). Skip-if-PG-unreachable.',
  'Return component="cost_cap_postgres", files_written, commands, all_green, notes: the exact reservation SQL, the zero-uuid/per-org branch, the cap-refresh source, the lock-timeout mapping, the tenancy idiom for telemetry.cost_daily, divergence risk.',
].join('\n')

const p1 = await agent(P1, { label: 'port:cost-cap', phase: 'CostCap', schema: BUILD_SCHEMA })

phase('BlobTelemetry')

const P2 = [
  'Port the REAL BlobStorePostgresAdapter + the llm_calls telemetry write (de-stub LLM part 2, step 2). NO stub — always-on in Python production.',
  STYLE,
  'Part-1 built: ' + JSON.stringify(p1).slice(0, 300),
  'READ FULLY: ' + BLOB + ' (BlobStorePostgresAdapter: put({installation_id, key, body, content_type}) → BlobRef [zstd-compress body, INSERT INTO telemetry.llm_payloads, MAX_BLOB_BYTES=50MiB cap], get(ref) → bytes [decompress], delete(ref); the BlobStorePort interface) and ' + CLIENT + ' lines 481-536 + 674-708 (the telemetry.llm_calls write — the EXACT INSERT columns: llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd_cents, payload_blob_id, status[ok/failed/timeout], created_at — on BOTH the success and failure paths) and the archive-redaction (_redact_message_for_archive / _redact_response_for_archive — reuse the ported PII redactor).',
  'PORT TO: ' + REPO + '/apps/backend/src/backend/adapters/blobstore_postgres.ts (BlobStorePostgresAdapter implementing the BlobStore port the LlmClient already expects; zstd via node:zlib; the 50MiB cap) + WIRE the llm_calls telemetry write into ' + REPO + '/apps/backend/src/backend/integrations/llm/client.ts (currently the telemetry write is OMITTED — add the real INSERT on success+failure, using the injected sessionFactory/kysely; the archive redaction reuses the ported PII redactor). Keep Langfuse/OTel faithfully-OFF (a code comment: env-gated in Python, intentionally not wired — NOT a stub).',
  'TEST: test/integration/adapters/blobstore_postgres.integration.test.ts (put→get round-trips a real llm_payloads row, zstd, the 50MiB cap rejects) + test/integration/llm/llm_client_telemetry.integration.test.ts (a real invoke writes a telemetry.llm_calls row with the right columns/status; failure path writes status=failed). Disposable PG, serial, self-cleaning, skip-if-unreachable. The SDK stays a recorded-response double (unreachable Bedrock).',
  'Return component="blob_telemetry", files_written, commands, all_green, notes: the llm_payloads schema + zstd, the llm_calls INSERT columns + the success/failure status mapping, the archive-redactor reuse, the Langfuse/OTel faithfully-off note, divergence risk.',
].join('\n')

const p2 = await agent(P2, { label: 'port:blob+telemetry', phase: 'BlobTelemetry', schema: BUILD_SCHEMA })

phase('WireAndMove')

const P3 = [
  'Wire the real cost-cap + blob into the LLM client graph + move the cassette SDK to test/ (de-stub LLM part 2, step 3). After this, forRole("primary") builds a FULLY-REAL LlmClient with zero faking stubs on the production path.',
  STYLE,
  'Parts 1+2 built: ' + JSON.stringify({ p1: p1.component, p2: p2.component }).slice(0, 200),
  'DO:',
  '1. In #backend/integrations/llm/client_cache.js — the client_factory must build the LlmClient with the REAL PostgresCostCapEnforcer + BlobStorePostgresAdapter (constructed from the shared sessionFactory/kysely + clock), NOT the client.ts defaults. The production forRole path is now fully real.',
  '2. In #backend/integrations/llm/client.ts — the AllowAllCostCap + InMemoryBlobStore defaults are FAKING stubs on the production path. Make them clearly TEST-ONLY: either remove the defaults so cost_cap+blob are REQUIRED constructor args (production + tests both inject), OR keep them but rename/document them unambiguously as test-only fallbacks that production NEVER uses (the cache always injects real ones). Prefer required args if the only non-test caller is the cache. Update any test that relied on the defaults.',
  '3. MOVE apps/backend/src/backend/integrations/llm/cassette_sdk.ts → test/support/llm/cassette_sdk.ts (a test-support location, NOT the src tree). Update its ONE importer (test/integration/activities/bedrock_review_chunk_cassettes.integration.test.ts) + any others (grep cassette_sdk). Fix relative imports inside the moved file.',
  'TEST: ensure the moved cassette_sdk still works for its importer; run the affected tests. Add/adjust a unit/integration test proving forRole builds a LlmClient whose cost_cap is the Postgres enforcer + blob is the Postgres adapter (instanceof / structural check) — the production path is real.',
  'Return component="llm_wire_move", files_written, commands, all_green, notes: how the client_factory injects the real collaborators, what happened to the client.ts defaults (removed vs test-only), the cassette_sdk move + importer fix, confirmation that NO faking stub remains on the forRole production path, divergence risk.',
].join('\n')

const p3 = await agent(P3, { label: 'wire+move', phase: 'WireAndMove', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL verifier for LLM de-stub part 2. REFUTE that the production LLM path is now fully REAL (no faking stubs) and matches the frozen Python.',
  STYLE,
  'Built: ' + JSON.stringify({ p1: p1.component, p2: p2.component, p3: p3.component }).slice(0, 300),
  '1. NO FAKING STUB on the forRole production path (disposable PG ' + PGDSN + '): seed a settings row, forRole("primary") → a LlmClient whose cost_cap is PostgresCostCapEnforcer (NOT AllowAll) + blob is BlobStorePostgresAdapter (NOT discard-InMemory). Grep the constructed graph — AllowAll/discard must appear ONLY in test files now.',
  '2. COST-CAP real (disposable PG): a reservation writes/increments telemetry.cost_daily; over-cap → BedrockBudgetExceededError; record_call_cost diff applies. SQL matches the frozen Python (drive the frozen PostgresCostCapEnforcer against the SAME PG + compare the row state).',
  '3. BLOB real (disposable PG): a put writes a real telemetry.llm_payloads row that get() round-trips (zstd); 50MiB cap rejects.',
  '4. TELEMETRY real: a real invoke (recorded-SDK double) writes a telemetry.llm_calls row with the right columns + status=ok; the failure path writes status=failed.',
  '5. cassette_sdk moved out of src/ (grep apps/backend/src — no cassette_sdk there); its importer still passes. Langfuse/OTel confirmed faithfully-off (env-gated, documented, not a faking stub).',
  'Run (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN=' + PGDSN + ' npx vitest run --no-file-parallelism <the new+affected tests>) + check_clock_random; tsc clean. verdict=WEAK if any faking stub remains on the production path, the cost-cap/blob/telemetry SQL diverges, or the cassette move broke an importer; SOUND otherwise. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:cost-blob', phase: 'Verify', schema: VERIFY_SCHEMA })

return { p1, p2, p3, verify }
