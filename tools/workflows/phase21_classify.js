export const meta = {
  name: 'phase21-classify',
  description: 'Phase 2.1 activity #2: classify_files — typed ClassifyFilesInputV1 envelope (inv-11 closure) + the _do_classify routing/failure-isolation orchestration over the ported magika+router, Tier-1 parity vs frozen Python with a stub classifier',
  phases: [
    { title: 'Port', detail: 'ClassifyFilesInputV1 contract + doClassify (read/classify/decide_route/bucket/failure-isolate) + activity + worker registration' },
    { title: 'Verify', detail: 'adversarial Tier-1 parity vs frozen _do_classify (stub classifier + fixture dir): bucketing, code-in-both, read/classify failure isolation, FileRoutingV1 assembly' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC = REPO + '/vendor/codemaster-py/codemaster/activities/classify_files.py'

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
  'TS STYLE (validate-fast = gates -> lint -> typecheck -> test): ESM .js specifiers; "type" not "interface"; Array<T>; NO any (unknown+narrow); named exports; explicit return types; import { type X }; no unused vars; snake_case FILENAMES; camelCase members.',
  'IMPORTS: #contracts/* (libs/contracts/src), #platform/* (libs/platform/src), #backend/* (apps/backend/src/backend); same-dir relative ./x.js.',
  'ALREADY PORTED + REUSE: apps/backend/src/backend/files/router.ts (decideRoute — the route logic, ALREADY byte-parity-tested, 19 tests), apps/backend/src/backend/files/magika_classifier.ts (the real FileClassifierPort impl + the port interface — find the TS FileClassifierPort type), libs/contracts/src/file_classification.v1.ts (the classification contract magika returns), libs/contracts/src/file_routing.v1.ts (FileRoutingV1 — the activity return). The magika ML label-agreement is SEPARATELY covered (test:magika); do NOT re-test magika here — Tier-1 here uses a STUB classifier so the routing/failure-isolation orchestration is byte-verifiable WITHOUT the ~150s ONNX load.',
  'PARITY TOOLING (established Tier-1 pattern): a DEDICATED tools/parity/run_classify_ref.py + test/parity/classify_oracle.ts, driving frozen Python via ' + PY + '. FileRoutingV1 + FileClassificationV1 are pure structural (no bare floats) so the generic canonical compare works.',
  'GATE: apps/** + libs/**/src scanned by check_clock_random (no Date/Math.random/setTimeout outside seams; fs reads are fine). NO NEW DEPS. Frozen Python READ-ONLY at vendor/codemaster-py.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

phase('Port')

const PORT = [
  'Port the classify_files activity + its _do_classify orchestration 1:1 to TypeScript (Phase 2.1, activity #2). Reuses the already-ported router (decideRoute) + magika classifier + FileRoutingV1/FileClassificationV1 contracts.',
  STYLE,
  'READ FULLY: ' + SRC + ' (the @activity.defn classify_files + _do_classify). THE LOGIC (port EXACTLY): for each relative file in files: absolute = workspace/relative; try read_bytes -> OSError appends to failures + continue; try classifier.classify(path=relative, body=bytes) -> ANY exception appends to failures + continue; else append cls to classifications; decision = decide_route(cls) (a frozenset/Set of {skip, review, sandbox}); if "skip" in decision -> skip.append; else { if "review" -> review.append; if "sandbox" -> sandbox.append } (a CODE file appears in BOTH review AND sandbox — preserve that). Return FileRoutingV1{review_files, sandbox_files, skip_files, classifications, classifier_failures} in INPUT ORDER. The failure-isolation (a bad file is recorded + skipped from all buckets but the rest still route) is the parity-significant behavior.',
  'PORT TO:',
  '- ' + REPO + '/libs/contracts/src/classify_files.v1.ts — ClassifyFilesInputV1 (Zod): the TYPED ENVELOPE replacing the Python 2-positional dispatch classify_files(workspace_path: str, files: tuple[str,...]). Fields: workspace_path: z.string(), files: z.array(z.string()), schema_version default 1, .strict(). No Python Pydantic counterpart (port-introduced; note in header). Closes another CLAUDE.md invariant-11 / ADR-0047 positional-dispatch violation (consistent with aggregate_findings.v1).',
  '- ' + REPO + '/apps/backend/src/backend/activities/classify_files.activity.ts — export `doClassify({ workspace, files, classifier }): Promise<FileRoutingV1>` (the pure orchestration, mirrors Python _do_classify; reads bytes via node:fs, calls the injected FileClassifierPort, decideRoute, buckets, isolates failures) AND `classifyFiles(input: ClassifyFilesInputV1): Promise<FileRoutingV1>` (the activity — constructs the REAL MagikaFileClassifier, calls doClassify). Match the FileClassifierPort interface the TS magika_classifier.ts already defines (classify({ path, body }) -> FileClassificationV1). decideRoute returns a Set<string>; mirror the Python frozenset membership checks exactly.',
  '- REGISTER `classifyFiles` in ' + REPO + '/apps/backend/src/backend/worker/registry.ts alongside the existing activities (additive; workflow NOT touched — orchestration is 2.2).',
  'TIER-1 PARITY (STUB classifier — NO magika): tools/parity/run_classify_ref.py drives the frozen Python _do_classify with a STUB classifier whose classify() looks up a CALLER-SUPPLIED map {relative_path -> FileClassificationV1 dict} (so both sides classify identically — the magika ML is out of scope here, separately covered by test:magika). It writes the fixture files into a temp dir, runs _do_classify, dumps FileRoutingV1. test/parity/classify_oracle.ts runs the TS doClassify with the SAME stub-from-map + the SAME temp fixture dir and asserts FileRoutingV1 byte-matches. Cover: a review-only file, a sandbox-only file, a skip file, a CODE file in BOTH review+sandbox, an UNREADABLE file (not on disk -> read failure -> in classifier_failures, absent from all buckets), and a classify-FAILURE (stub raises for one path -> in failures). Assert input-order preservation + that classifications excludes failed files.',
  'Return component="classify", files_written, commands, all_green, notes (the FileClassifierPort interface shape, the decideRoute Set semantics, the failure-isolation parity, the stub-classifier approach, and the inv-11 envelope closure).',
].join('\n')

const port = await agent(PORT, { label: 'port:classify', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL Tier-1 verifier for the classify_files port. REFUTE that the TS doClassify matches the frozen Python _do_classify value-for-value (with a stub classifier, so the routing/failure-isolation orchestration is the thing under test — magika is out of scope).',
  STYLE,
  'Built: ' + JSON.stringify(port).slice(0, 600),
  'Independently drive BOTH the frozen Python (' + PY + ', import codemaster.activities.classify_files._do_classify with a stub classifier) and the TS doClassify via a throwaway tools/parity/_cls_scratch.ts (npx tsx; DELETE after). Use the SAME stub-classification map + the SAME temp fixture dir on both sides; byte-compare the FileRoutingV1:',
  '1. BUCKETING: a review-only classification -> review_files only; sandbox-only -> sandbox_files only; skip -> skip_files only. Matches decideRoute in BOTH.',
  '2. CODE-IN-BOTH: a classification decideRoute returns {review, sandbox} for -> the file appears in BOTH review_files AND sandbox_files (NOT skip). Confirm in BOTH.',
  '3. READ FAILURE: a path in `files` that does NOT exist on disk -> recorded in classifier_failures, ABSENT from review/sandbox/skip AND from classifications, the OTHER files still route. Same in BOTH.',
  '4. CLASSIFY FAILURE: the stub raises for one path -> that path in classifier_failures, absent from buckets+classifications; others unaffected. Same in BOTH.',
  '5. ORDER: review_files / sandbox_files / skip_files preserve INPUT order; classifications is in successful-file order. Same in BOTH.',
  '6. ENVELOPE: ClassifyFilesInputV1 is a single typed arg (ADR-0047 / inv-11 closure, NOT 2 positional) + classifyFiles registered in worker/registry.ts.',
  'Run (cd ' + REPO + ' && npx vitest run <the classify tests>) + check_clock_random; tsc clean (delete scratch before tsc, or run tsc before scratch). verdict=WEAK if any bucket membership, the code-in-both behavior, failure isolation, classifications set, or ordering diverges from Python; SOUND otherwise. Exact diverging input+output for any failure. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:classify', phase: 'Verify', schema: VERIFY_SCHEMA })

return { port, verify }
