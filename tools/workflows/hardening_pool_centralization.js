export const meta = {
  name: 'hardening-pool-centralization',
  description: 'ADR-0062: centralize per-repo pg pools into ONE shared DbContext; refactor all 7 spine repos; guard test',
  phases: [
    { title: 'DbContext', detail: 'libs/platform/src/db/database.ts — getPool singleton + tenantKysely<T> + disposeAllPools + unit test' },
    { title: 'Refactor', detail: 'route all 7 repos + their integration tests through the shared DbContext (rip out per-repo caches)' },
    { title: 'Audit', detail: 'Task-2.14 guard: no repo constructs its own Pool; same DSN → one shared pool; integration green' },
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
const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'checks', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['CENTRALIZED', 'WEAK', 'INCONCLUSIVE'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = `
WORKING DIR: ${REPO}. ABSOLUTE paths. Bash cwd RESETS — prefix every command with \`cd ${REPO} && ...\`.
TS STYLE (ENFORCED — validate-fast = gates→lint→typecheck→test): ESM \`.js\` specifiers; \`type\` not \`interface\`; \`Array<T>\`; NO \`any\`; named exports; explicit return types; \`import { type X }\`; no unused vars; snake_case filenames.
IMPORTS: Node subpath aliases \`#contracts/*\`, \`#platform/*\`, \`#backend/*\`; cross-dir aliases, same-dir relative.
GATE: apps/backend/src/backend/** scanned by check_clock_random.
DATABASE: a DISPOSABLE Postgres is RUNNING with migrations applied — DSN \`${DSN}\` (db "codemaster"). Integration tests use the test/integration/_db.ts gate (describeDb / INTEGRATION_DSN) — they SKIP without the DSN. NEVER touch any other DB.
GUARDRAILS: touch ONLY your assigned files. NO eslint --fix on the repo; NO git add/commit. You are the ONLY workflow running; \`npx tsc -p tsconfig.json\` should be clean. Frozen source READ-ONLY at vendor/codemaster-py.
RUN BEFORE RETURNING (all must pass): \`cd ${REPO} && CODEMASTER_PG_CORE_DSN="${DSN}" npx vitest run <your test(s)>\`, \`npx tsc -p tsconfig.json\`, \`npx eslint <your .ts files>\`, \`npx tsx scripts/gates/check_clock_random.ts\`. Do NOT report all_green:true unless every passed.
`

// =================================================================================================
phase('DbContext')

const DBCTX = `Create the single shared DB connection factory (ADR-0062: ONE pg Pool per DSN across the whole process — today each repo memoizes its OWN pool, so N repo types → N pools → connection exhaustion on the kind cluster's ~100-conn budget).
${STYLE}
CREATE ${REPO}/libs/platform/src/db/database.ts:
- \`export function getPool(dsn: string, opts?: { max?: number }): Pool\` — a MODULE-LEVEL Map<string, Pool> memoizes ONE pg Pool per dsn (default max 8). This is THE singleton; the whole point is that every repo, regardless of type, shares it for a given DSN.
- \`export function tenantKysely<T>(dsn: string): Kysely<T>\` — build a Kysely<T> over PostgresDialect({ pool: getPool(dsn) }) with the TenancyPlugin (#platform/db/tenancy_plugin.js) installed. The Kysely is a lightweight wrapper over the SHARED pool (it does not open its own connections); memoize it per dsn in a second Map if cheap, but the POOL sharing is the invariant that matters. Repos call this for their typed schema.
- \`export async function disposeAllPools(): Promise<void>\` and \`export async function disposePool(dsn): Promise<void>\` — end the pool(s) + clear the maps (for test teardown / worker shutdown).
- Document: this is the ADR-0062 single-engine seam; repos MUST NOT construct their own Pool.
CREATE ${REPO}/test/unit/db/database.test.ts (no DB needed — Pool is lazy, doesn't connect until a query): assert getPool(dsn) === getPool(dsn) (same instance, memoized); getPool(dsnA) !== getPool(dsnB); tenantKysely<T>(dsn) returns a Kysely whose executor uses the SAME pool as getPool(dsn) (or at least that two tenantKysely calls for the same dsn share one pool — assert getPool identity before/after); disposePool removes it (next getPool returns a fresh instance). Use throwaway DSNs like "postgresql://u:p@localhost:1/db" (never connected).
Return component="dbcontext", files_written, commands, all_green, notes (the exact exported API — the Refactor agents depend on it: signatures of getPool/tenantKysely/disposeAllPools).`

const dbctx = await agent(DBCTX, { label: 'dbcontext', phase: 'DbContext', schema: BUILD_SCHEMA })

// =================================================================================================
phase('Refactor')

const refactorBrief = (repos) => `Refactor these spine repos to use the shared DbContext (just built) instead of their own per-repo pool caches. ADR-0062 — eliminate per-repo pools.
${STYLE}
DbContext API (from the just-built libs/platform/src/db/database.ts): ${JSON.stringify(dbctx).slice(0, 700)}
For EACH of these repos: ${repos.join(', ')} (files apps/backend/src/backend/domain/repos/<name>_repo.ts + test/integration/domain/repos/<name>_repo.integration.test.ts):
1. DELETE the repo's own module-level pool/kysely cache (POOL_BY_DSN / DB_BY_DSN / ENGINES / MEMOIZED / POOL_CACHE / KYSELY_CACHE — whatever it has) and any \`new Pool(\` it constructs.
2. Route its "get a Kysely for this DSN" through \`tenantKysely<RepoDb>(dsn)\` from #platform/db/database.js (which uses the shared getPool). Preserve the repo's existing public API + injection points (a constructor/factory that ACCEPTS a Kysely keeps doing so; only the DEFAULT/own-cache path changes to the shared factory). Keep the TenancyPlugin behavior (now provided centrally by tenantKysely — do not double-install).
3. Update its integration test to obtain the db via the shared factory (tenantKysely / getPool) and tear down via disposeAllPools()/disposePool() in afterAll (not its own pool.end on a private pool). Keep the describeDb gate + unique-installation_id-per-test + cleanup.
After refactoring YOUR repos, run (IN ${REPO}): \`CODEMASTER_PG_CORE_DSN="${DSN}" npx vitest run <your repos' integration tests>\` (all green), \`npx tsc -p tsconfig.json\` (your files clean; concurrent sibling agent refactors the OTHER repos — ignore tsc errors in files you didn't touch), \`npx eslint <your changed files>\`, \`npx tsx scripts/gates/check_clock_random.ts\`.
Return component="${repos.join('+')}", files_written, commands, all_green, notes (per repo: what cache was removed, injection preserved, integration green count).`

const [b1, b2] = await parallel([
  () => agent(refactorBrief(['review_findings', 'review_walkthroughs', 'review_policy_bundles', 'code_owners']), { label: 'refactor:b1', phase: 'Refactor', schema: BUILD_SCHEMA }),
  () => agent(refactorBrief(['fix_prompt', 'review_tool_runs', 'pr_files']), { label: 'refactor:b2', phase: 'Refactor', schema: BUILD_SCHEMA }),
])

// =================================================================================================
phase('Audit')

const AUDIT = `Audit the pool centralization (ADR-0062) + add the Task-2.14 guard test.
${STYLE}
Refactor results: b1=${JSON.stringify(b1).slice(0, 400)} | b2=${JSON.stringify(b2).slice(0, 400)}
1. CREATE the Task-2.14 guard test ${REPO}/test/gates/pool_memoization.test.ts (a static-source check — ts-morph or fs+regex over apps/backend/src/backend/domain/repos/*.ts): assert NO repo source constructs its own pool (no \`new Pool(\`) NOR its own per-DSN pool/kysely Map — they must all import from #platform/db/database.js. The shared DbContext file is the ONLY sanctioned \`new Pool(\` site. Make it ERROR (fail) if any repo regresses.
2. RUNTIME single-pool proof: write+run a throwaway ${REPO}/tools/parity/_pool_scratch.ts (DELETE after, no git-add) that constructs/uses two DIFFERENT repo types against the SAME dsn and asserts getPool(dsn) returns ONE shared Pool instance for both (the connection-exhaustion fix). Report the pool count.
3. grep apps/backend/src/backend/domain/repos/*.ts — confirm 0 \`new Pool(\` and 0 own per-DSN Maps remain (all 7 refactored).
4. Re-verify integration: \`cd ${REPO} && CODEMASTER_PG_CORE_DSN="${DSN}" npx vitest run test/integration/domain/repos/\` → all green (~50 tests); THEN without DSN they SKIP. Run \`npx tsc -p tsconfig.json\` clean, \`npx vitest run test/gates/pool_memoization.test.ts\` (your new guard) green, \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations.
verdict=WEAK if any repo still owns a pool, the same-DSN-one-pool invariant fails, or integration regressed; CENTRALIZED only if all 7 route through the shared DbContext + the guard passes + integration green. List per-repo issues. Clean up scratch.`

const audit = await agent(AUDIT, { label: 'audit:pools', phase: 'Audit', schema: AUDIT_SCHEMA })

return { dbctx, refactor: { b1, b2 }, audit }
