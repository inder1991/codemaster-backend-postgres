export const meta = {
  name: 'phase1-tenancy',
  description: 'Port the tenancy hook (SQLAlchemy ORM → Kysely plugin) enforcing installation_id on TenantScoped tables',
  phases: [
    { title: 'Port', detail: 'KyselyTenancyPlugin + TenancyViolation + privileged_path escape + unit tests' },
    { title: 'Verify', detail: 'adversarial: every TenantScoped SELECT/UPDATE/DELETE without installation_id throws' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'

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
TS STYLE (ENFORCED — validate-fast = gates→lint→typecheck→test): ESM \`.js\` specifiers; \`type\` not \`interface\` (EXCEPT when implementing a library interface like Kysely's KyselyPlugin — then \`implements\`/object-literal is fine); \`Array<T>\`; NO \`any\` (use \`unknown\`); named exports; explicit return types on exported fns; \`import { type X }\` / \`import type\` when all names are types; no unused vars; snake_case filenames; camelCase locals, PascalCase types, CAPITALIZED consts.
IMPORTS: Node subpath aliases \`#contracts/*\`, \`#platform/*\`, \`#backend/*\`; cross-dir aliases, same-dir relative.
GATE: apps/backend/src/backend/** + libs/*/src/** scanned by check_clock_random — NO raw Date.now/Math.random/node:crypto-random; route randomness through #platform randomness seam.
GUARDRAILS: touch ONLY your files. NO eslint --fix on the repo; NO git add/commit; NO database (this is a query-AST plugin — unit-test by BUILDING queries and inspecting compiled SQL, no DB connection). You are the ONLY workflow running; \`npx tsc -p tsconfig.json\` should be fully clean (any error is yours). Frozen source READ-ONLY at vendor/codemaster-py.
RUN BEFORE RETURNING (all must pass): \`cd ${REPO} && npx vitest run <your test>\`, \`npx tsc -p tsconfig.json\`, \`npx eslint <your .ts files>\`, \`npx tsx scripts/gates/check_clock_random.ts\`. Do NOT report all_green:true unless every one passed.
`

phase('Port')

const PORT = `Port the tenancy isolation hook to a Kysely query plugin (SECURITY-CRITICAL — invariant #10 "default deny": any SELECT/UPDATE/DELETE on a table carrying installation_id MUST filter on it).
${STYLE}
READ the frozen source FULLY: ${REPO}/vendor/codemaster-py/codemaster/security/tenancy.py — understand: the TenantScoped marker, the do_orm_execute hook that walks SELECT/UPDATE/DELETE WHERE clauses for an installation_id filter, TenancyViolation (raised when missing), the cross_tenant_audit escape (session.info["cross_tenant_audit"]=True, only allowed inside @privileged_path), LEGACY_NON_TENANT_SCOPED_EXEMPTIONS, and the nullable-installation_id handling. Also read ${REPO}/scripts/gates/_registry.ts (TENANT_SCOPED_TABLES — the 46 schema-qualified tables; this is the canonical list — REUSE it, do not re-type).

This is a BEHAVIORAL port to a DIFFERENT ORM (Kysely, not SQLAlchemy), so it is NOT byte-parity against Python — the acceptance is the INVARIANT (a TenantScoped query without an installation_id filter is refused). No Python oracle. Kysely is 0.27.6.

CREATE the plugin (suggest ${REPO}/libs/platform/src/db/tenancy_plugin.ts — DB infra is platform-lib; confirm/choose a sensible path):
- \`export class TenancyViolation extends Error\` (name set).
- A canonical tenant-scoped registry: either import TENANT_SCOPED_TABLES from the gate registry, or (cleaner) MOVE the canonical Set into libs/platform/src/db/tenant_scoped_tables.ts and have scripts/gates/_registry.ts re-export from it (eliminate the duplicate source of truth — note this consolidation). Include the LEGACY_NON_TENANT_SCOPED_EXEMPTIONS + nullable-installation_id semantics from tenancy.py.
- \`export class TenancyPlugin implements KyselyPlugin\` (Kysely's plugin interface: transformQuery(args: PluginTransformQueryArgs): RootOperationNode + transformResult(args)). In transformQuery, walk the OperationNode (SelectQueryNode/UpdateQueryNode/DeleteQueryNode — use Kysely's node types / an OperationNodeVisitor or OperationNodeTransformer) to find the target table(s); if a target is in the tenant-scoped registry, verify the WHERE clause references the installation_id column; if not, THROW TenancyViolation — UNLESS the cross-tenant-audit escape is active.
- cross-tenant-audit escape: use AsyncLocalStorage (node:async_hooks) for the request-scoped flag (the analogue of session.info). \`export function privilegedPath(fn)\` wrapper + \`export function crossTenantAudit(reason, fn)\` that only works inside a privileged frame (mirror the Python @privileged_path + cross_tenant_audit_session refusal-outside-privileged-frame).
- Distinguish installation_id = :x from installation_id IS NULL (the Python comment: both contain the substring; the AST walk must check for an actual equality/binding predicate, not just column presence).

Test ${REPO}/test/unit/security/tenancy.test.ts (NO DB — build queries with a Kysely instance using a dummy dialect / .compile(), run them through the plugin's transformQuery): assert — SELECT/UPDATE/DELETE on a TenantScoped table (e.g. core.review_runs) WITHOUT installation_id → throws TenancyViolation; WITH \`where("installation_id","=", x)\` → passes; on a NON-scoped table → passes unmodified; installation_id IS NULL alone → still throws (not a real tenant filter); the cross_tenant_audit escape inside privilegedPath → passes; crossTenantAudit OUTSIDE a privileged frame → throws. Cover SELECT + UPDATE + DELETE.

Return files_written, every command+pass/fail, all_green, notes (Kysely plugin/AST approach, the registry-consolidation decision, any tenancy.py semantics you had to adapt to Kysely, the IS-NULL-vs-equality distinction handling).`

const port = await agent(PORT, { label: 'port:tenancy', phase: 'Port', schema: BUILD_SCHEMA })
const verify = await agent(`ADVERSARIAL verifier for the just-ported Kysely tenancy plugin (SECURITY boundary — invariant #10). REFUTE that it actually enforces installation_id on every TenantScoped query shape.
${STYLE}
Port: ${JSON.stringify(port).slice(0, 800)}
Independently (write a throwaway ${REPO}/tools/parity/_tenancy_scratch.ts — DELETE after, no git-add — that builds Kysely queries and runs them through the plugin):
1. For a sample of TenantScoped tables (core.review_runs, core.pull_request_reviews, + 2 more from the registry): SELECT / UPDATE / DELETE WITHOUT installation_id → MUST throw TenancyViolation. If any shape slips through, that's a security hole → WEAK.
2. WITH where("installation_id","=",x) → passes. installation_id IS NULL only → still throws (not a real filter). installation_id used only in a SELECT column / ORDER BY (not WHERE) → throws.
3. JOINs: a SELECT joining a TenantScoped table where only the OTHER table is filtered → must still require the scoped table's installation_id (probe whether the AST walk catches joined tenant tables).
4. Non-scoped table → unmodified/passes. cross_tenant_audit inside privilegedPath → passes; outside → throws.
5. Test is REAL: open test/unit/security/tenancy.test.ts — it builds real Kysely queries + asserts throws/passes (not vacuous). Run \`cd ${REPO} && npx vitest run test/unit/security/tenancy.test.ts\`.
6. \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations.
verdict=WEAK if any TenantScoped query without a real installation_id filter slips through OR the test is vacuous; SOUND only if enforcement holds across SELECT/UPDATE/DELETE/JOIN. Exact reproduction for any hole. Clean up scratch.`, { label: 'verify:tenancy', phase: 'Verify', schema: VERIFY_SCHEMA })

return { tenancy: { port, verify } }
