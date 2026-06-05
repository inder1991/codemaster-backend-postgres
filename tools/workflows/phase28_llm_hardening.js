export const meta = {
  name: 'phase28-llm-hardening',
  description: 'Two project-owner-approved TS hardening DIVERGENCES from the frozen Python (code-review #4 + #5). #4: tenant-scope review LLM calls — make installationId REQUIRED, doReview passes context.installation_id (per-installation cost-cap + correct blob/telemetry/Langfuse attribution); keep an explicit ZERO_UUID platformInvocation path for internal jobs; ADR. #5: a NARROW LLM-invocation idempotency ledger — key=review_id+chunk_id+role+model+prompt_hash+tool_schema_version; persist the provider response before returning; on retry replay the stored result instead of re-invoking Bedrock (the only non-repeatable paid edge). Tested against the disposable PG.',
  phases: [
    { title: 'TenantScope', detail: '#4: invokeModel installationId REQUIRED (drop the silent sentinel default); doReview passes context.installation_id; a PLATFORM_INVOCATION (ZERO_UUID) helper for internal jobs; ADR-0068; unit tests that doReview passes the real id + the cost-cap/blob/telemetry doubles receive it.' },
    { title: 'Ledger', detail: '#5: migration for the llm_invocation_ledger table (disposable PG ONLY) + a Kysely repo + invokeModel idempotency (compute key → check ledger → replay stored provider response OR invoke SDK + persist before returning). telemetry/Langfuse replay against the stored result. Smallest viable ledger, NOT a generic outbox.' },
    { title: 'Verify', detail: 'adversarial: #4 — doReview→invokeModel carries the real installation_id end-to-end (cost-cap per_org, blob key, telemetry row all the real id; ZERO_UUID only on the explicit platform path); #5 — a duplicate invocation (same key) REPLAYS the stored response with ZERO additional SDK calls; a first call invokes+persists; the SDK is the only non-repeatable edge.' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const PGDSN = 'postgresql://postgres:postgres@localhost:5434/codemaster'
const CLIENT = REPO + '/apps/backend/src/backend/integrations/llm/client.ts'
const REVIEW = REPO + '/apps/backend/src/backend/review/review_activity.ts'

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
  'THESE ARE INTENTIONAL DIVERGENCES from the frozen Python (project-owner approved), documented in ADR-0068. Mark every divergence in code comments as "TS hardening divergence (ADR-0068) — Python <does X>". NO stub on the shipped path; test doubles ONLY in test files.',
  'REUSE: #platform/db/database.js (tenantKysely/getPool — the shared pool; the ledger repo takes an injected Kysely). #platform/clock.js. #platform/randomness.js (SystemRandom — the existing uuid seam). #contracts/review_context.v1.js (ReviewContextV1 — has installation_id + the chunk_id + the run/review id; CONFIRM the exact field names for review_id/chunk_id). #backend/cost/enforcer.js (the cost-cap; ZERO_UUID is its global-scope sentinel). node:crypto for the prompt hash (sha256). The existing client.ts TELEMETRY_MISSING_INSTALLATION_ID sentinel.',
  'GATE: check_clock_random (Clock seam, no raw Date.now/Math.random). check_tenant_scoped_raw_sql (the ledger table — decide its tenancy; carry installation_id if tenant-scoped). The DISPOSABLE PG is ' + PGDSN + ' — NEVER the in-cluster DB. Any migration runs ONLY against ' + PGDSN + ' via (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN=' + PGDSN + ' npm run migrate:up). Integration tests SERIAL (--no-file-parallelism), unique ids.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix; NO git add/commit; CLEAN UP scratch. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN=' + PGDSN + ' npx vitest run --no-file-parallelism <your test files>).',
].join('\n')

phase('TenantScope')

const P1 = [
  'Implement code-review #4: TENANT-SCOPE the review LLM calls (project-owner-approved divergence from the frozen Python, which platform-scopes them). NO stub.',
  STYLE,
  'OWNER DECISION (verbatim): "Pass real installation_id. Per-org cost caps cannot protect a noisy installation if all review spend is charged to the platform sentinel; blob/telemetry/Langfuse attribution under all-ones UUID makes incident response/billing/SLOs worse. Platform-scope should be reserved for genuine platform jobs. Make the divergence explicit in an ADR. Keep a separate explicit platform-scope path for internal jobs using ZERO_UUID or a named platformInvocation helper, but do not let normal review calls omit installationId. Add a unit test that doReview() passes context.installation_id and that the injected cost-cap/blob/telemetry doubles receive that exact id."',
  'DO:',
  '1. In ' + CLIENT + ' — make `installationId` a REQUIRED arg of invokeModel (drop the silent `?? TELEMETRY_MISSING_INSTALLATION_ID` fallback so a caller cannot omit it). The real id flows to the cost-cap (installationId), the blob put (installationId), and the telemetry.llm_calls + Langfuse rows. Export a named `PLATFORM_INVOCATION_INSTALLATION_ID` = ZERO_UUID ("00000000-0000-0000-0000-000000000000", the cost-cap global-scope sentinel) for genuine internal/platform jobs to pass EXPLICITLY (keep TELEMETRY_MISSING only as a defensive last resort that production never hits — or remove it). Update existing tests/cassette callers to pass an explicit id.',
  '2. In ' + REVIEW + ' — doReview now passes `installationId: context.installation_id` to invokeModel (1:1 with the new contract). Comment it as the ADR-0068 divergence.',
  '3. Author ' + REPO + '/docs/adr/0068-tenant-scope-review-llm-calls.md — Python platform-scoped review LLM calls (installation_id deprecated/ignored/sentinel); TS intentionally tenant-scopes review calls for per-installation cost isolation + correct blob/telemetry/Langfuse attribution; ZERO_UUID/platformInvocation is the explicit platform-job path. Cite the owner rationale.',
  'TESTS: a unit test that doReview() passes context.installation_id through to invokeModel and the injected cost-cap + blob + telemetry doubles receive THAT EXACT id (not the sentinel). Update the cassette/dual-run callers to pass an explicit id (a fixed test installation_id) so they still compile + pass.',
  'Return component="tenant_scope_llm", files_written, commands, all_green, notes: the required-installationId change, the ZERO_UUID platform helper, the doReview wire, the ADR, which callers were updated, divergence risk.',
].join('\n')

const p1 = await agent(P1, { label: 'port:tenant-scope', phase: 'TenantScope', schema: BUILD_SCHEMA })

phase('Ledger')

const P2 = [
  'Implement code-review #5: a NARROW LLM-invocation idempotency ledger (project-owner-approved TS hardening divergence). Prevents a post-call persistence failure + Temporal retry from buying a duplicate paid LLM completion. NO stub.',
  STYLE,
  'Part-1 built: ' + JSON.stringify(p1).slice(0, 300),
  'OWNER DECISION (verbatim): "Add idempotency now, but scope it narrowly. Generate a stable idempotency key from deterministic activity inputs: review_id + chunk_id + role + model + prompt hash + tool schema version. Persist the raw provider response and parsed result before returning. On retry, check the idempotency record first and return/replay the stored result instead of invoking Bedrock. Keep telemetry/Langfuse as retryable/replayable side effects against the stored result. Make provider invocation the only non-repeatable paid edge. Do NOT build a broad generic outbox yet — build the smallest LLM invocation ledger that prevents duplicate paid calls. Document as an intentional TS hardening divergence from Python."',
  'DO:',
  '1. MIGRATION (disposable PG ONLY): a node-pg-migrate migration for `core.llm_invocation_ledger` (idempotency_key text PRIMARY KEY, installation_id uuid NOT NULL, review_id uuid, chunk_id uuid, role text, model text, prompt_sha256 text, tool_schema_version text, provider_response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()). Run it ONLY against ' + PGDSN + '. (NEW table — a TS divergence; Python has no ledger.)',
  '2. ' + REPO + '/apps/backend/src/backend/integrations/llm/invocation_ledger.ts — LlmInvocationLedger(injected Kysely): computeKey({reviewId, chunkId, role, model, promptSha256, toolSchemaVersion}) -> sha256 hex; lookup(key) -> the stored provider_response | null; store(key, {installationId, ..., providerResponse}) (INSERT ON CONFLICT DO NOTHING so a racing retry is safe).',
  '3. WIRE into ' + CLIENT + ' invokeModel: add an optional `idempotency?: { reviewId, chunkId, toolSchemaVersion }` arg + an injected `ledger?: LlmInvocationLedger`. When BOTH present: compute the key (promptSha256 = sha256 of the serialized messages); lookup — if HIT, REPLAY the stored provider_response as the SDK response (SKIP the paid SDK call entirely; still run the post-call transform + output-safety + telemetry/Langfuse against the replayed response so those stay correct); if MISS, call the SDK, then `ledger.store(...)` the raw provider response BEFORE returning. When the ledger/idempotency is absent (platform jobs / unit tests), behave exactly as today (invoke, no ledger). The SDK call is the ONLY non-repeatable paid edge.',
  '4. doReview (' + REVIEW + ') passes the idempotency context (reviewId + chunkId from ReviewContextV1; toolSchemaVersion a constant/derived from REVIEW_TOOL_SCHEMA) so review invocations are ledgered.',
  'TESTS (disposable PG, serial): a FIRST invoke with a key → SDK called once + a ledger row written + the result returned; a SECOND invoke with the SAME key → the SDK is NOT called again (spy asserts 0 additional calls) + the stored response is replayed + the SAME result returned; telemetry/Langfuse still fire on the replay. A no-idempotency invoke → unchanged (SDK called, no ledger).',
  'Return component="invocation_ledger", files_written, commands, all_green, notes: the ledger table + key, the replay-skips-SDK path, the store-before-return, the tool_schema_version source, the no-idempotency back-compat, divergence risk.',
].join('\n')

const p2 = await agent(P2, { label: 'port:ledger', phase: 'Ledger', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL verifier for the LLM hardening (#4 tenant-scope + #5 idempotency ledger). REFUTE that review calls carry the real installation_id end-to-end AND that a duplicate invocation does not buy a second paid completion.',
  STYLE,
  'Built: ' + JSON.stringify({ p1: p1.component, p2: p2.component }).slice(0, 300),
  '1. TENANT-SCOPE (#4): drive doReview with a ReviewContextV1 carrying a specific installation_id → assert the injected cost-cap.checkOrRaise, blob.put, and telemetry writer ALL receive THAT id (not the all-ones sentinel). invokeModel REQUIRES installationId (a caller omitting it is a type error / throws). The ZERO_UUID PLATFORM_INVOCATION path is the only sanctioned non-tenant id. ADR-0068 exists.',
  '2. IDEMPOTENCY (#5, disposable PG ' + PGDSN + '): a first invoke with key K → SDK invoked once, a core.llm_invocation_ledger row persisted, result R returned. A SECOND invoke with the SAME K (simulating a Temporal retry after a post-call failure) → the SDK spy shows NO additional call, the stored provider response is replayed, the SAME result R is returned. The SDK is the ONLY non-repeatable paid edge (telemetry/Langfuse re-fire on replay, which is fine).',
  '3. BACK-COMPAT: an invoke with NO idempotency context (platform job / unit test) behaves exactly as before (SDK called, no ledger row).',
  '4. The migration ran ONLY against the disposable PG; the in-cluster DB was never touched.',
  'Run (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN=' + PGDSN + ' npx vitest run --no-file-parallelism <the new tests>) + check_clock_random; tsc clean. verdict=WEAK if review calls can omit/sentinel the installation_id, or a duplicate-key invoke re-calls the SDK, or back-compat breaks; SOUND otherwise. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:llm-hardening', phase: 'Verify', schema: VERIFY_SCHEMA })

return { p1, p2, verify }
