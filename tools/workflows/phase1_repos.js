export const meta = {
  name: 'phase1-repos',
  description: 'Port the core-loop spine Kysely repos (parallel fan-out) — real-DB integration tests, tenancy-wired, pool-memoized',
  phases: [
    { title: 'Port', detail: 'one agent per spine repo: scout → Kysely port → DB-integration test' },
    { title: 'Audit', detail: 'cross-cutting: tenancy plugin wired, pool memoized (ADR-0062), pgvector/JSONB idioms, tests real' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const DSN = 'postgresql://postgres:postgres@localhost:5434/codemaster'

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['repo', 'files_written', 'commands', 'all_green', 'notes'],
  properties: {
    repo: { type: 'string' },
    files_written: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'passed'], properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } } } },
    all_green: { type: 'boolean' }, notes: { type: 'string' },
  },
}
const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'checks', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['SOUND', 'WEAK', 'INCONCLUSIVE'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = `
WORKING DIR: ${REPO}. ABSOLUTE paths. Bash cwd RESETS — prefix every command with \`cd ${REPO} && ...\`.
TS STYLE (ENFORCED — validate-fast = gates→lint→typecheck→test): ESM \`.js\` specifiers; \`type\` not \`interface\`; \`Array<T>\`; NO \`any\`; named exports; explicit return types; \`import { type X }\`; no unused vars; snake_case filenames.
IMPORTS: Node subpath aliases \`#contracts/*\`, \`#platform/*\`, \`#backend/*\`; cross-dir aliases, same-dir relative.
DATABASE: a DISPOSABLE Postgres is ALREADY RUNNING with migrations applied — DSN \`${DSN}\` (db "codemaster", 129 tables). NEVER touch any other DB. Integration tests go under test/integration/domain/repos/ and MUST use the shared gate: \`import { describeDb, INTEGRATION_DSN } from "../../../_db.js"\` (path-adjust the ../ depth) — wrap the suite in \`describeDb(...)\` and guard pool creation on INTEGRATION_DSN, so the test SKIPS when no DSN is set (validate-fast must stay green without a DB). Do NOT hard-default the DSN. Clean up rows (unique installation_id per test). The pg Pool is installed.
PRIMITIVES TO USE: the tenancy Kysely plugin at #platform/db/tenancy_plugin.js (TenancyPlugin) — your repo's Kysely instance MUST install it so installation_id scoping is enforced; pass installation_id on every tenant-scoped query. Memoize the pg Pool + Kysely instance (ADR-0062 — never per-call). Ported contracts are at #contracts/*. Idioms to preserve from the frozen Python (memories): pgvector binds use CAST(:qvec AS vector) text-bind not a JS array; JSONB reads cast ::text in SELECT + CAST(:x AS JSONB) on write.
GATE: apps/backend/src/backend/** scanned by check_clock_random — route wall-clock/random through #platform seams.
GUARDRAILS: touch ONLY your repo's files (its repo.ts + its integration test + any small contract it needs). NO eslint --fix on the repo; NO git add/commit. You are the ONLY workflow running; \`npx tsc -p tsconfig.json\` should be clean. Frozen source READ-ONLY at vendor/codemaster-py (venv .venv/bin/python).
RUN BEFORE RETURNING (all must pass): \`cd ${REPO} && CODEMASTER_PG_CORE_DSN="${DSN}" npx vitest run <your integration test>\`, \`npx tsc -p tsconfig.json\`, \`npx eslint <your .ts files>\`, \`npx tsx scripts/gates/check_clock_random.ts\`. Do NOT report all_green:true unless every one passed.
`

const REPOS = [
  { key: 'review_findings', pysrc: 'review_findings_repo.py', table: 'core.review_findings' },
  { key: 'review_walkthroughs', pysrc: 'review_walkthroughs_repo.py', table: 'core.review_walkthroughs' },
  { key: 'review_policy_bundles', pysrc: 'review_policy_bundles_repo.py', table: 'core.review_policy_bundles' },
  { key: 'fix_prompt', pysrc: 'fix_prompt_repo.py', table: 'core.fix_prompts (confirm)' },
  { key: 'code_owners', pysrc: 'code_owners_repo.py', table: 'core.code_owner_rules (confirm)' },
  { key: 'review_tool_runs', pysrc: 'review_tool_runs_repo.py', table: 'core.review_tool_runs (confirm)' },
  { key: 'pr_files', pysrc: 'pr_files_repo.py', table: 'core.pr_files (confirm)' },
]

phase('Port')

const portBrief = (r) => `Port the ${r.key} repo 1:1 to a Kysely repo with real-DB integration tests (Phase-1 data layer).
${STYLE}
SUBSYSTEM: ${r.key}. Python source: ${REPO}/vendor/codemaster-py/codemaster/domain/repos/${r.pysrc} (READ FULLY — confirm every public method + its SQL). Target table: ${r.table} (CONFIRM the actual schema by querying the live disposable DB: \`docker exec cm-phase1-pg psql -U postgres -d codemaster -c "\\d ${r.table.split(' ')[0]}"\` or via psql over the DSN).
Port to ${REPO}/apps/backend/src/backend/domain/repos/${r.key}_repo.ts — 1:1 method-for-method. Preserve: installation_id filtering on every tenant-scoped query (and install the #platform/db tenancy plugin on the Kysely instance); the exact SQL semantics (upsert/conflict, ordering, JSONB ::text read-cast + CAST(:x AS JSONB) write, pgvector CAST(:v AS vector) text-bind if any vector columns); integer/enum/timestamp handling. Memoize the pool+Kysely (ADR-0062). If the repo needs a contract not yet ported, port it to #contracts with a parity test.
Test ${REPO}/test/integration/domain/repos/${r.key}_repo.integration.test.ts (describeDb gate per the convention) — round-trip every public method against the disposable PG: insert/persist then read-back equals; tenant isolation (a query for installation A does not see B's rows); upsert/conflict idempotency; ordering; any JSONB/vector column round-trips byte-faithfully. Unique installation_id per test; clean up.
TDD where practical. Return repo="${r.key}", files_written, every command+pass/fail (incl. the CODEMASTER_PG_CORE_DSN-prefixed vitest), all_green, notes (confirmed schema + methods, idioms used, tenancy wiring, any contract ported, anything deferred).`

const ports = await pipeline(
  REPOS,
  (r) => agent(portBrief(r), { label: `port:${r.key}`, phase: 'Port', schema: BUILD_SCHEMA }),
)

const summary = ports.filter(Boolean).map((p) => ({ repo: p.repo, all_green: p.all_green, files: p.files_written }))

phase('Audit')
const audit = await agent(`Cross-cutting AUDIT of the just-ported spine Kysely repos. Verify the data layer is sound across all of them.
${STYLE}
Ports: ${JSON.stringify(summary).slice(0, 1500)}
Independently check (you MAY query the disposable PG at ${DSN} + run the tests):
1. TENANCY WIRED: every repo that touches a tenant-scoped table installs the #platform/db tenancy plugin on its Kysely instance AND filters installation_id — grep each repo + spot-run a query without installation_id to confirm it's refused (TenancyViolation) where expected.
2. POOL MEMOIZED (ADR-0062): no repo creates a pg Pool or Kysely instance per-call — pool/instance is module/constructor-scoped. grep for \`new Pool(\` / \`new Kysely(\` inside methods (a smell).
3. IDIOMS: JSONB columns read via ::text cast (not raw — asyncpg/pg deserializes JSONB to object, breaking string contracts); JSONB writes via CAST(:x AS JSONB); any vector column binds via CAST(:v AS vector) text-bind not a JS array.
4. TESTS REAL + GATED: each integration test uses describeDb (skips without DSN) and asserts real round-trips (not vacuous). Run \`cd ${REPO} && CODEMASTER_PG_CORE_DSN="${DSN}" npx vitest run test/integration/domain/repos/\` and read the pass count; THEN run \`cd ${REPO} && npx vitest run test/integration/domain/repos/\` (NO DSN) and confirm they all SKIP (validate-fast stays green without a DB).
5. \`cd ${REPO} && npx tsc -p tsconfig.json\` clean; \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations; \`npx tsx scripts/gates/check_tenant_scoped_raw_sql.ts\` (the raw-SQL tenancy gate) — note any new findings on the repo files.
verdict=WEAK if any repo misses tenancy/pool-memoization/idioms or a test is vacuous/not-gated; SOUND only if all hold. List per-repo issues. Do NOT git-add anything.`, { label: 'audit:repos', phase: 'Audit', schema: AUDIT_SCHEMA })

return { ports, audit }
