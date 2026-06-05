export const meta = {
  name: 'phase25-workspace-lease',
  description: 'DE-STUB the clone activity: port the REAL workspace-lease lifecycle. LeaseRepo + transition_lease (state machine + StateDrift) + allocate/release activities + wire the real lease-assertion (transitionLease ALLOCATED→ALLOCATED + touchHeartbeat) and the real Temporal Context.heartbeat into clone_repo_into_workspace. The core.workspace_leases table already exists in the baseline. Janitor/retention/manager-boot DEFERRED.',
  phases: [
    { title: 'RepoTransition', detail: 'LeaseRepo (insert ON CONFLICT / get_by_id / find_active_by_run / touch_heartbeat) + transition_lease (SELECT FOR UPDATE → ALREADY_APPLIED | APPLIED+event | StateDrift) + LEASE_STATES + LeaseTransitionOutcome + StateDrift/WorkspaceSecurityViolation errors. Disposable-PG integration test.' },
    { title: 'Activities', detail: 'allocate_workspace_activity (AllocateWorkspaceInput → insert ALLOCATED lease + path derive → WorkspaceHandle) + release_workspace_activity (ReleaseWorkspaceInput → state-hop ALLOCATED→RELEASE_REQUESTED→RELEASED + path-validated rmtree + WORKSPACE_* events). Contracts + integration tests.' },
    { title: 'DeStubClone', detail: 'replace the clone activity no-op seams: real assertLeaseAllocated (txn → transitionLease(ALLOCATED→ALLOCATED) asserting ALREADY_APPLIED else StateDrift → touchHeartbeat) + real heartbeat (Context.current().heartbeat); register clone in worker/registry.ts. Tests inject no-op doubles.' },
    { title: 'Verify', detail: 'adversarial real lifecycle vs frozen Python (disposable PG): allocate creates an ALLOCATED row → clone asserts ALREADY_APPLIED + bumps heartbeat_at → release flips to RELEASED + emits events; StateDrift on a drifted/missing row; transition SQL + the biconditional-CHECK-safe UPDATE match Python.' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const WS = REPO + '/vendor/codemaster-py/codemaster/workspace'
const ACT = REPO + '/vendor/codemaster-py/codemaster/activities'
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
  'PRODUCTION CODE MUST BE REAL — NO no-op/stub on the shipped path. Test doubles ONLY in test files. The frozen Python lease lifecycle is always-on in production; match it.',
  'REUSE (already REAL): #platform/db/database.js (tenantKysely/getPool — the shared ADR-0062 pool; lease repos take an injected Kysely/Transaction, NOT a per-repo pool). #platform/clock.js (Clock/WallClock/FakeClock). #backend/ingest/_workflow_events_repository.js (emitWorkflowEvent — release emits WORKSPACE_* events; CONFIRM the WORKSPACE_ALLOCATED/RELEASE_REQUESTED/RELEASED/ORPHANED/CLEANUP_FAILED event types are in EVENT_TYPES, add if missing). #contracts/workspace_handle.v1.js (WorkspaceHandle — DONE). @temporalio/activity (Context.current().heartbeat — already a dep). The clone activity at #backend/activities/clone_repo_into_workspace.activity.js (the assertLeaseAllocated + heartbeat no-op seams to replace).',
  'TS IDIOMS (from persist_review_findings.activity.ts / review_findings_repo.ts): repos take an injected Kysely/Transaction; transactions via db.transaction().execute(async (tx) => …); raw sql`` carries installation_id literally for the TenancyPlugin (core.workspace_leases IS tenant-scoped — installation_id NOT NULL — so the SELECTs/UPDATEs MUST filter or carry installation_id; check TENANT_SCOPED_TABLES + use the installation_id token or the marker idiom). transition_lease asserts an open txn → mirror with an `instanceof Transaction` check. Clock seam, no raw Date.',
  'GATE: check_clock_random (Clock seam; the touch_heartbeat uses SQL clock_timestamp() not a TS clock — fine). check_tenant_scoped_raw_sql (workspace_leases is tenant-scoped). The DISPOSABLE PG is ' + PGDSN + ' — NEVER the in-cluster DB. core.workspace_leases ALREADY EXISTS in the baseline — NO migration; verify by introspection. Integration tests run SERIALLY (suite sets --no-file-parallelism); each test uses a UNIQUE installation_id/run_id (randomUUID) so rows never collide (the tenant-scoped-table isolation idiom).',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix; NO git add/commit; CLEAN UP scratch. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN=' + PGDSN + ' npx vitest run --no-file-parallelism <your test files>).',
].join('\n')

phase('RepoTransition')

const P1 = [
  'Port the REAL workspace LeaseRepo + transition_lease state machine to TypeScript (de-stub step 1). NO stub.',
  STYLE,
  'READ FULLY: ' + WS + '/_lease_repo.py (LeaseRepo: insert [INSERT INTO core.workspace_leases ... ON CONFLICT (run_id) WHERE state IN (ALLOCATED,RELEASE_REQUESTED) DO NOTHING], get_by_id, find_active_by_run [WHERE run_id=:rid AND state IN (ALLOCATED,RELEASE_REQUESTED)], touch_heartbeat [UPDATE ... SET heartbeat_at=clock_timestamp() WHERE workspace_id=:wid AND state=ALLOCATED, returns rowcount>0]) and ' + WS + '/_transition.py (LEASE_STATES={ALLOCATED,RELEASE_REQUESTED,RELEASED,ORPHANED,FAILED_CLEANUP}; LeaseTransitionOutcome{APPLIED,ALREADY_APPLIED}; the _STATE_TIMESTAMP_COLUMNS map; transition_lease(tx, workspace_id, from_state, to_state, activity, reason, clock, expected_installation_id=None): validate states; assert open txn; SELECT state,run_id,review_id,installation_id ... FOR UPDATE; row missing→StateDrift; current==to_state→return ALREADY_APPLIED (NO event); current!=from_state→raise StateDrift; else ONE UPDATE setting state + the to_state timestamp col (+ release_requested_by when →RELEASE_REQUESTED, + clear cleanup_failed_at on FAILED_CLEANUP→ retry) then emit ONE WORKSPACE_<to_state> event via emitWorkflowEvent and return APPLIED) and ' + WS + '/_errors.py (StateDrift{workspace_id, expected_from, actual_state}, WorkspaceSecurityViolation).',
  'PORT TO: ' + REPO + '/apps/backend/src/backend/workspace/lease_repo.ts (LeaseRepo, injected Kysely/Transaction) + ' + REPO + '/apps/backend/src/backend/workspace/transition.ts (transitionLease + LeaseTransitionOutcome + LEASE_STATES + the timestamp-col map) + ' + REPO + '/apps/backend/src/backend/workspace/errors.ts (StateDrift, WorkspaceSecurityViolation). The expected_installation_id cross-tenant guard: port as an optional param, default undefined (clone passes none).',
  'TEST: test/integration/workspace/lease_lifecycle.integration.test.ts (disposable PG, serial, unique ids): insert a lease (ALLOCATED) → get_by_id; touch_heartbeat bumps heartbeat_at (and returns false for a non-ALLOCATED/absent row); transitionLease(ALLOCATED→ALLOCATED)=ALREADY_APPLIED (no event); transitionLease(ALLOCATED→RELEASE_REQUESTED)=APPLIED (sets release_requested_at + emits the event); transitionLease from a drifted state → StateDrift; missing row → StateDrift. Assert the biconditional CHECKs are satisfied (no constraint violation).',
  'Return component="lease_repo_transition", files_written, commands, all_green, notes: the exact SQL (insert ON CONFLICT, touch_heartbeat clock_timestamp, the FOR UPDATE + single UPDATE), the ALREADY_APPLIED-no-event short-circuit, the StateDrift conditions, the event-type mapping + whether EVENT_TYPES needed WORKSPACE_*, the tenancy handling, divergence risk.',
].join('\n')

const p1 = await agent(P1, { label: 'port:repo+transition', phase: 'RepoTransition', schema: BUILD_SCHEMA })

phase('Activities')

const P2 = [
  'Port the REAL allocate_workspace_activity + release_workspace_activity to TypeScript (de-stub step 2). NO stub. Depends on part 1 (LeaseRepo + transitionLease).',
  STYLE,
  'Part-1 built: ' + JSON.stringify(p1).slice(0, 300),
  'READ FULLY: ' + ACT + '/_workspace_allocate.py (AllocateWorkspaceInput{schema_version:1, run_id, review_id, installation_id, repo_id:int|None, workflow_id:str} → WorkspaceHandle; body: mkdir installation_root/runs/<run_id> + _meta [the _meta/workspace.json write is diagnostic-only AD-13 — you MAY drop it]; uuid4 candidate workspace_id; LeaseRepo.insert(state ALLOCATED, orphan_check_after = clock.now()+orphan_grace, pod identity); find_active_by_run to resolve the canonical row; return the WorkspaceHandle{workspace_id, installation_id, run_id, derived_path, state}) and ' + ACT + '/_workspace_release.py (ReleaseWorkspaceInput{schema_version:1, workspace_id} → None; idempotent: get_by_id missing→noop; RELEASED→noop; ALLOCATED/ORPHANED hop through RELEASE_REQUESTED first; _validate_cleanup_path [tolerate missing dir; catch symlink/traversal → WorkspaceSecurityViolation → transition FAILED_CLEANUP + raise]; rmtree on OSError → FAILED_CLEANUP + raise; transition RELEASED). The path: installation_root = root/installations/<iid>; run dir = .../runs/<run_id>; derived_path = the workspace dir.',
  'POD IDENTITY: the Python pulls pod_name/pod_namespace/node_name/worker_id from the manager. For the minimal port, read them from env (Downward API: POD_NAME/POD_NAMESPACE/NODE_NAME + a WORKER_ID) with sensible non-empty defaults (the columns are NOT NULL). orphan_check_after = clock.now() + 30min (inline the default; do NOT port the whole WorkspaceConfig). The workspace ROOT dir from env (CODEMASTER_WORKSPACE_ROOT) with a default.',
  'PORT TO: ' + REPO + '/libs/contracts/src/{allocate_workspace_input,release_workspace_input}.v1.ts (the typed inputs, inv-11, + parity tests) + ' + REPO + '/apps/backend/src/backend/activities/{allocate_workspace.activity,release_workspace.activity}.ts. Release uses emitWorkflowEvent (via transitionLease) + node:fs path validation (resolve + ensure within the workspace root, reject symlink escape) + node:fs rm.',
  'TEST: test/integration/workspace/{allocate,release}_workspace.activity.integration.test.ts (disposable PG, serial, unique ids): allocate creates an ALLOCATED row + returns a WorkspaceHandle with the derived path + makes the dir; allocate is idempotent under retry (ON CONFLICT → find_active_by_run returns the same row); release flips ALLOCATED→RELEASED (through RELEASE_REQUESTED), removes the dir, emits the events; release on a missing/already-RELEASED row is a no-op; a path-traversal/symlink escape → WorkspaceSecurityViolation + FAILED_CLEANUP. Use os.tmpdir for the workspace root.',
  'Return component="alloc_release", files_written, commands, all_green, notes: the input contracts, the path derivation + pod-identity env, the allocate idempotency, the release state-hops + cleanup + events + path-validation, divergence risk.',
].join('\n')

const p2 = await agent(P2, { label: 'port:allocate+release', phase: 'Activities', schema: BUILD_SCHEMA })

phase('DeStubClone')

const P3 = [
  'De-stub the clone_repo_into_workspace activity (de-stub step 3): replace its no-op lease/heartbeat seams with the REAL impls. Depends on parts 1+2.',
  STYLE,
  'Parts 1+2 built: ' + JSON.stringify({ p1: p1.component, p2: p2.component }).slice(0, 200),
  'READ: #backend/activities/clone_repo_into_workspace.activity.js (the CloneRepoIntoWorkspaceDeps.assertLeaseAllocated? + .heartbeat? seams with no-op defaults; the assertion call site + the 4 heartbeat call sites at the phase boundaries) and ' + ACT + '/_workspace_clone.py:178-202 (the Python: ONE txn { transition_lease(ALLOCATED→ALLOCATED) asserting outcome IS ALREADY_APPLIED [else RuntimeError on APPLIED]; LeaseRepo.touch_heartbeat(workspace_id) } then activity.heartbeat).',
  'DO: make the PRODUCTION defaults REAL (no faking no-op on the shipped path, per the LLM-client pattern): (1) assertLeaseAllocated default = a real impl that opens a transaction on the shared pool (tenantKysely(dsn) from CODEMASTER_PG_CORE_DSN) and runs transitionLease(tx, workspace_id, "ALLOCATED", "ALLOCATED", activity="clone_repo_into_workspace_activity", reason="state-assertion noop", clock) — assert ALREADY_APPLIED (StateDrift/RuntimeError propagate) — then LeaseRepo(tx).touchHeartbeat(workspace_id), all in the one txn. (2) heartbeat default = (phase) => Context.current().heartbeat(phase) from @temporalio/activity (real Temporal heartbeat; works inside the worker activity context). Tests inject no-op doubles for both. Register the clone activity in apps/backend/src/backend/worker/registry.ts (it is currently absent).',
  'TEST: update/extend the clone activity unit test so production-shaped deps are exercised with injected doubles (no-op assert + no-op heartbeat) AND add an integration test test/integration/workspace/clone_asserts_lease.integration.test.ts (disposable PG): allocate a lease → run the clone activity with the REAL assertLeaseAllocated (StubCloner for the git part) → it asserts ALREADY_APPLIED + bumps heartbeat_at; a workspace whose lease is NOT ALLOCATED → StateDrift.',
  'Return component="destub_clone", files_written, commands, all_green, notes: the real assert/heartbeat defaults, how the DSN/pool is resolved, the worker-registry wiring, that NO faking no-op remains on the clone production path, divergence risk.',
].join('\n')

const p3 = await agent(P3, { label: 'destub:clone', phase: 'DeStubClone', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL verifier for the workspace-lease de-stub. REFUTE that the real lease lifecycle matches the frozen Python + that the clone activity now uses a REAL (not no-op) lease assertion + heartbeat.',
  STYLE,
  'Built: ' + JSON.stringify({ p1: p1.component, p2: p2.component, p3: p3.component }).slice(0, 300),
  '1. FULL LIFECYCLE (disposable PG ' + PGDSN + '): allocate → an ALLOCATED core.workspace_leases row (+ the WorkspaceHandle/path); clone-assert → transitionLease(ALLOCATED→ALLOCATED)=ALREADY_APPLIED + heartbeat_at bumped (no event); release → RELEASE_REQUESTED then RELEASED (+ the dir removed + the WORKSPACE_* events). Drive the SAME sequence on the frozen Python (the real _lease_repo/_transition/allocate/release over the SAME disposable PG) and compare the row state at each step.',
  '2. STATE MACHINE: transitionLease from a drifted state (e.g. RELEASE_REQUESTED→ALLOCATED with from=ALLOCATED) → StateDrift on BOTH sides; a missing row → StateDrift; the timestamp columns + release_requested_by set identically; the biconditional CHECKs never violated.',
  '3. NO NO-OP ON THE CLONE PATH: the clone activity production default for assertLeaseAllocated is the REAL DB-backed impl (grep — no-op only in test files); a non-ALLOCATED lease → the clone activity raises StateDrift.',
  '4. IDEMPOTENCY: a second allocate for the same run_id → ON CONFLICT no-op → find_active_by_run returns the same row (no duplicate).',
  '5. EVENTS: release emits WORKSPACE_RELEASE_REQUESTED + WORKSPACE_RELEASED to audit.workflow_events (or the events table) matching Python; the clone no-op assertion emits NOTHING.',
  'Run (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN=' + PGDSN + ' npx vitest run --no-file-parallelism <the new tests>) + check_clock_random; tsc clean. verdict=WEAK if the lifecycle/row-state diverges from Python, StateDrift conditions differ, the clone path keeps a no-op assertion, or events diverge; SOUND otherwise. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:workspace-lease', phase: 'Verify', schema: VERIFY_SCHEMA })

return { p1, p2, p3, verify }
