export const meta = {
  name: 'phase1-classify',
  description: 'Port file routing (decide_route, byte-parity) + the magika classifier wrapper (tolerated-divergence, ≥95% label agreement + ADR)',
  phases: [
    { title: 'Port', detail: 'router.ts (oracle byte-parity) + magika_classifier.ts (npm magika) + agreement test + ADR' },
    { title: 'Verify', detail: 'router byte-parity + label-agreement ≥95% vs Python magika' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['component', 'files_written', 'commands', 'all_green', 'notes'],
  properties: {
    component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'passed'], properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } } } },
    all_green: { type: 'boolean' }, agreement: { type: 'string' }, notes: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'checks', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['SOUND', 'WEAK', 'INCONCLUSIVE'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    router_byte_parity: { type: 'boolean' }, label_agreement: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = `
WORKING DIR: ${REPO}. ABSOLUTE paths. Bash cwd RESETS — prefix every command with \`cd ${REPO} && ...\`.
TS STYLE (ENFORCED — validate-fast = gates→lint→typecheck→test): ESM \`.js\` specifiers; \`type\` not \`interface\`; \`Array<T>\`; NO \`any\`; named exports; explicit return types; \`import { type X }\`; no unused vars; snake_case filenames.
IMPORTS: Node subpath aliases \`#contracts/*\`, \`#platform/*\`, \`#backend/*\`; cross-dir aliases, same-dir relative.
GATE: apps/backend/src/backend/** scanned by check_clock_random — route wall-clock/random through #platform seams.
GUARDRAILS: touch ONLY your files. NO eslint --fix on the repo; NO git add/commit; NO database. You are the ONLY workflow running; \`npx tsc -p tsconfig.json\` should be clean. Frozen source READ-ONLY at vendor/codemaster-py (venv .venv/bin/python — Python magika 1.0.2 installed).
RUN BEFORE RETURNING (all must pass): \`cd ${REPO} && npx vitest run <your test(s)>\`, \`npx tsc -p tsconfig.json\`, \`npx eslint <your .ts files>\`, \`npx tsx scripts/gates/check_clock_random.ts\`. Do NOT report all_green:true unless every one passed.
`

phase('Port')

const ROUTER = `Port the file ROUTER 1:1 to TypeScript (PURE → byte-parity vs frozen Python).
${STYLE}
Python source: ${REPO}/vendor/codemaster-py/codemaster/files/router.py — READ FULLY. Port \`decide_route(...)\` + the SANDBOX_LANGUAGES frozenset + RoutingBucket/RoutingDecision types to ${REPO}/apps/backend/src/backend/files/router.ts. Confirm the exact signature via help() and the rule ORDER (is_generated→{skip}, is_binary→{skip}, magika_label=="empty"→{skip}, language∈SANDBOX_LANGUAGES→{review,sandbox}, else→{review}; unknown labels→{review}). RoutingDecision is a SET of buckets — represent as a ReadonlySet<RoutingBucket> (or sorted Array) but ensure the parity test canonicalizes set order (sort) so {review,sandbox} compares stably.
Test ${REPO}/test/parity/router.parity.test.ts via the GENERIC oracle (test/parity/oracle.ts::assertParity / pyRef → run_python_ref.py): drive decide_route over a MATRIX of inputs covering every rule + edge (is_generated/is_binary true/false, magika_label=empty, each SANDBOX_LANGUAGES language, a non-sandbox language, an unknown label). The Python returns a frozenset → the oracle encodes it as a sorted list; make your TS return canonicalize to the same sorted list. Byte-parity on every case.
Return component="router", files_written, every command+pass/fail, all_green (agreement="n-a"), notes (signature + any set-ordering handling).`

const MAGIKA = `Port the magika file CLASSIFIER wrapper to TypeScript using the npm \`magika\` package — this is a TOLERATED-DIVERGENCE axis (ML model: Python magika 1.0.2 vs npm magika 1.0.0 may differ on some labels), so the acceptance is a LABEL-AGREEMENT RATE (≥95%), NOT byte-parity. (See the plan: magika_label affects ROUTING only — never chunk_id or evidence_id — and unknown→safe-default, so divergence is contained.)
${STYLE}
READ: ${REPO}/vendor/codemaster-py/codemaster/files/magika_classifier.py + classifier_port.py — the MagikaFileClassifier.classify(path, body) -> FileClassificationV1 surface (FileClassificationV1 is already ported at #contracts/file_classification.v1.js — confirm its fields: magika_label/group/score/is_binary/is_generated/etc.). Note how Python derives is_generated/is_binary and maps magika's output to the contract.

STEP 1 — add the dep: \`cd ${REPO} && npm install magika\` (justified: 1:1 with Python's classifier; the ADR below records it). Confirm it imports + classifies a sample byte buffer in Node (npm magika v1 API: \`Magika.create()\` then \`.identifyBytes(...)\` / per its README — CHECK the actual API surface installed). If npm magika cannot load its model in this environment (network/runtime), STOP and report that as a blocker in notes (still land the wrapper + ADR; gate the agreement test).

STEP 2 — port ${REPO}/apps/backend/src/backend/files/magika_classifier.ts: an async classifier wrapping npm magika that returns a FileClassificationV1 (same field derivation as Python — is_generated/is_binary heuristics ported 1:1; magika label/group/score from the npm model). Memoize the Magika instance (model load is expensive — load once).

STEP 3 — corpus + agreement test. Curate ≥50 representative files under ${REPO}/test/fixtures/magika_corpus/ (reuse real files: copy a sampling of .py from vendor/codemaster-py/codemaster, .ts/.js from the repo, + a few .go/.json/.md/Dockerfile/lock/binary samples — cover SANDBOX_LANGUAGES python/javascript/typescript/go + non-code + generated/binary). Write ${REPO}/test/parity/magika_agreement.parity.test.ts: for each corpus file, classify with npm magika (TS) AND the frozen Python magika (via a small driver tools/parity/run_magika_ref.py that takes a path, returns magika's label), compute label-agreement rate = matches/total, assert ≥0.95. Log per-file divergences. Mark it so it skips cleanly if npm magika's model is unavailable (don't hard-fail validate-fast on a network-gated model — use a describe.skipIf or a model-availability probe).

STEP 4 — ADR ${REPO}/docs/adr/0065-magika-model-divergence.md (next free ADR number — confirm): context (Python magika 1.0.2 vs npm magika 1.0.0; cross-impl ONNX label divergence possible), decision (accept ≥95% label agreement; divergent labels route to the safe default {review}, never affect chunk_id/evidence_id identity), rationale (blast-radius contained — routing only), the dependency justification, and the acceptance test reference.

Return component="magika", files_written, the measured agreement rate, every command+pass/fail, all_green, notes (npm magika API used, corpus composition, agreement rate + any divergent labels, whether the model loaded).`

const [routerRes, magikaRes] = await parallel([
  () => agent(ROUTER, { label: 'port:router', phase: 'Port', schema: BUILD_SCHEMA }),
  () => agent(MAGIKA, { label: 'port:magika', phase: 'Port', schema: BUILD_SCHEMA }),
])

phase('Verify')
const verify = await agent(`ADVERSARIAL verifier for the file-classification subsystem (router byte-parity + magika tolerated-divergence).
${STYLE}
Ports: router=${JSON.stringify(routerRes).slice(0, 500)} | magika=${JSON.stringify(magikaRes).slice(0, 600)}
Independently:
1. ROUTER byte-parity: drive the frozen Python decide_route (cd vendor/codemaster-py && .venv/bin/python ...) AND the TS router over ~12 input combinations incl. every rule branch + unknown label + each SANDBOX_LANGUAGES language; confirm the bucket SETS are identical on every case.
2. MAGIKA agreement: independently classify 10+ corpus files with BOTH Python magika (.venv) and the TS npm-magika wrapper; compute the agreement rate; confirm it's ≥0.95 (or, if the npm model didn't load, confirm the test SKIPS rather than false-passes, and that the wrapper + ADR are present). Report the actual rate + any divergent files.
3. Confirm magika_label divergence is CONTAINED: it influences routing only (a divergent label still routes to a valid bucket; never chunk_id/evidence_id).
4. ADR docs/adr/0065-magika-model-divergence.md exists + records the ≥95% decision + dep justification.
5. Run \`cd ${REPO} && npx vitest run test/parity/router.parity.test.ts test/parity/magika_agreement.parity.test.ts\`; \`npx tsx scripts/gates/check_clock_random.ts\` 0 violations; \`npx tsc -p tsconfig.json\` clean.
verdict=WEAK if router diverges on any case, agreement <0.95 (with the model loaded), or the agreement test false-passes when the model is absent; SOUND otherwise (a SKIPPED-due-to-no-model agreement test is acceptable IF clearly gated, the wrapper compiles, and the ADR is present — say so). List issues.`, { label: 'verify:classify', phase: 'Verify', schema: VERIFY_SCHEMA })

return { router: routerRes, magika: magikaRes, verify }
