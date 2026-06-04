export const meta = {
  name: 'phase1-cost',
  description: 'Port the cost-cap enforcer (int-cents + Postgres advisory locks + SELECT FOR UPDATE) — Tier-B integration vs real Postgres',
  phases: [
    { title: 'Port', detail: 'PostgresCostCapEnforcer + InMemoryCostCapEnforcer + CostCapDecision contract + integration test' },
    { title: 'Verify', detail: 'adversarial: caps enforced, int-cents (no float/Decimal), advisory-lock serialization' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const DSN = 'postgresql://postgres:postgres@localhost:5434/codemaster'

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['files_written', 'commands', 'all_green', 'notes'],
  properties: {
    files_written: { type: 'array', items: { type: 'string' } },
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
    test_is_real: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = `
WORKING DIR: ${REPO}. ABSOLUTE paths. Bash cwd RESETS — prefix every command with \`cd ${REPO} && ...\`.
TS STYLE (ENFORCED — validate-fast = gates→lint→typecheck→test): ESM \`.js\` specifiers; \`type\` not \`interface\`; \`Array<T>\`; NO \`any\`; named exports; explicit return types; \`import { type X }\`; no unused vars; snake_case filenames.
IMPORTS: Node subpath aliases \`#contracts/*\`, \`#platform/*\`, \`#backend/*\`; cross-dir aliases, same-dir relative.
GATE: apps/backend/src/backend/** scanned by check_clock_random — NO raw Date.now/Math.random/node:crypto-random.
DATABASE: a DISPOSABLE Postgres is ALREADY RUNNING with the migrations applied — DSN \`${DSN}\` (db "codemaster", 129 tables incl. telemetry.cost_daily + seeded global/platform_config). NEVER touch any other DB. Integration tests connect here via \`pg\` Pool; clean up rows you insert (use a unique installation_id per test, or wrap in a transaction you roll back). The pg Pool is a dev dependency already installed.
GUARDRAILS: touch ONLY your files. NO eslint --fix on the repo; NO git add/commit. You are the ONLY workflow running; \`npx tsc -p tsconfig.json\` should be clean. Frozen source READ-ONLY at vendor/codemaster-py (venv .venv/bin/python).
RUN BEFORE RETURNING (all must pass): \`cd ${REPO} && CODEMASTER_PG_CORE_DSN="${DSN}" npx vitest run <your test(s)>\`, \`npx tsc -p tsconfig.json\`, \`npx eslint <your .ts files>\`, \`npx tsx scripts/gates/check_clock_random.ts\`. Do NOT report all_green:true unless every one passed.
`

phase('Port')

const PORT = `Port the cost-cap enforcer 1:1 to TypeScript (Tier-B — integer-cents arithmetic + Postgres advisory locks + SELECT FOR UPDATE against a REAL Postgres).
${STYLE}
READ the frozen source FULLY: ${REPO}/vendor/codemaster-py/codemaster/cost/enforcer.py. Confirm signatures via help(). Port to ${REPO}/apps/backend/src/backend/cost/enforcer.ts. SCOUT the exact schema of telemetry.cost_daily and WHERE the caps come from (global_config / platform_config — query the live disposable DB to see seeded cap rows + the table columns) so the port reads them identically.

Port EXACTLY (this is the spine cost gate, security/billing-critical):
- The errors: BedrockBudgetExceededError, CostCapLockTimeoutError.
- The CostCapDecision contract (cents_spent_today_global / cents_spent_today_org / cents_estimated — all non-negative INTEGERS). Port to a Zod contract libs/contracts/src/cost_cap_decision.v1.ts (z.number().int().nonnegative()) if it's a Pydantic contract in the frozen source; mirror its shape + a parity test if practical.
- PostgresCostCapEnforcer: async checkOrRaise({ installationId, estimatedCents }) — reads today's spend (global + per-org) under a Postgres ADVISORY LOCK (pg_advisory_xact_lock or the exact lock the Python uses — preserve the lock KEY derivation) + SELECT ... FOR UPDATE on telemetry.cost_daily, compares estimated+spent vs the cap, raises BedrockBudgetExceededError when exceeded (preserve the reason/scope/scope_id fields). async recordCallCost({ installationId, costCents, estimatedCents }) — upserts the daily row, adding cost_cents. ALL arithmetic is INTEGER cents — NO float, NO Decimal, no division that introduces fractions.
- InMemoryCostCapEnforcer (simpler, no DB/locks) for unit coverage.
- Use the pg Pool; the pool must be passed in / memoized (do NOT create a pool per call — ADR-0062). Take a clock injection point if the Python reads "today" from a clock (route through #platform clock seam; the gate bans raw Date) — confirm how Python derives "today" (UTC date) and mirror it.

Tests:
- ${REPO}/test/integration/cost/enforcer.integration.test.ts — against the disposable PG (DSN above). Allows a call under the cap; raises BedrockBudgetExceededError when the global (and per-org) cap is exceeded; recordCallCost accumulates integer cents and a subsequent checkOrRaise sees the new spend; concurrent checkOrRaise calls serialize via the advisory lock (no double-spend past the cap). Use a unique installation_id per test + clean up. Mark/locate under test/integration so it's clearly DB-gated.
- ${REPO}/test/unit/cost/enforcer.test.ts — InMemoryCostCapEnforcer: under/over cap, integer-cents accumulation (assert no fractional cents).

TDD where practical. Return files_written, every command+pass/fail (incl. the CODEMASTER_PG_CORE_DSN-prefixed vitest), all_green, notes (cost_daily schema + cap source as found, the advisory-lock key derivation, how "today" is derived, int-cents proof).`

const port = await agent(PORT, { label: 'port:cost', phase: 'Port', schema: BUILD_SCHEMA })
const verify = await agent(`ADVERSARIAL verifier for the just-ported cost-cap enforcer (billing/budget gate). REFUTE that it enforces caps correctly with integer-cents arithmetic and lock serialization.
${STYLE}
Port: ${JSON.stringify(port).slice(0, 800)}
Independently (drive the disposable PG at ${DSN} + the TS via a throwaway ${REPO}/tools/parity/_cost_scratch.ts — DELETE after, no git-add):
1. Under cap → allows; AT cap boundary (spent + estimated == cap, and == cap+1) → confirm the exact boundary behavior matches the frozen Python (read enforcer.py — is it > or >=?). Drive the frozen Python enforcer against the SAME PG for a boundary case and compare the decision.
2. INTEGER cents: confirm no float/Decimal anywhere — spend accumulation of odd cents (1 + 2 + ... ) stays exact; assert the stored telemetry.cost_daily value is an integer.
3. Advisory-lock serialization: fire 2 concurrent checkOrRaise+record sequences that would together exceed the cap; confirm they serialize and the cap is not breached (no lost-update double-spend).
4. recordCallCost upsert: first call inserts the daily row, second accumulates; the (installation_id, date) keying matches Python.
5. Test is REAL: open the integration test — it connects to a real PG and asserts allow/raise (not mocked/vacuous). Run \`cd ${REPO} && CODEMASTER_PG_CORE_DSN="${DSN}" npx vitest run test/integration/cost/enforcer.integration.test.ts test/unit/cost/enforcer.test.ts\`.
6. \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations.
verdict=WEAK if a cap can be breached / arithmetic drifts / lock doesn't serialize / boundary differs from Python / test is vacuous; SOUND only if all hold. Exact reproduction for failures. Clean up scratch + any rows you inserted.`, { label: 'verify:cost', phase: 'Verify', schema: VERIFY_SCHEMA })

return { cost: { port, verify } }
