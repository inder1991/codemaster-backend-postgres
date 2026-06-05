export const meta = {
  name: 'phase24-llm-real-keystone',
  description: 'DE-STUB the LLM client: port the REAL credentials→SDK→cache chain so the pipeline makes a real LLM call (no stubs). PostgresLlmProviderSettingsRepo (core.llm_provider_settings + Vault-decrypt) + LlmCredentialsProvider (TTL cache + rotation detect) + AnthropicBedrockSdkAdapter (real @anthropic-ai/bedrock-sdk) + LlmClientCache (forRole). Tested against the disposable PG + InMemoryVault double + a recorded Bedrock response.',
  phases: [
    { title: 'SettingsRepo', detail: 'PostgresLlmProviderSettingsRepo: read core.llm_provider_settings (scope=platform) + Vault-decrypt api_key; read_decrypted_settings / read_rotation_fingerprint / read_last_rotated_at. Real disposable-PG integration test.' },
    { title: 'CredsProvider', detail: 'LlmCredentialsProvider: per-role TTL cache + per-role locks + cheap rotation detection + hard-stale expiry. FakeClock unit tests.' },
    { title: 'SdkAndCache', detail: 'AnthropicBedrockSdkAdapter (real AnthropicBedrock; hoist_system_messages; SDK cache + rebuild-on-cred-change; exception mapping; aclose) + LlmClientCache (forRole: PK-scan fingerprint + Vault-on-miss + sdk/client factories + 2-slot cache).' },
    { title: 'Verify', detail: 'adversarial: the real chain settings→creds→sdk→cache resolves a real LlmClient against the disposable PG; the SQL matches Python; the SDK request shape (system hoist + tools) matches; rotation invalidation works; no stubs remain in the production path.' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const LLM = REPO + '/vendor/codemaster-py/codemaster/integrations/llm'
const ADMIN = REPO + '/vendor/codemaster-py/codemaster/api/admin'
const PGDSN = 'postgresql://postgres:postgres@localhost:5434/codemaster'

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
  'PRODUCTION CODE MUST BE REAL — NO stubs/mocks/no-ops in the shipped path. Test doubles are allowed ONLY in test files (the user approved: InMemoryVault double, recorded/cassette Bedrock for the unreachable service, real disposable PG).',
  'REUSE (already REAL — do NOT re-implement): #backend/adapters/vault_port.js + vault_http.js (the Vault Transit decrypt — the settings repo decrypts api_key_ciphertext via the Vault Transit key "llm_provider_settings"). #platform/db/database.js (tenantKysely / getPool — the REAL Kysely pool; the settings repo + cache run platform-scoped reads, scope=platform — grep whether these need @privileged_path / a non-tenant Kysely since llm_provider_settings is platform-not-tenant-scoped). #backend/integrations/llm/client.js (LlmClient — the cache builds these). #backend/integrations/llm/errors.js (the LLM error hierarchy — extend with LlmTimeoutError/LlmRateLimitError/LlmAuthError/LlmServerError/LlmCredentialsExpiredError if missing). #platform/clock.js (Clock/FakeClock). #backend/llm/model_router.js.',
  'GATE: check_clock_random (use the Clock seam, no raw Date/Math.random); check_tenant_scoped_raw_sql (llm_provider_settings is platform-scoped — if it lacks installation_id, use the @privileged_path/marker idiom the other platform-scope repos use — grep for it). The DISPOSABLE PG is ' + PGDSN + ' — NEVER the in-cluster DB. Migrations (if a table is missing) run ONLY against ' + PGDSN + ' via (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN=' + PGDSN + ' npm run migrate:up).',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit; CLEAN UP scratch. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

phase('SettingsRepo')

const P1 = [
  'Port the REAL PostgresLlmProviderSettingsRepo to TypeScript (de-stub step 1). Reads LLM provider credentials from core.llm_provider_settings and Vault-decrypts the api_key. NO stub — a real Kysely repo against the disposable PG, real Vault decrypt.',
  STYLE,
  'READ FULLY: ' + ADMIN + '/postgres_llm_provider_settings_repo.py — the table core.llm_provider_settings (scope, role, installation_id, provider, api_key_ciphertext, model_id, region, enabled, last_rotated_at, last_rotated_by_user_id, validated_at, validation_status); scope="platform" only; the Vault Transit key "llm_provider_settings"; the THREE reads: read_decrypted_settings(role) -> LlmProviderSettings|null (plaintext api_key + provider + model_id + region + enabled), read_rotation_fingerprint() -> [(role, last_rotated_at)...] (PK-scan, cache-invalidation), read_last_rotated_at(scope, role) -> timestamp|null. Mirror the SQL + the Vault decrypt EXACTLY.',
  'CHECK: does core.llm_provider_settings exist in the TS migrations (grep migrations/ + the disposable PG: (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN=' + PGDSN + ' psql or a kysely introspect))? If the table/columns are MISSING, port the migration (node-pg-migrate) for core.llm_provider_settings matching the Python schema + run it against ' + PGDSN + ' ONLY. (The Python migration is in vendor/codemaster-py/codemaster/migrations — find it.)',
  'PORT TO: ' + REPO + '/apps/backend/src/backend/integrations/llm/llm_provider_settings_repo.ts — the contract LlmProviderSettings (Zod or a typed row) + PostgresLlmProviderSettingsRepo(kysely, vault, clock). Real Vault Transit decrypt via the ported VaultPort.',
  'TEST: test/integration/llm/llm_provider_settings_repo.integration.test.ts — against the REAL disposable PG (' + PGDSN + '): seed a platform-scope row (api_key encrypted via the InMemoryVault double OR the real vault path), read it back decrypted, assert the fingerprint + last_rotated_at reads. Mark @integration. Skip-if-PG-unreachable guard like the other integration tests.',
  'Return component="llm_settings_repo", files_written, commands, all_green, notes: the exact SQL, the Vault key + decrypt path, whether a migration was needed (+ that it ran on the disposable PG only), the platform-scope tenancy handling, divergence risk.',
].join('\n')

const p1 = await agent(P1, { label: 'port:settings-repo', phase: 'SettingsRepo', schema: BUILD_SCHEMA })

phase('CredsProvider')

const P2 = [
  'Port the REAL LlmCredentialsProvider to TypeScript (de-stub step 2). TTL-refreshing per-role credential cache over the settings repo (part 1). NO stub.',
  STYLE,
  'Part-1 built (reuse the settings repo): ' + JSON.stringify(p1).slice(0, 400),
  'READ FULLY: ' + LLM + '/credentials_provider.py — the per-role cache dict[role,(LlmCredentials, expires_at)] (NOT single-entry); LlmCredentials{api_key, region, model_id}; TTL=300s default, hard_stale=1800s; per-role asyncio.Lock; cheap rotation detection via read_last_rotated_at(scope=platform, role) (invalidate immediately on operator rotation); the failure ladder (fresh->return; stale+refresh-ok->repopulate; stale+transient-fail->log rule=bedrock-credentials-refresh-failed + return stale; hard-stale->raise LlmCredentialsExpiredError; initial-fail->raise). current(role) is the entry.',
  'PORT TO: ' + REPO + '/apps/backend/src/backend/integrations/llm/credentials_provider.ts — LlmCredentialsProvider(repo, clock, ttlSeconds=300, hardStaleSeconds=1800) with .current(role). Use the Clock seam (no Date.now). Per-role locks via a Map<role, Promise-chain> or an async-mutex idiom already in the repo (grep #platform for a mutex/lock seam).',
  'TEST: test/unit/llm/credentials_provider.test.ts — FakeClock: fresh-hit (no refresh), TTL-expiry-refresh, rotation-detect-invalidates-early, transient-fail-returns-stale, hard-stale-raises. Stub the settings-repo as a TEST double (in the test file only).',
  'Return component="llm_creds_provider", files_written, commands, all_green, notes: the cache shape, the TTL+hard-stale+rotation ladder, the lock idiom, divergence risk.',
].join('\n')

const p2 = await agent(P2, { label: 'port:creds-provider', phase: 'CredsProvider', schema: BUILD_SCHEMA })

phase('SdkAndCache')

const P3 = [
  'Port the REAL AnthropicBedrockSdkAdapter + LlmClientCache to TypeScript (de-stub step 3). The real Bedrock SDK + the per-role client cache. NO stub — production uses the real @anthropic-ai/bedrock-sdk; tests inject a recorded-response SDK double (the user approved cassette for unreachable Bedrock).',
  STYLE,
  'Parts 1+2 built: ' + JSON.stringify({ p1: p1.component, p2: p2.component }).slice(0, 200),
  'READ FULLY: ' + LLM + '/sdk_adapter.py (AnthropicBedrockSdkAdapter: create_message(model, messages, max_tokens, tools, role) -> creds=provider.current(role); sdk=_sdk_for(creds) [cached AsyncAnthropicBedrock(api_key, aws_region); rebuild on cred change]; hoist_system_messages(messages)->(system, user_assistant); kwargs{model, messages, max_tokens, +system?, +tools?}; msg=await sdk.messages.create(**kwargs); return msg.model_dump(); exception->_map_anthropic_exception; aclose() closes sdk.close() + metrics; the _map_anthropic_exception map to LlmTimeoutError/RateLimit/Auth/Server) and the hoist_system_messages helper (grep its module) and ' + LLM + '/client_cache.py (LlmClientCache.for_role: read_rotation_fingerprint PK-scan; 2-slot cache role->(client, fingerprint); fast-path on unchanged fingerprint; slow-path under lock: double-check, read_decrypted_settings, sdk_factory(provider, creds_provider), client_factory(sdk), cache; aclose() closes every cached client).',
  'TS SDK: use @anthropic-ai/bedrock-sdk — `new AnthropicBedrock({ awsRegion, ... })`. VERIFY the SDK construction + auth: the Python uses api_key (BEARER token via AWS_BEARER_TOKEN_BEDROCK) + aws_region. Find the @anthropic-ai/bedrock-sdk equivalent for bearer-token auth (awsRegion + the bearer token / authToken option). client.messages.create({ model, messages, max_tokens, system?, tools? }). Make the SDK CONSTRUCTION an injectable factory (default = the real `new AnthropicBedrock(...)`) so tests inject a recorded-response double WITHOUT a real AWS call — production default is REAL.',
  'PORT TO: ' + REPO + '/apps/backend/src/backend/integrations/llm/bedrock_sdk_adapter.ts (AnthropicBedrockSdkAdapter) + ' + REPO + '/apps/backend/src/backend/integrations/llm/client_cache.ts (LlmClientCache). The cache client_factory builds the REAL LlmClient (#backend/integrations/llm/client.js) — for THIS step the cost_cap/blob can stay the client.ts defaults (replaced in the NEXT workflow); note that.',
  'TEST: test/unit/llm/bedrock_sdk_adapter.test.ts (inject a recorded-response SDK double: assert the request shape — system hoisted out of messages, tools passed, model/max_tokens; assert the response model_dump shape; assert exception mapping; assert SDK rebuild on cred change + reuse otherwise) + test/integration/llm/client_cache.integration.test.ts (against the disposable PG: a settings row -> for_role builds a real LlmClient; a rotation bump -> fingerprint changes -> rebuild).',
  'Return component="llm_sdk_cache", files_written, commands, all_green, notes: the @anthropic-ai/bedrock-sdk construction + bearer auth, the system-hoist, the SDK-cache rebuild rule, the for_role fingerprint logic, what is still defaulted (cost_cap/blob) for the next workflow, divergence risk.',
].join('\n')

const p3 = await agent(P3, { label: 'port:sdk+cache', phase: 'SdkAndCache', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL verifier for the REAL LLM credentials→SDK→cache chain. REFUTE that the production path is real (no stubs) and resolves a real LlmClient whose SDK request + DB reads match the frozen Python.',
  STYLE,
  'Built: ' + JSON.stringify({ p1: p1.component, p2: p2.component, p3: p3.component }).slice(0, 300),
  '1. REAL CHAIN (disposable PG ' + PGDSN + '): seed a platform-scope llm_provider_settings row (Vault-encrypted api_key); drive LlmClientCache.forRole("primary") -> a real LlmClient with a Bedrock SDK adapter bound to the decrypted creds. Confirm NO no-op/stub on this path (grep the constructed graph for AllowAll/InMemory/Stub on the SETTINGS→CREDS→SDK→CACHE path — cost_cap/blob defaults on LlmClient are EXPECTED here, flagged for the next workflow; everything ELSE must be real).',
  '2. SQL PARITY: the settings-repo SELECTs (read_decrypted_settings / fingerprint / last_rotated_at) match the frozen Python SQL (drive the frozen Python repo against the SAME disposable PG row + compare the decrypted result + fingerprint).',
  '3. SDK REQUEST SHAPE: drive the TS adapter with a recorded-response SDK double + the frozen Python adapter with the same; compare the create() kwargs (system hoisted, tools, model, max_tokens) byte-for-byte.',
  '4. ROTATION: bump last_rotated_at on the PG row -> the credentials provider invalidates early AND the cache fingerprint changes -> a new client/SDK is built. Both layers.',
  '5. ERRORS: a simulated SDK timeout/rate-limit/auth maps to the same LlmInvocationError subtype on both sides.',
  'Run (cd ' + REPO + ' && npx vitest run <the new tests>) + check_clock_random; tsc clean. verdict=WEAK if any production-path stub remains (besides the flagged cost_cap/blob), the SQL diverges, the SDK request shape diverges, or rotation/error-mapping diverges; SOUND otherwise. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:llm-keystone', phase: 'Verify', schema: VERIFY_SCHEMA })

return { p1, p2, p3, verify }
