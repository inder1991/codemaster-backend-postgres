export const meta = {
  name: 'phase21-config-yaml-fix',
  description: 'Fix the .codemaster.yaml fidelity gap: a dedicated boundary normalizer (Pydantic-v2-compatible bool/int coercion) BEFORE the STRICT CodemasterConfigV1.parse — fixes the enabled:no security inversion; CodemasterConfigV1 stays strict (no broad loosening); exotic YAML-1.1-only cases documented as residual',
  phases: [
    { title: 'Fix', detail: 'CodemasterConfigYamlInput normalizer (bool/int coercion) wired before strict parse + comments corrected + 12 adversarial fixtures + residual docs' },
    { title: 'Verify', detail: 'adversarial: acceptance criteria 1-4 hold vs frozen Python; CodemasterConfigV1 unchanged/strict; residual is ONLY exotic YAML-1.1-only cases' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
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
  'EXISTING (this is a FIX of an uncommitted port): apps/backend/src/backend/config/config_loader.ts (loadRepoConfig — currently parses js-yaml then CodemasterConfigV1.parse; it MISSES the YAML-1.1/Pydantic-coercion layer), test/parity/config.parity.test.ts + config_oracle.ts + tools/parity/run_config_ref.py (the harness is SOUND — only the corpus is too tame). libs/contracts/src/codemaster_config.v1.ts (CodemasterConfigV1 — MUST STAY .strict()/unchanged). js-yaml is the parser (already a dep; NO new dep).',
  'GATE: apps/** + libs/**/src scanned by check_clock_random; NO NEW DEPS; frozen Python READ-ONLY at vendor/codemaster-py.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run test/parity/config.parity.test.ts).',
].join('\n')

phase('Fix')

const FIX = [
  'Fix the .codemaster.yaml fidelity gap an adversarial parity check found: js-yaml (YAML 1.2) + strict Zod diverges from frozen PyYAML (1.1) + Pydantic (lax) — MATERIALLY: `enabled: no` parses to the string "no", z.boolean() rejects, the whole config falls to defaults, and review STAYS ON for a customer who opted OUT. ARCHITECTURE (the project owner mandated this exact shape): a DEDICATED untrusted-boundary normalizer that coerces the js-yaml-parsed object to Pydantic-v2-compatible types BEFORE handing it to the STRICT CodemasterConfigV1.parse. CodemasterConfigV1 itself STAYS .strict() / UNCHANGED — do NOT add z.coerce / loosen the shared contract (Temporal/DB/internal consumers MUST stay strict). Confine ALL leniency to the .codemaster.yaml boundary.',
  STYLE,
  'STEP 1 — measure Pydantic v2 ground truth: drive ' + PY + ' to observe the frozen CodemasterConfigV1 / Pydantic coercion EXACTLY — e.g. `CodemasterConfigV1.model_validate({"enabled": x})` for x in [no,No,NO,off,false,False,0,"0",yes,on,true,1,"1",...] and the int fields with ["2", "1_000", "1:30", "017", true]. Record the EXACT accepted bool-string set + int-string behavior Pydantic v2 uses (do NOT guess Pydantic\'s set — observe it).',
  'STEP 2 — build the normalizer ' + REPO + '/apps/backend/src/backend/config/codemaster_config_yaml_input.ts: export `normalizeCodemasterYaml(parsed: unknown): unknown` (a dedicated boundary parser). It walks the js-yaml-parsed object and, GUIDED BY the CodemasterConfigV1 field types (the BOOL fields incl. nested knowledge.enabled, and the INT/number fields — derive them from the contract; an explicit typed field-map is acceptable + documented), coerces ONLY those fields to match Pydantic v2: bool fields — map the observed Pydantic bool-string set (case-insensitive, e.g. yes/no/on/off/true/false/y/n/t/f AND 0/1) + JS boolean passthrough -> boolean; int fields — numeric strings incl. underscores via Python int() semantics, quoted numerics, and bool->int (true->1) where Pydantic does -> number. Leave every other field untouched (the opaque `policy` block, string fields, lists). A value the normalizer cannot confidently coerce is LEFT AS-IS so the strict CodemasterConfigV1.parse rejects it and the loader falls open to defaults (criterion 4).',
  'STEP 3 — wire it in apps/backend/src/backend/config/config_loader.ts: parse YAML (js-yaml) -> normalizeCodemasterYaml(parsed) -> CodemasterConfigV1.parse(normalized) -> on ANY error fall open to defaults (preserve the existing fail-open branch map EXACTLY). CodemasterConfigV1 import + usage UNCHANGED (still strict).',
  'STEP 4 — comments: in config_loader.ts (and codemaster_config_yaml_input.ts) STOP claiming js-yaml load == PyYAML safe_load. Document the truth: js-yaml is YAML 1.2; PyYAML is 1.1; the normalizer bridges the REALISTIC scalar/coercion divergences (bool words, quoted/underscore numerics) at this untrusted boundary; the EXOTIC YAML-1.1-only cases (sexagesimal 1:30, leading-zero octal 017/0o17, bools-inside-string-lists, duplicate mapping keys) are a DOCUMENTED RESIDUAL (FOLLOW-UP-config-yaml-1.1-exotic-scalars) — never present in a real .codemaster.yaml, not worth a new YAML-1.1 parser dep.',
  'STEP 5 — corpus: add ALL 12 adversarial fixtures the verifier found to test/parity/config.parity.test.ts, driving frozen Python via the existing run_config_ref.py harness: (FIX, must MATCH now) `enabled: no`->disabled, `enabled: off`->disabled, `enabled: False`->disabled, `enabled: 0`->disabled, `knowledge.enabled: no`->knowledge disabled, `schema_version: "2"`->2, `schema_version: 1_000`->1000, `max_findings_per_file: true`->1; (RESIDUAL, assert the KNOWN divergence + a clear `// RESIDUAL: YAML 1.1 only` comment, do NOT pretend they match) sexagesimal `max_findings_per_file: 1:30`, octal `schema_version: 017` and `0o17`, `ignore_paths: [yes, no]`, nested `policy: {k: {b: [yes, no]}}`, duplicate-key `enabled: true\\nenabled: false`. Every FIX fixture asserts TS === frozen-Python; every RESIDUAL fixture documents the exact PY-vs-TS values + the reason.',
  'ACCEPTANCE CRITERIA (all must hold): (1) enabled: no/off/false/False/0 disables at top level; (2) knowledge.enabled: no/off/false/False/0 disables policy knowledge; (3) quoted "2" + underscored 1_000 behave like Python/Pydantic where valid; (4) invalid coercions still fail the WHOLE config to defaults; (5) parity tests include the 12 fixtures with residuals documented; (6) config_loader.ts comments stop claiming full js-yaml/PyYAML parse parity.',
  'Return component="config_yaml_fix", files_written, commands, all_green, notes (the observed Pydantic v2 bool/int coercion set, the normalizer field-map, confirmation CodemasterConfigV1 is UNCHANGED/strict, which fixtures are FIX vs RESIDUAL, and how each acceptance criterion is met).',
].join('\n')

const fix = await agent(FIX, { label: 'fix:config-yaml', phase: 'Fix', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL verifier for the .codemaster.yaml boundary-normalizer fix. REFUTE that (a) the acceptance criteria hold vs frozen Python, (b) CodemasterConfigV1 stayed strict (no broad loosening), (c) the residual is ONLY the exotic YAML-1.1-only cases.',
  STYLE,
  'Built: ' + JSON.stringify(fix).slice(0, 600),
  'Independently drive BOTH frozen Python (' + PY + ', codemaster.policy.config_loader.load_repo_config) and the TS loadRepoConfig via a throwaway tools/parity/_cfgfix_scratch.ts (npx tsx; DELETE after), same .codemaster.yaml fixture written to a temp dir on both sides, byte-compare CodemasterConfigV1:',
  '1. CRITERION 1 (the security case): `enabled: no`, `enabled: off`, `enabled: False`, `enabled: 0` ALL -> enabled=false in BOTH (review DISABLED). This is the must-fix; a single one still defaulting-to-enabled is WEAK.',
  '2. CRITERION 2: `knowledge.enabled: no` / `off` / `0` -> knowledge disabled in BOTH.',
  '3. CRITERION 3: `schema_version: "2"`->2, `schema_version: 1_000`->1000, `max_findings_per_file: true`->1 — match frozen Python/Pydantic in BOTH.',
  '4. CRITERION 4 (fail-open preserved): a value the normalizer can NOT coerce (e.g. `max_findings_per_file: "abc"`, or an unknown key, or a genuinely-invalid field) STILL collapses the WHOLE config to defaults in BOTH — the normalizer must NOT salvage things Pydantic rejects.',
  '5. CONTRACT STRICTNESS (the architectural constraint): grep libs/contracts/src/codemaster_config.v1.ts — it MUST be UNCHANGED and still .strict()/.strip() as before (NO z.coerce / no loosened field types). The coercion lives ONLY in codemaster_config_yaml_input.ts. Confirm a DIRECT CodemasterConfigV1.parse({enabled: "no"}) (bypassing the normalizer) STILL REJECTS "no" (proving internal/Temporal/DB consumers stay strict).',
  '6. RESIDUAL HONESTY: the exotic cases (1:30, 017, 0o17, [yes,no], nested policy bools, duplicate key) are the ONLY remaining divergences, each documented in the tests as a known residual — NOT silently passing, NOT claimed-fixed.',
  '7. comments in config_loader.ts no longer claim full js-yaml == PyYAML parity.',
  'Run (cd ' + REPO + ' && npx vitest run test/parity/config.parity.test.ts) + check_clock_random + (tsc clean — delete scratch first). verdict=WEAK if any criterion-1..4 case diverges from Python, if CodemasterConfigV1 was loosened, or if a residual is silently passing/claimed-fixed; SOUND otherwise. Exact diverging fixture for any failure. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:config-yaml', phase: 'Verify', schema: VERIFY_SCHEMA })

return { fix, verify }
