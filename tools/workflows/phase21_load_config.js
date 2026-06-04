export const meta = {
  name: 'phase21-load-config',
  description: 'Phase 2.1 activity #3: load_repo_config_activity — port config_loader.load_repo_config (read .codemaster.yaml -> parse -> validate CodemasterConfigV1 -> fail-open to defaults), Tier-1 parity vs frozen Python',
  phases: [
    { title: 'Port', detail: 'config_loader.ts (load_repo_config + helpers) + load_repo_config activity + worker registration' },
    { title: 'Verify', detail: 'adversarial Tier-1 parity vs frozen load_repo_config: valid/invalid/missing/partial yaml -> identical CodemasterConfigV1 (fail-open)' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC_ACT = REPO + '/vendor/codemaster-py/codemaster/activities/load_repo_config.py'
const SRC_LOADER = REPO + '/vendor/codemaster-py/codemaster/policy/config_loader.py'

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
  'ALREADY PORTED + REUSE: libs/contracts/src/codemaster_config.v1.ts (CodemasterConfigV1 — the validated config + its defaults) + libs/contracts/src/load_repo_config.v1.ts (LoadRepoConfigInputV1 — the activity input is ALREADY a typed envelope, so NO inv-11 work here). YAML: js-yaml is ALREADY a dep — use it for parsing (mirror PyYAML safe_load). The config subsystem itself (config_loader) is NOT yet ported — you port it.',
  'PARITY TOOLING (established Tier-1 pattern): a DEDICATED tools/parity/run_config_ref.py + test/parity/config_oracle.ts, driving frozen Python via ' + PY + '. CodemasterConfigV1 is pure-structural (verify whether any field is a bare float — if so, strip it from the canonical compare per the established pattern; otherwise the generic canonicalize() diffs the whole config).',
  'GATE: apps/** + libs/**/src scanned by check_clock_random (no Date/Math.random/setTimeout outside seams; fs reads fine). NO NEW DEPS. Frozen Python READ-ONLY at vendor/codemaster-py.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

phase('Port')

const PORT = [
  'Port load_repo_config_activity + the config_loader.load_repo_config function 1:1 to TypeScript (Phase 2.1, activity #3). The activity input is already typed (no inv-11 work); this is a deterministic YAML-config port with FAIL-OPEN semantics.',
  STYLE,
  'READ FULLY: ' + SRC_ACT + ' (the @activity.defn load_repo_config_activity — takes LoadRepoConfigInputV1, calls load_repo_config(Path(workspace_path)), returns CodemasterConfigV1; FAIL-OPEN, never raises) and ' + SRC_LOADER + ' (port load_repo_config at line ~176 EXACTLY + every helper it transitively calls — load_knowledge_config / load_knowledge_file_patterns if used; note PLR0911 = MANY return points, each a distinct fail-open path — replicate every branch).',
  'THE FAIL-OPEN CONTRACT (parity-critical): load_repo_config reads <workspace>/.codemaster.yaml. On EVERY failure mode it returns a valid CodemasterConfigV1 (defaults or partial) — NEVER raises. Map each Python return point: file missing -> defaults; YAML parse error (PyYAML -> js-yaml: catch the parse exception) -> defaults; non-dict/non-mapping top-level -> defaults; per-field validation failure (the Pydantic model rejects -> Zod .parse throws -> caught) -> defaults or the documented partial-merge; valid -> the validated config. Read the source for the EXACT branch behavior (does an invalid field fall back the WHOLE config to defaults, or merge valid fields? — mirror precisely).',
  'PORT TO:',
  '- ' + REPO + '/apps/backend/src/backend/config/config_loader.ts — loadRepoConfig(workspace: string): CodemasterConfigV1 (sync or async to match Python; Python is sync def) + any helpers (loadKnowledgeConfig / loadKnowledgeFilePatterns) the function uses. Read the .codemaster.yaml via node:fs, parse via js-yaml safeLoad/load, validate via CodemasterConfigV1 (the Zod contract), fail-open. NO Date/random/timers.',
  '- ' + REPO + '/apps/backend/src/backend/activities/load_repo_config.activity.ts — export `loadRepoConfigActivity(input: LoadRepoConfigInputV1): Promise<CodemasterConfigV1>` (mirror the Python activity; call loadRepoConfig(input.workspace_path); fail-open). Mirror the sibling activities (aggregate/classify) structure.',
  '- REGISTER `loadRepoConfigActivity` in ' + REPO + '/apps/backend/src/backend/worker/registry.ts alongside the existing activities (additive; workflow NOT touched — orchestration is 2.2).',
  'TIER-1 PARITY: tools/parity/run_config_ref.py drives the frozen Python load_repo_config (writes a fixture .codemaster.yaml into a temp workspace, calls load_repo_config, dumps CodemasterConfigV1.model_dump(mode=json)). test/parity/config_oracle.ts runs the TS loadRepoConfig with the SAME fixture .codemaster.yaml + SAME temp dir and asserts CodemasterConfigV1 byte-matches. Cover: (a) a FULLY-valid .codemaster.yaml exercising the real config fields; (b) MISSING file -> defaults; (c) MALFORMED yaml (syntax error) -> defaults; (d) top-level non-mapping (e.g. a yaml list/scalar) -> defaults; (e) a config with ONE invalid field value -> whatever Python does (defaults vs partial); (f) an empty file -> defaults. The fixtures must exercise the ACTUAL CodemasterConfigV1 fields (read codemaster_config.v1.ts / the Python contract).',
  'Return component="load_config", files_written, commands, all_green, notes (the exact fail-open branch map — which failures -> full-defaults vs partial; the js-yaml-vs-PyYAML parse-error parity; any CodemasterConfigV1 field that needed bare-float handling; confirmation the input was already a typed envelope so no inv-11 work).',
].join('\n')

const port = await agent(PORT, { label: 'port:load-config', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL Tier-1 verifier for the load_repo_config port. REFUTE that the TS loadRepoConfig matches the frozen Python load_repo_config value-for-value across the fail-open matrix.',
  STYLE,
  'Built: ' + JSON.stringify(port).slice(0, 600),
  'Independently drive BOTH the frozen Python (' + PY + ', import codemaster.policy.config_loader.load_repo_config) and the TS loadRepoConfig via a throwaway tools/parity/_cfg_scratch.ts (npx tsx; DELETE after). For each .codemaster.yaml fixture, write it to a temp workspace on BOTH sides + byte-compare the resulting CodemasterConfigV1:',
  '1. FULLY-VALID config exercising the real fields -> the validated config matches Python field-for-field.',
  '2. MISSING .codemaster.yaml -> CodemasterConfigV1 defaults in BOTH (identical default object).',
  '3. MALFORMED YAML (deliberate syntax error) -> defaults in BOTH (js-yaml parse-throw caught == PyYAML error caught). A yaml that parses but is a LIST or a SCALAR at top level (non-mapping) -> defaults in BOTH.',
  '4. ONE INVALID FIELD (e.g. a wrong-typed value) -> confirm whether Python falls the WHOLE config back to defaults or merges valid fields, and that TS does the EXACT same thing. This is the subtlest parity point — a wrong fall-open granularity is WEAK.',
  '5. EMPTY file + a yaml `null`/`{}` -> defaults in BOTH.',
  '6. The activity loadRepoConfigActivity is registered in worker/registry.ts and NEVER throws (fail-open) even on a totally garbage workspace path.',
  'Run (cd ' + REPO + ' && npx vitest run <the config tests>) + check_clock_random; tsc clean (delete scratch before tsc, or run tsc before scratch). verdict=WEAK if any config field, the default object, or the fail-open granularity (whole-default vs partial-merge) diverges from Python; SOUND otherwise. Exact diverging fixture+config for any failure. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:load-config', phase: 'Verify', schema: VERIFY_SCHEMA })

return { port, verify }
