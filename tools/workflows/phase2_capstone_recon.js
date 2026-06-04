export const meta = {
  name: 'phase2-capstone-recon',
  description: 'Read-only recon for the Phase-2 capstone: core-loop activity work-list + orchestrator call-graph + Temporal-TS sandbox/determinism risk + dual-run harness requirements -> thin-skeleton design',
  phases: [
    { title: 'Map', detail: '4 parallel readers: core-loop activities, orchestrator call-graph, Temporal-TS sandbox risk, dual-run requirements' },
    { title: 'Synthesize', detail: 'capstone map + ordered work-list + 2.0 walking-skeleton design + top risks' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PYREPO = REPO + '/vendor/codemaster-py'

const MAP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'findings', 'artifacts', 'notes'],
  properties: {
    area: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    artifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    notes: { type: 'string' },
  },
}
const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['coreLoopWorkList', 'skeletonDesign', 'topRisks', 'recommendedSequence', 'openQuestions'],
  properties: {
    coreLoopWorkList: { type: 'array', items: { type: 'object', additionalProperties: true } },
    skeletonDesign: { type: 'object', additionalProperties: true },
    topRisks: { type: 'array', items: { type: 'object', additionalProperties: true } },
    recommendedSequence: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const COMMON = [
  'READ-ONLY reconnaissance. Do NOT write/edit any source, run migrations, start Temporal, or touch a DB. You MAY read files, grep, run `npx tsc --noEmit`-style inspection ONLY if non-mutating, and WebSearch/WebFetch for Temporal TS SDK docs. Prefix any shell with (cd ' + REPO + ' && ...) — cwd resets.',
  'FROZEN PYTHON (reference, read-only): ' + PYREPO + ' (the venv at ' + PYREPO + '/.venv/bin/python can import codemaster.*). TARGET TS REPO: ' + REPO + ' (libs/contracts/src = Zod contracts already ported; libs/platform/src = clock/randomness/db/observability seams; apps/backend/src/backend = ported spine subsystems redact/policy/chunking/cost/tenancy/trust_tier/output_safety/model_router/file_classification + the Phase-2 edges github/* + adapters/vault + ingest/_workflow_events_repository + domain/stale_write_guard).',
  'The CORE REVIEW LOOP (CLAUDE.md invariant 1) is: clone -> classify -> redact -> chunk -> context -> review -> aggregate -> post. Everything else (confluence sync, learnings derivation, eval, retention/partition maintenance, analytics, repair, embedder) is BACKGROUND = Phase-3, OUT of capstone scope.',
  'Return STRICT structured output per the schema. Be concrete: name files, symbols, contract names, line ranges. This recon directly produces the work-list + skeleton design the next workflows execute — precision matters more than prose.',
].join('\n')

phase('Map')

const R1 = [
  'AREA = core-loop activity inventory. Enumerate ONLY the core-review-loop @activity.defn activities (the clone->classify->redact->chunk->context->review->aggregate->post stages) from the frozen Python, and map each to what the TS port needs.',
  COMMON,
  'METHOD: grep `@activity.defn` across ' + PYREPO + '/codemaster (67 files have it — most are BACKGROUND; you want only the ~10-18 core-loop ones). Anchor on the orchestrator + the review/ package: ' + PYREPO + '/codemaster/review/activities.py, ' + PYREPO + '/codemaster/activities/clone_repository.py, and whatever the orchestrator actually dispatches (cross-check with R2). For EACH core-loop activity produce an artifact: { stage (one of clone/classify/redact/chunk/context/review/aggregate/post), activityName (the @activity.defn name= string), module (py path), singleInputContract (the ADR-0047 single Pydantic BaseModel arg type + its contracts/ module), returnContract (type + module), consumesPortedSpine (which already-ported TS subsystem/contract it calls — e.g. redact/policy/chunking/output_safety/trust_tier/cost/file_classification/model_router/review_findings_repo), portedAlready (is the TS contract for its input/return already in libs/contracts? yes/no/partial), dependsOnActivities (upstream stages whose output it consumes) }.',
  'ALSO: list the BACKGROUND activity families you are EXCLUDING (count + family names) so the boundary is explicit. Flag any activity that is borderline (used by both the core loop and background).',
  'findings = the ordered core-loop stage->activity list + the dependency order for porting + which input/return contracts still need porting. artifacts = the per-activity objects above. notes = anything surprising (an activity that fans out, a stage with multiple activities, a missing contract).',
].join('\n')

const R2 = [
  'AREA = orchestrator workflow call-graph + workflow-body determinism inventory. Map the ACTUAL Temporal workflow structure of the core review pipeline.',
  COMMON,
  'READ ' + PYREPO + '/codemaster/workflows/review_pipeline_orchestrator.py FULLY (it had only 1 direct execute/start_activity — so it likely delegates to a stage list, child workflows, or helper dispatchers; find the real structure). Map: the workflow class(es) + any child workflows; the EXACT stage sequence (the order activities are dispatched); HOW each activity is dispatched (workflow.execute_activity vs start_activity, the args=[single_model] single-typed-input pattern per ADR-0047, timeouts/retry policy); every workflow.patched("<marker>") gate; the stage-outcome/observability calls (record_stage, stage_outcome helper); and CRITICALLY the DETERMINISM-SENSITIVE surface in the workflow body — any clock/uuid/random usage, any non-deterministic stdlib, the topology-manifest construction (invariant 13), the patched markers. ',
  'Produce artifacts: { workflow: name+file+isChild, stages: ordered [{stage, activityName, dispatch, timeout, patchedMarker?}], determinismSensitive: [{site, what, howResolvedInPython}], childWorkflows: [...] }. findings = the linear stage pipeline + the patched-marker list + the determinism-sensitive sites the TS workflow sandbox will police. notes = how the 1-call-site indirection resolves (stage list? dispatcher helper? child workflows?).',
].join('\n')

const R3 = [
  'AREA = Temporal-TS sandbox + data-converter + determinism RISK ASSESSMENT. The target repo has @temporalio/{worker,workflow,client,activity} ^1.11.0 in package.json but ZERO worker/workflows/activities code has ever run. Assess what will break.',
  COMMON,
  'INVESTIGATE (read node_modules/@temporalio/* in ' + REPO + ' for the installed version behavior; WebSearch/WebFetch the official Temporal TypeScript SDK docs for: the workflow sandbox / isolation constraints, the data converter / payload converter, determinism rules, and the "bundleWorkflowCode" import restrictions):',
  '1. WORKFLOW SANDBOX: @temporalio/workflow runs workflow code in an isolated v8 context with a restricted module graph (no arbitrary node builtins, no fs/crypto/etc). ASSESS: do our Zod contracts (libs/contracts/src/*.v1.ts — they import "zod") import cleanly in the workflow sandbox? Does our clock seam (libs/platform/src/clock.ts — uses performance.now/Date in WallClock) and randomness seam (node:crypto in the SystemRandom seam, _mt19937) VIOLATE the sandbox if imported into workflow code? (Workflow code must use the Temporal-provided deterministic time/uuid, NOT our WallClock — map which seam belongs in ACTIVITY code (fine) vs WORKFLOW code (must use Temporal APIs).)',
  '2. DATA CONVERTER (the pydantic_data_converter analogue, ADR-0034 in Python): Temporal serializes activity inputs/outputs + workflow args through a payload converter. Our contracts are Zod. ASSESS what a custom DataConverter/PayloadConverter must do so that (a) the SINGLE-TYPED-INPUT invariant (ADR-0047: one Pydantic/Zod model per activity) round-trips, (b) JSON-safety holds (the dict-key-must-be-primitive rule — invariant 11), (c) Date/bigint/etc serialize deterministically. Does @temporalio ship a JSON converter that suffices, or is a custom Zod-aware converter required?',
  '3. DETERMINISM: map our seams to the Temporal rules — clock.now()/monotonic in a WORKFLOW must come from Temporal (workflow.now()), uuid in a workflow from workflow.uuid4(); in ACTIVITIES our normal seams are fine. The Python ADR-0061 smoke RCA was a leaked Anthropic httpx client whose GC finalizer ran on the Temporal sandbox loop -> sniffio crash; assess the TS analogue (a leaked @anthropic-ai client / unclosed handle in an activity or worker).',
  'Produce artifacts: { risks: [{risk, severity (high/med/low), where, mitigation}], dataConverterDecision (ship-default-json | custom-zod-converter + why), workflowVsActivitySeamMap: [{seam, allowedIn: workflow|activity|both, note}] }. findings = the concrete go/no-go risk list for the thin skeleton. notes = the single most likely thing to break first.',
].join('\n')

const R4 = [
  'AREA = dual-run (2.5) harness requirements: what the end-to-end parity oracle needs, what exists vs what is novel TS infra.',
  COMMON,
  'OPERATIONAL FACT (from the project owner): Temporal is ALREADY RUNNING in the user\'s kind cluster (codemaster namespace) — so the unblocker is NOT standing up Temporal, it is the CONNECTION method (a kubectl port-forward of the Temporal frontend to localhost:7233, the namespace to use, and crucially an ISOLATED/dedicated task queue + ideally a dedicated namespace so the skeleton/dual-run NEVER collides with real cluster workflows). HARD CONSTRAINT: the DB stays a DISPOSABLE localhost:5434 Postgres — NEVER the in-cluster codemaster Postgres. Capture the connection unknowns (frontend address, namespace, TLS/mTLS, auth) as openQuestions.',
  'The dual-run runs BOTH backends (frozen Python + new TS) on parallel Temporal task queues with isolated DB schemas, a cassette-pinned LLM, fixed clock + seeded random, and diffs the persisted findings + posted review. Read the migration plan section on it: search ' + REPO + '/docs/superpowers/plans/ for the dual-run / parity-oracle / Phase-2.5 content. Read the Python LLM replay seam ' + PYREPO + '/codemaster/integrations/llm/replay_transport.py (the httpx transport that replays recorded /v1/messages) + how the Anthropic client is constructed (sdk_adapter / _sdk_for, the CODEMASTER_LLM_REPLAY_DIR injection). Inspect the TS LLM layer in ' + REPO + ' (apps/backend/src/backend/llm/* if present) for the @anthropic-ai/bedrock-sdk client + whether an injectable HTTP transport / replay seam exists on the TS side yet.',
  'Map: { needs: [{component, existsOrNovel: exists-py|exists-ts|novel-ts, where, note}] } covering — Temporal dev server; two task queues; isolated DB schemas (or two disposable DBs); the TS cassette-replay LLM transport (the @anthropic-ai/bedrock-sdk injection point — does the SDK accept a custom fetch/httpAgent?); fixed clock + seeded random injection into both; the diff target (which DB tables / which posted-review fields are the parity assertion); the frozen-Python runnability (can it run an activity/workflow against a disposable PG + the replay dir?).',
  'findings = the minimal-viable dual-run components for a THIN one-path slice (not the full loop) + which are novel TS infra to build. notes = the single biggest unknown in making the dual-run byte-deterministic.',
].join('\n')

const maps = await parallel([
  () => agent(R1, { label: 'map:core-activities', phase: 'Map', schema: MAP_SCHEMA }),
  () => agent(R2, { label: 'map:orchestrator', phase: 'Map', schema: MAP_SCHEMA }),
  () => agent(R3, { label: 'map:temporal-ts-risk', phase: 'Map', schema: MAP_SCHEMA }),
  () => agent(R4, { label: 'map:dual-run-reqs', phase: 'Map', schema: MAP_SCHEMA }),
])

phase('Synthesize')

const SYNTH = [
  'Synthesize the 4 recon maps into an ACTIONABLE capstone plan. You are the architect; the maps are your scouts.',
  COMMON,
  'INPUT MAPS:',
  'R1 core-activities: ' + JSON.stringify(maps[0]).slice(0, 1400),
  'R2 orchestrator: ' + JSON.stringify(maps[1]).slice(0, 1400),
  'R3 temporal-ts-risk: ' + JSON.stringify(maps[2]).slice(0, 1400),
  'R4 dual-run-reqs: ' + JSON.stringify(maps[3]).slice(0, 1400),
  'PRODUCE (strict schema):',
  '- coreLoopWorkList: the ORDERED list of core-loop activities to port for 2.1, each { stage, activityName, inputContract, returnContract, contractsToPort (any unported), portOrder (int), risk }.',
  '- skeletonDesign: the THIN 2.0 walking-skeleton design — { chosenActivity (the simplest real core-loop leaf to prove the pipe, with WHY), minimalWorkflow (what the stub orchestrator does), workerBootstrap (registry + data converter wiring), dataConverter (the decision from R3 + concrete shape), miniDualRun (the smallest one-path parity check: what it pins + what it diffs), operationalSetup (Temporal dev server cmd + disposable PG + replay dir), filesToCreate: [paths] }.',
  '- topRisks: [{risk, severity, mitigation, surfacedBySkeleton: bool}] — ranked; mark which the thin skeleton would surface/retire.',
  '- recommendedSequence: the ordered phase plan (2.0 skeleton -> mini-dual-run -> 2.1 activity fan-out -> 2.2 orchestrator -> 2.3 worker -> 2.4 Fastify -> 2.5 full dual-run -> 2.6 smoke), each as a one-line scope.',
  '- openQuestions: anything needing the project owner (operational unblockers like the Temporal dev server, the Bedrock-vs-direct-Anthropic cassette story, isolated-DB strategy).',
].join('\n')

const plan = await agent(SYNTH, { label: 'synthesize:capstone-plan', phase: 'Synthesize', schema: SYNTH_SCHEMA })

return { maps: { coreActivities: maps[0], orchestrator: maps[1], temporalTsRisk: maps[2], dualRunReqs: maps[3] }, plan }
