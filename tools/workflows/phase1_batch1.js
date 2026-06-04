export const meta = {
  name: 'phase1-batch1',
  description: 'Port Phase-1 Tier-A pure subsystems chunking + policy + model-router 1:1, byte-parity vs frozen Python',
  phases: [
    { title: 'Port', detail: 'one agent per subsystem: scout → contract(s) → port → parity harness → green' },
    { title: 'Verify', detail: 'per-subsystem adversarial parity refutation vs live frozen Python' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['subsystem', 'files_written', 'commands', 'all_green', 'notes'],
  properties: {
    subsystem: { type: 'string' },
    files_written: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'passed'], properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } } } },
    all_green: { type: 'boolean' },
    new_contracts: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['subsystem', 'verdict', 'checks', 'issues'],
  properties: {
    subsystem: { type: 'string' },
    verdict: { type: 'string', enum: ['FAITHFUL', 'DRIFT', 'INCONCLUSIVE'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    test_is_real: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = `
WORKING DIR: ${REPO}. ABSOLUTE paths. Bash cwd RESETS between calls — prefix every command with \`cd ${REPO} && ...\`.
TS STYLE (ENFORCED — validate-fast = gates→lint→typecheck→test): ESM \`.js\` specifiers; \`type\` not \`interface\`; \`Array<T>\` not \`T[]\`; NO \`any\` (use \`unknown\`); named exports; explicit return types on exported fns; \`import { type X }\`; snake_case filenames; camelCase locals, PascalCase types, CAPITALIZED consts.
IMPORTS: Node subpath aliases (package.json "imports"): \`#contracts/*\`→libs/contracts/src/*, \`#platform/*\`→libs/platform/src/*, \`#backend/*\`→apps/backend/src/backend/*. Cross-dir uses aliases; same-dir/sub-dir relative.
GATE: apps/backend/src/backend/** is scanned by check_clock_random — NO raw Date.now/Math.random/node:crypto-random; route any randomness through #platform randomness seam.
PARITY HARNESS: prefer the EXISTING generic oracle (test/parity/oracle.ts::assertParity + pyRef) when your Python entry point is a MODULE-LEVEL pure function returning JSON-safe data. Build a DEDICATED driver (mirror tools/parity/run_random_ref.py + a test/parity/<sub>_oracle.ts, like the redact subsystem did) ONLY when the entry is a CLASS METHOD, needs constructor state, or returns BARE FLOATS (the generic canonicalizer in test/parity/canonical.ts REJECTS non-integer numbers — strip/he­x-compare floats like the contract + redact tests do).
TEMPLATE: the redact subsystem (commit 89691ed) is the worked reference — read apps/backend/src/backend/redact/*, test/parity/redact_*.ts, tools/parity/run_redact_ref.py, and a contract+parity pair (libs/contracts/src/tool_status.v1.ts + test/contracts/tool_status.v1.parity.test.ts).
GUARDRAILS: touch ONLY your subsystem's files (your apps/backend/<dir>/, your test files, your new contracts, your driver). NO eslint --fix on the repo; NO git add/commit; NO database. Concurrent sibling agents are porting OTHER subsystems — if \`npx tsc -p tsconfig.json\` reports errors ONLY in files you did NOT create, note them as concurrent-stream noise and proceed (YOUR files must be clean); scope eslint to YOUR files. Frozen source-of-truth READ-ONLY at vendor/codemaster-py (venv .venv/bin/python = CPython 3.14). Fixtures: reuse vendor/codemaster-py/tests/{fixtures,corpora} where they exist; author small JSON fixtures under test/fixtures/<sub>/ only if none exist.
`

// ── per-subsystem specs ──────────────────────────────────────────────────────────────────────────
const SUBSYS = {
  chunking: {
    key: 'chunking', dir: 'apps/backend/src/backend/chunking', tsfile: 'markdown_chunker.ts',
    pymod: 'codemaster.chunking.markdown_chunker', pysrc: 'codemaster/chunking/markdown_chunker.py',
    spec: `Entry: \`chunk_markdown(relative_path: str, body: str, target_chars: int) -> tuple[MarkdownChunkV1, ...]\` — confirm via \`(cd vendor/codemaster-py && .venv/bin/python -c "import ${'codemaster.chunking.markdown_chunker'} as m; help(m.chunk_markdown)")\`. MODULE-LEVEL PURE → use the GENERIC oracle (assertParity). The MarkdownChunkV1 contract is ALREADY ported (#contracts/markdown_chunk.v1.js) and the UUIDv5 chunk_id helper is already in libs/contracts (grep for computeChunkId / sha256 — REUSE it, do not re-derive).
CRITICAL EDGE (invariant #15 foundation): chunk_id = UUIDv5 over f"{path}\\n{start}\\n{end}\\n{sha256(body).hexdigest()}". Body is decoded in Python with errors="replace" — your TS must produce a BYTE-IDENTICAL chunk_id on INVALID-UTF-8 input (TextDecoder("utf-8") replacement-char behavior vs Python errors="replace"). Add an explicit invalid-UTF-8 parity test (bytes 0xFF 0xFE embedded) — non-negotiable; downstream evidence_id depends on it.
treesitter/code chunker: confirm whether a separate code chunker is in this module's scope; if it needs native tree-sitter bindings (a new heavy dep), DEFER it (note clearly) and port only the markdown chunker this batch.
Test: test/parity/chunking.parity.test.ts — author/locate fixtures (reuse vendor/codemaster-py/tests/fixtures if a chunking corpus exists; else 4-6 small {relative_path, body, target_chars} JSON cases incl. headings, code fences, oversized sections) + the invalid-UTF-8 chunk_id case.`,
  },
  policy: {
    key: 'policy', dir: 'apps/backend/src/backend/policy', tsfile: 'rule_classifier.ts + rule_extractor.ts',
    pymod: 'codemaster.policy.rule_classifier', pysrc: 'codemaster/policy/{rule_classifier,rule_extractor}.py',
    spec: `Entries (MODULE-LEVEL PURE → generic oracle): \`infer_category(*, heading: str, body: str) -> RuleCategory\`, \`infer_intent(*, body: str) -> RuleIntent\` (codemaster/policy/rule_classifier.py), \`extract_rules(doc: GuidelineFileV1) -> tuple[ExtractedRuleV1, ...]\` (codemaster/policy/rule_extractor.py). Confirm each via help(). Port to apps/backend/src/backend/policy/{rule_classifier,rule_extractor}.ts.
Contracts: GuidelineFileV1 (#contracts/guideline_files.v1.js) + ExtractedRuleV1 (#contracts/extracted_rules.v1.js) are ALREADY ported. RuleCategory / RuleIntent are enums — confirm whether they're standalone or embedded in extracted_rules; if a NEW contract/enum is needed, port it to libs/contracts/src/ with a parity test (mirror tool_status). Translate the heuristic keyword tables 1:1 (Python lowercasing/word-boundary/ordering matter for byte-parity).
Test: test/parity/policy.parity.test.ts — category + intent + extract cases. Reuse vendor/codemaster-py/tests/fixtures/policy if present; else author small fixtures. Byte-parity on all (enum values + extracted-rule objects). If ExtractedRuleV1 carries a bare-float field, strip-and-range it per the contract-test convention.`,
  },
  model_router: {
    key: 'model_router', dir: 'apps/backend/src/backend/llm', tsfile: 'model_router.ts',
    pymod: 'codemaster.llm.model_router', pysrc: 'codemaster/llm/model_router.py',
    spec: `Entry: \`ModelRouter(policy_snapshot).route(purpose: str, prompt_chars: int, installation_id: UUID|None) -> RoutingDecisionV1\` — a CLASS METHOD reading an in-memory policy snapshot (no DB). Confirm via help(m.ModelRouter.route). Because it's a class method (constructor state) AND RoutingDecisionV1 likely carries a bare-float confidence_score, build a DEDICATED driver tools/parity/run_model_router_ref.py + test/parity/model_router_oracle.ts (mirror run_redact_ref.py / redact_oracle.ts): the driver constructs ModelRouter(policy) from a wire-passed policy snapshot and calls .route(...), returning the decision dict; floats compared with tolerance / excluded + range-asserted.
Contract: RoutingDecisionV1 — likely NOT yet ported (file_routing.v1 is different). Port it to libs/contracts/src/routing_decision.v1.ts (or the name matching contracts/<name>/v1.py — confirm the Python module path) + a parity test.
Port the resolution priority order EXACTLY: per-installation override → per-purpose override → per-size threshold → default (read the source; the tie-breaks + threshold comparisons are byte-significant). ADR-0060: role axis retained, purpose-selection shipped.
Test: test/parity/model_router.parity.test.ts — fixtures = policy snapshot + (purpose, prompt_chars, installation_id) cases covering each priority branch + threshold boundaries. Byte-parity on the routing decision (model id + reason; confidence handled as a float).`,
  },
}

// =================================================================================================
phase('Port')

const portBrief = (s) => `Port the codemaster "${s.key}" subsystem 1:1 to TypeScript, parity-proven byte-for-byte against the frozen Python (Phase-1 spine — replicate the redact template).
${STYLE}
SUBSYSTEM: ${s.key}. Python source: ${REPO}/vendor/${s.pysrc.replace('codemaster/', 'codemaster-py/codemaster/')}. Port TS into ${REPO}/${s.dir}/ (${s.tsfile}).
${s.spec}

TDD: write the parity test FIRST → confirm RED (module missing) → port to GREEN against the LIVE frozen Python. Then run, IN ${REPO}: \`npx vitest run <your test file(s)>\`, \`npx tsc -p tsconfig.json\` (your files clean; ignore concurrent-stream noise in files you didn't create), \`npx eslint <your .ts files>\`, \`npx tsx scripts/gates/check_clock_random.ts\` (0 violations). All green.

Return: subsystem="${s.key}", files_written (absolute), new_contracts (any contract files you added), every command + pass/fail, all_green, and notes (entry-point signature as confirmed, any plan-vs-code drift, harness choice generic-vs-dedicated + why, fixtures used, anything deferred).`

const portResults = {}
const order = ['chunking', 'policy', 'model_router']

const piped = await pipeline(
  order.map((k) => SUBSYS[k]),
  (s) => agent(portBrief(s), { label: `port:${s.key}`, phase: 'Port', schema: BUILD_SCHEMA }),
  (portRes, s) => {
    const VERIFY_BRIEF = `You are an ADVERSARIAL parity verifier for the just-ported "${s.key}" subsystem. REFUTE that it byte-matches the frozen Python. Default skeptical — a green test can be weak.
${STYLE}
Port result: ${JSON.stringify(portRes).slice(0, 900)}

Independently (drive the LIVE frozen Python directly AND the TS via a throwaway tsx script under ${REPO}/tools/parity/_${s.key}_scratch.ts — DELETE it after; do NOT git-add):
1. Confirm the entry-point signature the port claims matches the real frozen ${s.pymod} (help()).
2. Pick 4-6 representative inputs (incl. edge cases: ${s.key === 'chunking' ? 'invalid-UTF-8 body → chunk_id byte-identity; oversized section; empty body' : s.key === 'policy' ? 'ambiguous heading, empty body, multi-rule doc' : 'each priority branch — installation override, purpose override, size threshold boundary, default'}). Drive BOTH the frozen Python (cd vendor/codemaster-py && .venv/bin/python -c "...") and the TS module; compare outputs field-by-field. Report any divergence with exact input + py-vs-ts.
3. Confirm the parity test is REAL: it imports the actual TS module + awaits the oracle (spawns the frozen venv python), asserts equality (not skipped/.todo/hard-coded). Run \`cd ${REPO} && npx vitest run <the subsystem's test file>\` and read the pass count.
4. GATE: \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations.
${s.key === 'chunking' ? '5. chunk_id INVARIANT: independently compute UUIDv5 over f"{path}\\n{start}\\n{end}\\n{sha256(body)}" for an invalid-UTF-8 body in BOTH impls and confirm identical — this gates downstream evidence_id.' : ''}

verdict=DRIFT if TS≠Python on any probed input OR the test is vacuous; FAITHFUL only if all hold. Clean up scratch files.`
    return agent(VERIFY_BRIEF, { label: `verify:${s.key}`, phase: 'Verify', schema: VERIFY_SCHEMA })
      .then((v) => ({ subsystem: s.key, port: portRes, verify: v }))
  },
)

for (const r of piped) {
  if (r) portResults[r.subsystem] = r
}
return portResults
