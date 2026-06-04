export const meta = {
  name: 'phase2-pr-mutex',
  description: 'Phase 2.11: lease-based PR review mutex (ADR-0064) — pg_advisory_xact_lock + lease TTL + partial-unique index, integration-tested',
  phases: [
    { title: 'Port', detail: 'AcquireResult contract + acquire/release pr_mutex + real-DB integration test' },
    { title: 'Verify', detail: 'adversarial: serialization, busy vs reclaim-on-expiry, one-live-mutex-per-PR, DB-clock lease' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const DSN = 'postgresql://postgres:postgres@localhost:5434/codemaster'

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
  'WORKING DIR: ' + REPO + '. ABSOLUTE paths. Bash cwd RESETS — prefix every command with (cd ' + REPO + ' && ...).',
  'TS STYLE (ENFORCED — validate-fast = gates→lint→typecheck→test): ESM .js import specifiers; type alias not interface; Array<T> not T[]; NO any (use unknown); named exports; explicit return types; import { type X }; no unused vars; snake_case filenames.',
  'IMPORTS: Node subpath aliases #contracts/*, #platform/*, #backend/*; cross-dir aliases, same-dir relative.',
  'DATABASE: a DISPOSABLE Postgres is RUNNING with migrations applied — DSN ' + DSN + ' (db codemaster; core.pr_review_mutex present). NEVER touch any other DB. Use the SHARED DbContext (#platform/db/database.js: getPool/tenantKysely) — do NOT construct your own Pool (the pool_memoization guard would fail). Integration tests under test/integration/** use test/integration/_db.ts (describeDb / INTEGRATION_DSN) — SKIP without the DSN.',
  'GATE: core.pr_review_mutex is TENANT_SCOPED — raw SQL on it must carry installation_id (the acquire queries do); the production-scoped raw-SQL gate scans your file.',
  'GUARDRAILS: touch ONLY your files. NO eslint --fix on the repo; NO git add/commit. You are the ONLY workflow running; tsc -p tsconfig.json should be clean. Frozen source READ-ONLY at vendor/codemaster-py (venv .venv/bin/python).',
  'RUN BEFORE RETURNING (all must pass): cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN="' + DSN + '" npx vitest run <your test(s)>; npx tsc -p tsconfig.json; npx eslint <your .ts files>; npx tsx scripts/gates/check_clock_random.ts; npx tsx scripts/gates/check_tenant_scoped_raw_sql.ts (stay 0 findings). Do NOT report all_green:true unless every passed.',
].join('\n')

phase('Port')

const PORT = [
  'Port the lease-based PR-review mutex 1:1 to TypeScript (Task 2.11, ADR-0064). DB-backed; integration-tested against a real Postgres.',
  STYLE,
  'READ FULLY: ' + REPO + '/vendor/codemaster-py/codemaster/concurrency/pr_mutex.py (230 lines) — port EVERY public function. Key design (confirm against the source):',
  '- pg_advisory_xact_lock(int4,int4) keyed via _advisory_keys((installation_id, repository_id, pr_number)) — TRANSACTION-SCOPED (auto-releases on commit/rollback), serializing concurrent acquires for the SAME PR. Port _advisory_keys EXACT key derivation (collision-resistant hash into two int4s, namespaced to avoid colliding with other advisory-lock usage) — read it precisely; the integration test must produce the SAME lock contention as Python.',
  '- The LEASE (lease_expires_at) is the liveness signal; _DEFAULT_LEASE_TTL = 30 minutes. M1: DB now() is the SINGLE lease authority (the clock param is RETAINED for call-site stability but NOT used for lease timestamps — lease_expires_at = now() + make_interval(secs => ttl) computed in SQL; do NOT use the injected clock for the lease). Mirror this exactly.',
  '- acquire_pr_review_mutex: take the advisory xact lock, SELECT the live row (released_at IS NULL) FOR UPDATE computing lease_valid (lease_expires_at > now()); if lease_valid return AcquireResult(acquired=false, holder_workflow_id=prior); else (expired/NULL lease = dead holder) UPDATE the old row SET released_at=now() (audit) then INSERT a fresh row (lease_expires_at = now()+ttl) and return AcquireResult(acquired=true, mutex_id). Partial-unique index uq_pr_review_mutex_live_pr (WHERE released_at IS NULL) enforces ONE live mutex per PR.',
  '- Port release_pr_review_mutex + any janitor/reaper / PrReviewMutexInvariantError that exist in the file (read the whole file).',
  'PORT TO:',
  '- ' + REPO + '/libs/contracts/src/acquire_result.v1.ts (or the name matching the Python contract module) — AcquireResult (Zod) + a parity test IF AcquireResult is a Pydantic BaseModel (it is). Confirm fields (acquired: bool, holder_workflow_id, mutex_id).',
  '- ' + REPO + '/apps/backend/src/backend/concurrency/pr_mutex.ts — the functions. Use the shared DbContext: a Kysely transaction (db.transaction()) OR a pg client from getPool(dsn) — the advisory xact lock + the FOR UPDATE + insert MUST run in ONE transaction on ONE connection. Raw SQL for pg_advisory_xact_lock + the queries (carry installation_id so the raw-SQL gate stays clean). The lease uses SQL now()/make_interval, NOT the JS clock. Preserve every query semantics 1:1.',
  'Test ' + REPO + '/test/integration/concurrency/pr_mutex.integration.test.ts (describeDb gate; seed installation+repository FK parents like the repo integration tests do): acquire on a fresh PR => acquired=true; second acquire same PR while lease valid => acquired=false with the prior holder; a DIFFERENT PR => acquired=true (independent); EXPIRED lease (insert a row with lease_expires_at in the past, or acquire with a tiny lease_ttl) => next acquire RECLAIMS (acquired=true, old row marked released_at); the partial-unique index allows only ONE live row per (install,repo,pr); release marks released_at. Unique installation_id per test + cleanup.',
  'Return component="pr_mutex", files_written, commands, all_green, notes (the _advisory_keys derivation, DB-clock-lease confirmation, transaction/connection approach, reclaim semantics).',
].join('\n')

const port = await agent(PORT, { label: 'port:pr-mutex', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL verifier for the lease-based PR mutex (Task 2.11). REFUTE that the serialization, lease, reclaim, and one-live-mutex invariant match the frozen Python.',
  STYLE,
  'Built: ' + JSON.stringify(port).slice(0, 600),
  'Independently (drive the disposable PG at ' + DSN + ' + the TS via a throwaway ' + REPO + '/tools/parity/_mutex_scratch.ts — DELETE after, no git-add):',
  '1. MUTUAL EXCLUSION: acquire a PR => acquired=true; a second acquire of the SAME PR (lease valid) => acquired=false carrying the first holder_workflow_id. Two acquires racing the SAME PR in parallel => exactly ONE wins (advisory xact lock + partial-unique index serialize). A DIFFERENT PR => independent acquired=true.',
  '2. RECLAIM-ON-EXPIRY: a row with an EXPIRED lease (lease_expires_at in the past) is dead — the next acquire RECLAIMS (acquired=true, new mutex_id) and the old row is marked released_at (audit-preserved, not deleted). A VALID (future) lease is NOT reclaimable (busy).',
  '3. ONE-LIVE-MUTEX INVARIANT: uq_pr_review_mutex_live_pr (partial-unique WHERE released_at IS NULL) makes a second live insert for the same (install,repo,pr) fail — never >1 live row per PR. After a race, query the live DB: any PR with >1 released_at IS NULL row must be 0.',
  '4. DB-CLOCK LEASE: lease timestamps come from SQL now()/make_interval, NOT the injected JS clock (the M1 invariant — avoids pod/DB skew). Confirm the port does not compute lease_expires_at in JS.',
  '5. _advisory_keys: the TS key derivation matches Python (same (int4,int4) for the same PR identity) so contention is identical — diff a few PR identities keys vs the frozen Python.',
  '6. Run: cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN="' + DSN + '" npx vitest run <the mutex integration test>; npx tsc -p tsconfig.json clean; npx tsx scripts/gates/check_clock_random.ts + check_tenant_scoped_raw_sql.ts clean.',
  'verdict=WEAK if mutual exclusion can be violated (>1 live holder), reclaim/busy diverges, the lease uses the JS clock, or _advisory_keys differs from Python; SOUND otherwise. Exact reproduction for failures. Clean up scratch + rows.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:pr-mutex', phase: 'Verify', schema: VERIFY_SCHEMA })

return { port, verify }
