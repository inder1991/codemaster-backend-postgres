export const meta = {
  name: 'phase1-batch2',
  description: 'Port Phase-1 security subsystems trust-tier wrapping + output-safety/coercion 1:1, parity vs frozen Python',
  phases: [
    { title: 'Port', detail: 'trust_tier_wrapping (byte-parity) + output_safety/contract_coercion (coercion parity)' },
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
WORKING DIR: ${REPO}. ABSOLUTE paths. Bash cwd RESETS — prefix every command with \`cd ${REPO} && ...\`.
TS STYLE (ENFORCED — validate-fast = gates→lint→typecheck→test): ESM \`.js\` specifiers; \`type\` not \`interface\`; \`Array<T>\`; NO \`any\`; named exports; explicit return types on exported fns; \`import { type X }\`; snake_case filenames; camelCase locals, PascalCase types, CAPITALIZED consts.
IMPORTS: Node subpath aliases (package.json "imports"): \`#contracts/*\`, \`#platform/*\`, \`#backend/*\`. Cross-dir uses aliases; same-dir/sub-dir relative.
GATE: apps/backend/src/backend/** scanned by check_clock_random — NO raw Date.now/Math.random/node:crypto-random.
HARNESS: prefer the GENERIC oracle (test/parity/oracle.ts::assertParity + pyRef) for module-level pure fns returning JSON-safe data; build a DEDICATED driver (mirror tools/parity/run_redact_ref.py + a <sub>_oracle.ts) for class methods / constructor state / contract-class args / bare floats (the generic canonicalizer REJECTS non-integer numbers).
TEMPLATE: redact subsystem (commit 89691ed) — read apps/backend/src/backend/redact/*, test/parity/redact_*.ts, tools/parity/run_redact_ref.py, and a contract+parity pair.
GUARDRAILS: touch ONLY your subsystem's files. NO eslint --fix on the repo; NO git add/commit; NO database. Concurrent sibling agents (this batch AND another batch) port OTHER subsystems — if \`npx tsc -p tsconfig.json\` reports errors ONLY in files you did NOT create, note as concurrent-stream noise and proceed (YOUR files must be clean); scope eslint to YOUR files. Frozen source READ-ONLY at vendor/codemaster-py (venv .venv/bin/python). Reuse vendor/codemaster-py/tests/{fixtures,corpora}; author small fixtures only if none exist.
`

const SUBSYS = {
  trust_tier: {
    key: 'trust_tier', pymod: 'codemaster.security.injection_defense',
    spec: `SECURITY-CRITICAL input boundary — byte-parity is MANDATORY; ANY divergence from Python output is a finding.
Python source: ${REPO}/vendor/codemaster-py/codemaster/security/injection_defense.py. Entries (MODULE-LEVEL PURE → GENERIC oracle assertParity): \`wrap_untrusted(content: str) -> str\` and \`strip_privileged_tags(content: str) -> str\`, plus the STRIPPED_TAGS set + wrapper constants. Confirm via help(). Port to ${REPO}/apps/backend/src/backend/security/trust_tier_wrapping.ts.
The wrapper shape is EXACTLY \`<diff trust="untrusted">\` … \`</diff trust="untrusted">\` (non-standard closing tag carrying the attribute — Sprint-7 contract so a literal </diff> in untrusted text can't close the wrapper). Port _build_tag_stripper's regex over STRIPPED_TAGS 1:1 (Python re → JS RegExp; mind flags + case).
Test: test/parity/trust_tier_wrapping.parity.test.ts — fixtures: plain text; content embedding privileged tags (</diff trust="untrusted">, <manifest trust="untrusted">, <knowledge trust="trusted">, bare <diff>); nested/adjacent; unicode; empty string. Assert wrap_untrusted AND strip_privileged_tags byte-identical to Python on each. ALSO push 3-4 vendor/codemaster-py/tests/corpora/prompt_injection/*.yaml inputs (the closing-tag / smuggle entries) through wrap_untrusted and confirm the privileged-tag closers are stripped identically to Python.`,
  },
  output_safety: {
    key: 'output_safety', pymod: 'codemaster.llm.contract_coercion',
    spec: `PLAN DRIFT (confirmed by scout): \`coerce_for_contract\` lives in codemaster/llm/contract_coercion.py:172 — NOT output_safety.py. Port BOTH halves:
(a) coerce_for_contract (codemaster/llm/contract_coercion.py) → ${REPO}/apps/backend/src/backend/llm/contract_coercion.ts.
(b) OutputSafetyValidator (codemaster/security/output_safety.py) → ${REPO}/apps/backend/src/backend/security/output_safety.ts.
FIRST confirm both signatures via help(), and READ the frozen tests under vendor/codemaster-py/tests/ for coerce_for_contract + OutputSafetyValidator to determine the REAL acceptance — the plan's "coerce strips injection with 0.95 recall" example CONFLATES coercion with injection-stripping; figure out which module actually does what and port faithfully (coerce_for_contract is the LLM-output→contract coercion the Task-0.4 gate requires before model_validate; OutputSafetyValidator is the validation/secret-span pass).
coerce_for_contract(payload, contract, …) takes a CONTRACT CLASS arg → the generic oracle can't pass a class over JSON. Build a DEDICATED driver ${REPO}/tools/parity/run_output_safety_ref.py + test/parity/output_safety_oracle.ts that maps a contract-NAME string → the real Pydantic contract class. Registered LLM-output contracts (CLAUDE.md): WalkthroughV1, ReviewFindingV1, ReviewChunkResponseV1, ArbitrationIntentV1 — all already ported to #contracts/* (Zod). The TS coerceForContract must take the matching Zod contract.
Test: test/parity/output_safety.parity.test.ts — drive a corpus of MALFORMED LLM payloads (reuse vendor tests' malformed fixtures if present, e.g. tests/fixtures/malformed_llm_outputs; else author 5-6 covering over-length strings, wrong types, missing/extra keys, 1.0-vs-1 floats) through coerce on BOTH impls and assert byte-parity of the coerced output. If OutputSafetyValidator emits SecretFindingV1 spans, reuse #contracts/secret_detection.v1.js (ported in redact). Add whatever recall/validation acceptance the frozen tests actually enforce.`,
  },
}

phase('Port')

const portBrief = (s) => `Port the codemaster "${s.key}" subsystem 1:1 to TypeScript, parity-proven against the frozen Python (Phase-1 spine — replicate the redact template).
${STYLE}
SUBSYSTEM: ${s.key}.
${s.spec}

TDD: write the parity test FIRST → confirm RED → port to GREEN against the LIVE frozen Python. Then IN ${REPO}: \`npx vitest run <your test file(s)>\`, \`npx tsc -p tsconfig.json\` (your files clean; ignore concurrent-stream noise), \`npx eslint <your .ts files>\`, \`npx tsx scripts/gates/check_clock_random.ts\` (0 violations). All green.
Return: subsystem="${s.key}", files_written (absolute), new_contracts, every command+pass/fail, all_green, notes (confirmed entry-point signatures, plan-vs-code drift, harness choice + why, fixtures, anything deferred).`

const piped = await pipeline(
  ['trust_tier', 'output_safety'].map((k) => SUBSYS[k]),
  (s) => agent(portBrief(s), { label: `port:${s.key}`, phase: 'Port', schema: BUILD_SCHEMA }),
  (portRes, s) => {
    const VERIFY_BRIEF = `You are an ADVERSARIAL parity verifier for the just-ported "${s.key}" subsystem. REFUTE that it matches the frozen Python. ${s.key === 'trust_tier' ? 'This is a SECURITY boundary — byte-parity is mandatory; any divergence is a finding.' : ''} Default skeptical.
${STYLE}
Port result: ${JSON.stringify(portRes).slice(0, 900)}

Independently (drive LIVE frozen Python directly AND the TS via a throwaway tsx script ${REPO}/tools/parity/_${s.key}_scratch.ts — DELETE after; do NOT git-add):
1. Confirm the entry-point signature(s) the port claims match the real frozen ${s.pymod} (help()).
2. Pick 5-6 representative + adversarial inputs ${s.key === 'trust_tier' ? '(embedded </diff trust="untrusted"> closer, <manifest trust="untrusted">, nested privileged tags, a real prompt_injection corpus entry, unicode, empty)' : '(over-length string field, wrong-typed field, missing required, extra key, 1.0-vs-1 float, a real malformed-LLM-output fixture)'}; drive BOTH frozen Python and TS; compare outputs ${s.key === 'trust_tier' ? 'byte-for-byte' : 'field-by-field (floats with tolerance)'}. Report any divergence with exact input + py-vs-ts.
3. Confirm the parity test is REAL (imports the actual TS module, awaits the oracle/driver spawning frozen venv python, asserts equality — not skipped/.todo/hard-coded). Run \`cd ${REPO} && npx vitest run <the subsystem's test file>\` and read the pass count.
4. GATE: \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations.
${s.key === 'output_safety' ? '5. Confirm the coerce_for_contract port + its driver actually exercise REAL contract classes (not stubs) on BOTH sides, and that the malformed→coerced output matches Python including the bare-float/over-length normalization.' : '5. Confirm strip_privileged_tags removes EVERY tag in STRIPPED_TAGS identically to Python (probe each tag).'}

verdict=DRIFT if TS≠Python on any probed input OR the test is vacuous; FAITHFUL only if all hold. Give exact reproduction for any failure. Clean up scratch files.`
    return agent(VERIFY_BRIEF, { label: `verify:${s.key}`, phase: 'Verify', schema: VERIFY_SCHEMA })
      .then((v) => ({ subsystem: s.key, port: portRes, verify: v }))
  },
)

const out = {}
for (const r of piped) {
  if (r) out[r.subsystem] = r
}
return out
