export const meta = {
  name: 'phase20-skeleton-build',
  description: 'Phase 2.0 walking skeleton (BUILD only, no running Temporal): persist_review_findings activity + stub workflow + worker bootstrap + custom DataConverter + ADR-0065, self-verified via bundleWorkflowCode (crypto-sandbox check) + converter round-trip',
  phases: [
    { title: 'Build', detail: 'data_converter + persist activity + skeleton workflow + worker/main + registry + ADR-0065 + tests' },
    { title: 'Verify', detail: 'adversarial: bundleWorkflowCode proves crypto-free sandbox bundle; DataConverter round-trip; gates; Temporal wiring correctness vs docs' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'

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
  'TS STYLE (validate-fast = gates -> lint -> typecheck -> test): ESM .js import specifiers; "type" alias not "interface"; Array<T>; NO any (unknown + narrow); named exports; explicit return types; import { type X }; no unused vars; snake_case FILENAMES; camelCase members.',
  'IMPORTS: #contracts/* (libs/contracts/src), #platform/* (libs/platform/src), #backend/* (apps/backend/src/backend); same-dir relative ./x.js.',
  'NO RUNNING TEMPORAL is needed for this BUILD — everything is verified statically (tsc/eslint/gates) + via bundleWorkflowCode (compiles the workflow sandbox bundle, catching illegal imports WITHOUT a server) + a DataConverter unit round-trip + a real Postgres is NOT required either (the activity is constructed but not invoked; persistAggregated is already integration-tested elsewhere).',
  'NO NEW DEPS (@temporalio/{worker,workflow,client,activity} ^1.11.0 + kysely + zod already present). Frozen Python reference READ-ONLY at ' + REPO + '/vendor/codemaster-py. Consult the official Temporal TypeScript SDK docs (WebFetch/WebSearch docs.temporal.io / typescript.temporal.io) for the EXACT current-version APIs — do not guess.',
  'GATES: check_clock_random.ts (ERROR-mode; scans libs/apps src) — workflow + converter + activity must not use Date.now/Math.random/setTimeout-for-timing outside the Clock seam. The WORKFLOW bundle additionally must not import node:crypto (the sandbox bans it).',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit; NO kubectl/cluster/Temporal contact; NO DB writes.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>); AND the bundleWorkflowCode self-check (see Build step 6).',
].join('\n')

phase('Build')

const BUILD = [
  'Build the Phase-2.0 Temporal-TS WALKING SKELETON — the thinnest real vertical slice: a worker that registers ONE activity (persist_review_findings) and a stub workflow that calls it. This establishes the foundational Temporal-TS pattern (worker bootstrap + custom DataConverter + workflow-bundle crypto boundary) that ALL of Phase 2.1+ reuses. No LLM, no git, no embedder.',
  STYLE,
  'CONTEXT — the frozen Python reference: codemaster/review/persist_review_findings.py defines persist_review_findings_activity (the @activity.defn) whose single typed input is PersistReviewFindingsInputV1; it constructs the PostgresReviewFindingsRepo and calls persist_aggregated. The TS repo ALREADY HAS: libs/contracts/src/persist_review_findings.v1.ts (the input contract, crypto-free graph: -> aggregated_findings -> review_findings, all zod-only), apps/backend/src/backend/domain/repos/review_findings_repo.ts (PostgresReviewFindingsRepo.persistAggregated, with the stale-write guard + FINDINGS_PERSISTED emit just landed; tenantKyselyForDsn(dsn) factory + a Clock), and #platform/clock.js (WallClock/FakeClock).',
  'CRITICAL ARCHITECTURAL RULE you are establishing (ADR-0065): Temporal WORKFLOW code is bundled into an isolated sandbox that BANS node:crypto. Two contracts (libs/contracts/src/diff_chunking.v1.ts + retrieved_evidence.v1.ts) import node:crypto — the workflow module + the DataConverter module MUST NOT (transitively) import either. persist_review_findings.v1 is crypto-free (verified) so the skeleton is safe; the rule is for the future fan-out (minting runs in ACTIVITIES, never the workflow body / converter).',
  'BUILD these files:',
  '1) ' + REPO + '/apps/backend/src/backend/worker/data_converter.ts — a custom Temporal PayloadConverter module. Temporal loads it via `dataConverter: { payloadConverterPath }` and imports it into BOTH the main thread AND the workflow sandbox, so it MUST be crypto-free + deterministic. Our contracts are already WIRE-CLEAN (UUIDs are z.string().uuid(), datetimes are z.string().datetime() ISO strings — NO uuid.UUID/Date objects to marshal, unlike Python pydantic_data_converter). Decide + document: does Temporal\'s DEFAULT JsonPayloadConverter suffice for the skeleton (likely yes, since inputs are plain JSON-able), or is a thin custom CompositePayloadConverter needed? Build the minimal correct thing and EXPORT `const payloadConverter` (the name Temporal requires). Document the 2.5 deferral: full byte-parity with Python pydantic_data_converter (incl. the confidence-float 1.0-vs-1 quirk) is OUT OF SCOPE for the skeleton.',
  '2) ' + REPO + '/apps/backend/src/backend/activities/persist_review_findings.activity.ts — the activity function `persistReviewFindings(input: PersistReviewFindingsInputV1): Promise<Array<string>>`. It constructs PostgresReviewFindingsRepo via tenantKyselyForDsn(DSN-from-env CODEMASTER_PG_CORE_DSN) + a Clock (WallClock by default; if CODEMASTER_FAKE_CLOCK_ISO is set, a FakeClock at that instant — this makes the mini-dual-run deterministic later) and calls repo.persistAggregated({prId, installationId, aggregated, runId, reviewId}) returning the finding ids. Activities run in the normal Node runtime (node:crypto is FINE here). Pull prId/installationId/runId/reviewId/aggregated out of the input contract per its actual shape (read persist_review_findings.v1.ts).',
  '3) ' + REPO + '/apps/backend/src/backend/workflows/review_skeleton.workflow.ts — the @workflow. Use proxyActivities<{ persistReviewFindings(input: PersistReviewFindingsInputV1): Promise<Array<string>> }>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 1 } }) then export `async function reviewSkeleton(input: PersistReviewFindingsInputV1): Promise<Array<string>> { return await acts.persistReviewFindings(input); }`. IMPORT ONLY the input/output TYPES from #contracts/persist_review_findings.v1.js (type-only import) + @temporalio/workflow — NOTHING that transitively imports node:crypto. No clock/random/uuid in the body (it just proxies).',
  '4) ' + REPO + '/apps/backend/src/backend/worker/registry.ts — export `const activities = { persistReviewFindings }` (the activities map the worker registers; grown additively in 2.1). Keep it a thin re-export.',
  '5) ' + REPO + '/apps/backend/src/backend/worker/main.ts — `export async function runWorker(): Promise<void>` that: NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233", tls: process.env.TEMPORAL_TLS === "1" ? {} : undefined }); Worker.create({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "dualrun", taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "review-skeleton-dualrun", workflowsPath: require.resolve("../workflows/review_skeleton.workflow"), activities, dataConverter: { payloadConverterPath: require.resolve("./data_converter") } }); await worker.run(). Guard a main-module entrypoint (if this file is run directly, runWorker().catch(...)). The defaults (namespace "dualrun", dedicated task queue) keep it ISOLATED from real cluster workflows. Document that ESM require.resolve needs createRequire(import.meta.url) — handle the ESM/CJS interop correctly for the installed @temporalio version (consult docs).',
  '6) BUNDLE SELF-CHECK ' + REPO + '/scripts/check_workflow_bundle.ts — a script that calls `await bundleWorkflowCode({ workflowsPath: require.resolve("../apps/backend/src/backend/workflows/review_skeleton.workflow") })` from @temporalio/worker and exits 0 on success / non-zero on failure (printing the error). This COMPILES the workflow sandbox bundle and FAILS LOUDLY if the workflow graph imports node:crypto or other sandbox-illegal modules — the build-time proof of ADR-0065 WITHOUT a running Temporal. Run it and confirm exit 0.',
  '7) ' + REPO + '/docs/adr/0065-temporal-ts-workflow-bundle-crypto-boundary.md — record the rule: the Temporal workflow bundle (+ the payload converter) MUST NOT import node:crypto (sandbox bans it); the 2 offending contracts (diff_chunking.v1, retrieved_evidence.v1) and their minting helpers (computeChunkId/mintEvidenceId/buildRetrievedEvidence) run in ACTIVITIES only; enforced at build time by scripts/check_workflow_bundle.ts (note: extend this to a validate-fast gate once 2.1 adds more workflows). Reference the frozen-Python per-chunk-closure structure that already isolates minting to activity context.',
  '8) ' + REPO + '/test/unit/worker/data_converter.test.ts — round-trip a representative PersistReviewFindingsInputV1 fixture through payloadConverter.toPayload(x) then fromPayload(payload) and assert deep-equal to the original (proves the converter preserves the contract). Also assert a Temporal Payload (metadata.encoding) is produced.',
  'Return component="skeleton", files_written, commands (each w/ the bundleWorkflowCode result explicitly), all_green, notes (the DataConverter decision default-vs-custom + WHY, the ESM require.resolve interop handling, confirmation bundleWorkflowCode exit 0 = crypto-free sandbox, what is deferred to the RUN step (the actual worker.run against Temporal + the mini-dual-run harness + the frozen-py runner), and the isolation defaults).',
].join('\n')

const build = await agent(BUILD, { label: 'build:skeleton', phase: 'Build', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL verifier for the Phase-2.0 Temporal-TS walking skeleton. REFUTE that (a) the workflow sandbox bundle is crypto-free + compiles, (b) the DataConverter round-trips the contract, (c) the Temporal wiring (proxyActivities / Worker.create / payloadConverterPath / workflowsPath) is correct per the installed @temporalio ^1.11 API, (d) the gates pass.',
  STYLE,
  'Built: ' + JSON.stringify(build).slice(0, 600),
  'Independently:',
  '1. BUNDLE / CRYPTO BOUNDARY (the load-bearing check): run (cd ' + REPO + ' && npx tsx scripts/check_workflow_bundle.ts) and confirm exit 0 — the workflow bundle COMPILES with NO node:crypto / sandbox-illegal import. Then ADVERSARIALLY prove it has teeth: temporarily add `import "#contracts/diff_chunking.v1.js"` (which imports node:crypto) to a throwaway copy of the workflow OR a scratch workflow, run bundleWorkflowCode on it, and confirm it FAILS (proving the check actually catches the crypto break). Remove the scratch. If the bundle check passes even WITH a crypto import, the check is toothless -> WEAK.',
  '2. DATA CONVERTER: run the round-trip test; independently load the payloadConverter and round-trip a DIFFERENT PersistReviewFindingsInputV1 (with nested AggregatedFindingsV1 findings incl. evidence_refs + citations + a confidence float) and assert deep-equal. Confirm the converter module itself does NOT import node:crypto (it loads into the sandbox too).',
  '3. TEMPORAL WIRING vs DOCS: read the actual @temporalio/{worker,workflow} types in ' + REPO + '/node_modules and/or the docs; confirm proxyActivities is used correctly (the workflow-side proxy, types match the activity signature), Worker.create options are valid for ^1.11 (workflowsPath, activities, dataConverter.payloadConverterPath, namespace, taskQueue, connection), NativeConnection.connect signature is correct, and the ESM require.resolve/createRequire interop is correct (a common ^1.11 footgun). Flag any API misuse that would throw at worker startup.',
  '4. GATES + TYPES: (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <the skeleton files>) clean; (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts) 0 violations; the workflow body uses NO Date/random/uuid (pure proxy).',
  '5. ISOLATION: confirm the worker defaults (namespace "dualrun", task queue "review-skeleton-dualrun") would NOT collide with real cluster workflows, and TEMPORAL_ADDRESS/NAMESPACE/TASK_QUEUE/TLS are env-overridable.',
  'verdict=WEAK if the bundle check is toothless or fails, the converter loses data, the Temporal wiring would throw at startup, a gate fails, or the workflow body is non-deterministic; SOUND otherwise. Exact reproduction for any failure. Clean up any scratch (your files only).',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:skeleton', phase: 'Verify', schema: VERIFY_SCHEMA })

return { build, verify }
