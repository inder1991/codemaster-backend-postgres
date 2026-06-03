export const meta = {
  name: 'task-1-1-redact',
  description: 'Phase-1 template: port the redact subsystem (secret + PII detectors + redact_text) 1:1, corpus-recall + parity gated',
  phases: [
    { title: 'Foundation', detail: 'secret_detection + pii_redaction contracts, parity driver/oracle, output_redaction redactor' },
    { title: 'Detectors', detail: 'secret_detector + pii_redactor (regex ports) — recall ≥0.99/0.95 + parity vs Python' },
    { title: 'Verify', detail: 'adversarial: recall actually met, detector output matches Python per corpus entry, tests not vacuous' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['files_written', 'commands', 'all_green', 'notes'],
  properties: {
    files_written: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'passed'], properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } } } },
    all_green: { type: 'boolean' },
    recall: { type: 'string', description: 'measured recall over the corpus (e.g. "secrets 1.00, 73/73"), or n-a' },
    notes: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'checks', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['FAITHFUL', 'DRIFT', 'INCONCLUSIVE'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    secret_recall: { type: 'string' },
    pii_recall: { type: 'string' },
    tests_are_real: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = `
WORKING DIR: ${REPO}. ABSOLUTE paths. Bash cwd RESETS between calls — prefix every command with \`cd ${REPO} && ...\`.
TS STYLE (ENFORCED — validate-fast = gates→lint→typecheck→test): ESM \`.js\` specifiers; \`type\` not \`interface\`; \`Array<T>\` not \`T[]\`; NO \`any\` (use \`unknown\`); named exports; explicit return types on exported fns; \`import { type X }\`; snake_case filenames (leading \`_\` ok); camelCase locals, PascalCase types, CAPITALIZED consts.
IMPORTS: cross-dir lib imports use Node subpath aliases (package.json "imports"): \`#contracts/*\`→libs/contracts/src/*, \`#platform/*\`→libs/platform/src/*, \`#backend/*\`→apps/backend/src/backend/*. Same-dir/sub-dir stay relative.
GATE: apps/backend/src/backend/** is now scanned by check_clock_random — NO raw Date.now/Math.random/node:crypto-random; route any randomness through #platform randomness seam (the detectors/redactor need none).
GUARDRAILS: touch ONLY your assigned files; NO eslint --fix on the repo; NO git add/commit (orchestrator commits); NO database. Frozen Python source-of-truth: ${REPO}/vendor/codemaster-py (READ-ONLY; venv .venv/bin/python = CPython 3.14). Corpora live in the submodule (NOT vendored): vendor/codemaster-py/tests/corpora/{secrets,pii}/*.yaml — read from there. Mirror existing siblings before writing (test/parity/random_oracle.ts + tools/parity/run_random_ref.py for the harness; libs/contracts/src/tool_status.v1.ts + test/contracts/tool_status.v1.parity.test.ts for a contract+parity test).
`

// =================================================================================================
phase('Foundation')

const FOUNDATION_BRIEF = `Build the foundation for porting the codemaster "redact" subsystem (Phase-1 worked template): the two finding contracts, the parity driver/oracle, and the pure redactor.
${STYLE}

=== FILES 1-2: contracts (Zod ports; mirror an existing contract + its parity test exactly) ===
${REPO}/libs/contracts/src/secret_detection.v1.ts — SecretFindingV1 (Python contracts/secret_detection/v1.py): { schema_version: int default 1; kind: string min 1; snippet_redacted: string min 1; start_offset: int ≥0; end_offset: int ≥0; confidence: float 0..1 }. extra=forbid → Zod .strict(); frozen. Use z.number().int() for ints, plain z.number() for confidence, z.number().int().default(1) for schema_version (NOT z.literal).
${REPO}/libs/contracts/src/pii_redaction.v1.ts — PiiFindingV1 (contracts/pii_redaction/v1.py): same shape but { replacement: string min 1 } instead of snippet_redacted.
${REPO}/test/contracts/secret_detection.v1.parity.test.ts + ${REPO}/test/contracts/pii_redaction.v1.parity.test.ts — Pydantic↔Zod parity via pyRef (mirror test/contracts/tool_status.v1.parity.test.ts): validate+dump a full payload identically, defaults applied, REJECT out-of-range/missing/extra. NOTE: confidence is a bare float — the canonicalizer REJECTS bare floats, so strip confidence before the canonical compare and assert it structurally + range-reject (same pattern other contract tests use). pyModule = "contracts.secret_detection.v1" / "contracts.pii_redaction.v1".

=== FILE 3: ${REPO}/tools/parity/run_redact_ref.py — dedicated driver (mirror tools/parity/run_random_ref.py; cwd=submodule) ===
Drives the REAL frozen detectors + redactor. JSONL stdin→stdout, one op per line:
- {"id","op":"detect_secrets","text":"..."} → construct codemaster.security.pattern_secret_detector.PatternSecretDetector(); call .detect(text); emit {"id","ok":true,"findings":[ f.model_dump(mode="json") ... ]} (each: kind/snippet_redacted/start_offset/end_offset/confidence/schema_version).
- {"id","op":"detect_pii","text":"..."} → codemaster.security.regex_pii_redactor.RegexPiiRedactor(); call .redact(text) → (rewritten, findings); emit {"id","ok":true,"rewritten":"...","findings":[...]}.
- {"id","op":"redact","text":"...","findings":[{start_offset,end_offset,...}]} → reconstruct SecretFindingV1 from each dict; call codemaster.security.output_redaction.redact_text(text, findings); emit {"id","ok":true,"redacted_text":"...","spans_redacted":N}.
Wrap every op so an exception becomes {"id","ok":false,"err":...}; never crash the loop.

=== FILE 4: ${REPO}/test/parity/redact_oracle.ts — TS spawn/drive helper (mirror test/parity/random_oracle.ts) ===
spawn vendor/codemaster-py/.venv/bin/python tools/parity/run_redact_ref.py (cwd=submodule). Export: \`pyDetectSecrets(text): Promise<Array<Finding>>\`, \`pyDetectPii(text): Promise<{ rewritten: string; findings: Array<Finding> }>\`, \`pyRedact({ text, findings }): Promise<{ redactedText: string; spansRedacted: number }>\`, \`shutdownRedactRef(): void\`. (Finding = the dict shape from the driver.)

=== FILE 5: ${REPO}/apps/backend/src/backend/redact/output_redaction.ts — port output_redaction.py::redact_text (READ IT) ===
- \`export type RedactionResult = { redactedText: string; spansRedacted: number }\` (Python frozen dataclass {redacted_text, spans_redacted}; spans_redacted ≥0 — throw on negative in a factory or guard).
- \`const REDACTION_TOKEN = "[REDACTED]"\`.
- \`export function redactText(text: string, findings: ReadonlyArray<{ start_offset: number; end_offset: number }>): RedactionResult\` — EXACTLY mirror: collect (start,end) where end>start; merge overlapping (sort by (start,end); union when start ≤ lastEnd); if none → {text, 0}; else rebuild string replacing each merged span with the token; spansRedacted = merged.length. Pure; never mutates input. Port \`_merge_overlapping\` too (as a local helper).

=== FILE 6: ${REPO}/test/parity/redact_redactor.parity.test.ts (afterAll(shutdownRedactRef)) ===
Byte-parity of redactText vs Python redact_text given IDENTICAL findings: several cases — empty findings (text unchanged, 0 spans), one span, multiple, OUT-OF-ORDER findings, OVERLAPPING/adjacent spans (unioned once), span at start / at end / whole-string, zero-width (end==start, ignored). For each: pyRedact({text, findings}) and assert redactText(text, findings) === {redactedText: py.redactedText, spansRedacted: py.spansRedacted}.

TDD: write redact_redactor.parity.test.ts FIRST (RED — redactText missing), implement to GREEN against live Python. Then \`cd ${REPO} && npx vitest run test/parity/redact_redactor.parity.test.ts test/contracts/secret_detection.v1.parity.test.ts test/contracts/pii_redaction.v1.parity.test.ts\`, \`npx tsc -p tsconfig.json\`, \`npx eslint <your .ts files>\`, \`npx tsx scripts/gates/check_clock_random.ts\` (0 violations). All green.

Return files_written, every command+pass/fail, all_green, notes.`

const foundationRes = await agent(FOUNDATION_BRIEF, { label: 'contracts + harness + redactor', phase: 'Foundation', schema: BUILD_SCHEMA })

// =================================================================================================
phase('Detectors')

const detectorBrief = (which) => `Port the codemaster ${which.name} 1:1 to TypeScript and prove it matches the frozen Python over the adversarial corpus (Phase-1 redact subsystem).
${STYLE}

Foundation is done (contracts at #contracts/${which.contract}.v1.js; parity harness at test/parity/redact_oracle.ts exporting ${which.oracleFn}): ${'${FOUNDATION_SUMMARY}'}

READ the source: ${REPO}/vendor/codemaster-py/codemaster/security/${which.pySrc} — port EVERY regex + the ${which.method} logic (ordering, dedup, span offsets, ${which.extra}). Python→JS regex gotchas to handle: \`\\b\` same; negative lookahead/lookbehind \`(?!..)\`/\`(?<!..)\` supported in Node 22; re.MULTILINE→/m, re.DOTALL→/s; use \`text.matchAll(/.../g)\` for offsets via match.index; \`re.finditer\`→matchAll. Translate each pattern to an equivalent JS RegExp and VERIFY against the corpus + Python output (don't guess — diff vs the driver).

CREATE ${REPO}/apps/backend/src/backend/redact/${which.tsFile} — \`export ${which.signature}\` returning ${which.returns} (import the finding type from #contracts/${which.contract}.v1.js). Faithfully port confidence values, kind strings, ${which.extra}.

CREATE ${REPO}/test/parity/${which.testFile} (afterAll(shutdownRedactRef); read corpus from vendor/codemaster-py/tests/corpora/${which.corpus}/*.yaml via js-yaml — each entry {id,category,input,expected_detected,expected_category}). Assert:
1. RECALL GATE (the named CI floor): over positives (expected_detected===true), fraction where your detector finds ≥1 match ≥ ${which.recall}. Compute + assert it.
2. PARITY (the faithful-port check, STRONGER): for EVERY corpus entry, your detector's findings match the Python driver's findings (${which.oracleFn}) on (kind, start_offset, end_offset${which.parityExtra}) — sort both, compare. Confidence is a bare float → compare with a tolerance or exclude it + assert it's in [0,1] (mirror the contract tests' float handling). This subsumes recall but assert recall explicitly too.
3. NEGATIVE CONTROLS: entries with expected_detected===false (e.g. UUIDs, version strings) — your detector must agree with Python (don't false-positive beyond what Python does).

TDD: write ${which.testFile} FIRST (RED), port the detector to GREEN against live Python over the WHOLE corpus. Then \`cd ${REPO} && npx vitest run test/parity/${which.testFile}\`, \`npx tsc -p tsconfig.json\`, \`npx eslint apps/backend/src/backend/redact/${which.tsFile} test/parity/${which.testFile}\`, \`npx tsx scripts/gates/check_clock_random.ts\` (0 violations). Green.

Return files_written, the measured recall (e.g. "${which.corpus} 1.00, N/N positives"), per-entry parity pass/fail count, every command, all_green, notes (incl. any regex that needed non-obvious translation).`.replace('${FOUNDATION_SUMMARY}', JSON.stringify(foundationRes).slice(0, 700))

const SECRET = {
  name: 'secret detector (PatternSecretDetector)', pySrc: 'pattern_secret_detector.py', method: 'detect()',
  contract: 'secret_detection', oracleFn: 'pyDetectSecrets', tsFile: 'secret_detector.ts', corpus: 'secrets', recall: '0.99',
  signature: 'function detectSecrets(text: string): Array<SecretFindingV1>', returns: 'the detected SecretFindingV1[]',
  testFile: 'redact_secret.parity.test.ts', extra: 'snippet_redacted first/last-4-char masking', parityExtra: ', snippet_redacted',
}
const PII = {
  name: 'PII redactor (RegexPiiRedactor)', pySrc: 'regex_pii_redactor.py', method: 'redact()',
  contract: 'pii_redaction', oracleFn: 'pyDetectPii', tsFile: 'pii_redactor.ts', corpus: 'pii', recall: '0.95',
  signature: 'function redactPii(text: string): { rewritten: string; findings: Array<PiiFindingV1> }', returns: 'the rewritten text + PiiFindingV1[]',
  testFile: 'redact_pii.parity.test.ts', extra: 'the inline [REDACTED:kind] replacement + any Luhn/structural validation', parityExtra: ', replacement (and assert the rewritten text byte-matches Python)',
}

const [secretRes, piiRes] = await parallel([
  () => agent(detectorBrief(SECRET), { label: 'secret_detector', phase: 'Detectors', schema: BUILD_SCHEMA }),
  () => agent(detectorBrief(PII), { label: 'pii_redactor', phase: 'Detectors', schema: BUILD_SCHEMA }),
])

// =================================================================================================
phase('Verify')

const VERIFY_BRIEF = `You are an ADVERSARIAL verifier for the just-ported "redact" subsystem (secret detector + PII redactor + redact_text). REFUTE that it faithfully matches the frozen Python and that the recall gates genuinely hold. Default skeptical — a green test can be a weak test.
${STYLE}

Built: ${'${DET_SUMMARY}'}

Independently verify (drive the LIVE frozen Python directly AND the TS via a throwaway tsx script under ${REPO}/tools/parity/_redact_scratch.ts — DELETE it after; do not git-add):
1. SECRET RECALL is REAL: independently iterate vendor/codemaster-py/tests/corpora/secrets/*.yaml, count positives, run BOTH the frozen PatternSecretDetector (cd vendor/codemaster-py && .venv/bin/python -c "...") and the TS detectSecrets; report TS recall as a fraction. Must be ≥0.99. If the test hard-codes/skips entries or counts wrong, flag it.
2. PII RECALL ≥0.95 the same way over corpora/pii.
3. DETECTOR PARITY: pick 5 corpus entries (incl. the multi-secret + evasion-split-across-lines + negative-control ones) and confirm TS findings === Python findings on (kind,start_offset,end_offset). Report any entry where they differ.
4. REDACTOR BYTE-PARITY: a tricky case (overlapping + out-of-order + zero-width findings) — redactText vs Python redact_text must produce identical redacted_text + spans_redacted.
5. NEGATIVE CONTROLS don't regress to false positives beyond Python.
6. TESTS-ARE-REAL: open redact_secret/redact_pii/redact_redactor.parity.test.ts — confirm they actually read the corpus, await the oracle (spawn frozen venv python), and assert recall+parity (not skipped/.todo/hard-coded-pass). Run \`cd ${REPO} && npx vitest run test/parity/redact_secret.parity.test.ts test/parity/redact_pii.parity.test.ts test/parity/redact_redactor.parity.test.ts\` and read pass counts.
7. GATE: \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations (apps/backend/src/backend/redact/** is now in scope).

verdict=DRIFT if recall is below threshold OR TS≠Python on any probed entry OR a test is vacuous; FAITHFUL only if all hold. Give exact reproduction for any failure (entry id, input, py vs ts findings). Clean up scratch files.`.replace('${DET_SUMMARY}', JSON.stringify({ secret: secretRes, pii: piiRes }).slice(0, 1000))

const verifyRes = await agent(VERIFY_BRIEF, { label: 'adversarial redact verify', phase: 'Verify', schema: VERIFY_SCHEMA })

return { foundation: foundationRes, secret: secretRes, pii: piiRes, verify: verifyRes }
