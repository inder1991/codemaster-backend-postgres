export const meta = {
  name: 'phase21-compute-policy',
  description: 'Phase 2.1 activity #4: compute_policy_rules_activity — port discover_guideline_files (fnmatch/symlink-guard/cap) + resolve_guidance + the discover→extract→resolve chain; typed ComputePolicyRulesInputV1 input; Tier-1 parity vs frozen Python',
  phases: [
    { title: 'Port', detail: 'discover_repo_docs.ts (discover_guideline_files + helpers) + scope_resolver.ts (resolve_guidance) + compute_policy_rules activity (chain) + worker registration' },
    { title: 'Verify', detail: 'adversarial Tier-1 parity vs frozen compute_policy_rules_activity: fnmatch patterns, symlink guard, file cap/truncated, scope resolution, knowledge-disabled short-circuit' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC_ACT = REPO + '/vendor/codemaster-py/codemaster/activities/compute_policy_rules.py'
const SRC_DISC = REPO + '/vendor/codemaster-py/codemaster/activities/discover_repo_docs.py'
const SRC_SCOPE = REPO + '/vendor/codemaster-py/codemaster/policy/scope_resolver.py'

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
  'ALREADY PORTED + REUSE: apps/backend/src/backend/policy/rule_extractor.ts (extractRules — the A-2 step, ALREADY ported) + rule_classifier.ts + rule_id.ts. Contracts ALL ported: policy_compute.v1.ts (ComputePolicyRulesInputV1 + ComputedPolicyRulesV1), extracted_rules.v1.ts (ExtractedRuleV1), resolved_guidance.v1.ts (ResolvedGuidanceBundleV1), guideline_files.v1.ts (DiscoveredGuidelineFilesV1). node:crypto is fine in an ACTIVITY (not workflow) for the content hashing.',
  'PARITY TOOLING (established Tier-1 pattern): a DEDICATED tools/parity/run_policy_compute_ref.py + test/parity/policy_compute_oracle.ts, driving frozen Python via ' + PY + '. The contracts are pure-structural (check for bare floats; strip if any).',
  'GATE: apps/** + libs/**/src scanned by check_clock_random (no Date/Math.random/setTimeout outside seams; fs reads + node:crypto in activities are fine). NO NEW DEPS. Frozen Python READ-ONLY at vendor/codemaster-py.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit; CLEAN UP any scratch you create (delete it). You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

phase('Port')

const PORT = [
  'Port the compute_policy_rules activity + its 2 unported sub-modules 1:1 to TypeScript (Phase 2.1, activity #4). Deterministic; chains discover_guideline_files -> extract_rules (ported) -> resolve_guidance.',
  STYLE,
  'READ FULLY: ' + SRC_ACT + ' (the chain), ' + SRC_DISC + ' (port ONLY discover_guideline_files at line ~267 + its helpers: _is_in_scope, _resolves_inside, _hash_bytes, _validate_custom_patterns, _fnmatch_re, _matches_guideline_pattern, _derive_scope_dir, + the MAX_GUIDELINE_FILES_PER_REPO cap — do NOT port discover_repo_docs / discover_knowledge_docs, out of scope), ' + SRC_SCOPE + ' (resolve_guidance).',
  'THE CHAIN (compute_policy_rules_activity, port EXACTLY): validate input -> if NOT knowledge_enabled return ComputedPolicyRulesV1{bundles: {}, truncated: false} (short-circuit, NO workspace walk); custom_patterns = sorted(unique(input.custom_patterns)); discovered = discoverGuidelineFiles(workspace, custom_patterns); all_rules = flatMap(discovered.files, extractRules); bundles = { for each changed_path cp: cp -> resolveGuidance(cp, all_rules) }; return ComputedPolicyRulesV1{bundles, truncated: discovered.files_cap_hit}.',
  'PARITY-CRITICAL DETAILS (read the source precisely, these are byte-significant): (1) _fnmatch_re — Python fnmatch.translate semantics (* / ? / [seq] / [!seq]); port faithfully so pattern matching is identical to Python fnmatch (a known fiddly area — match Python, not a naive glob). (2) _resolves_inside — the symlink-escape guard (a guideline file whose realpath resolves OUTSIDE the workspace is REJECTED); replicate via node:fs realpath + path containment. (3) MAX_GUIDELINE_FILES_PER_REPO cap -> sets files_cap_hit/truncated when exceeded; preserve the EXACT cap value + the deterministic ordering of which files survive the cap. (4) _hash_bytes — the content hash (read the algo, e.g. sha256; node:crypto in the activity is fine). (5) _derive_scope_dir + _is_in_scope + resolve_guidance scope-matching + dedup — the rule filtering per changed_path; preserve ordering + dedup keys.',
  'PORT TO:',
  '- ' + REPO + '/apps/backend/src/backend/policy/discover_repo_docs.ts — discoverGuidelineFiles({ workspace, customPatterns }): DiscoveredGuidelineFilesV1 + the helpers. Walk the workspace via node:fs; fnmatch-faithful matching; symlink guard; cap.',
  '- ' + REPO + '/apps/backend/src/backend/policy/scope_resolver.ts — resolveGuidance({ changedPath, extractedRules }): ResolvedGuidanceBundleV1.',
  '- ' + REPO + '/apps/backend/src/backend/activities/compute_policy_rules.activity.ts — export `computePolicyRules(input: ComputePolicyRulesInputV1): Promise<ComputedPolicyRulesV1>` (the chain). NOTE: the frozen Python activity takes `payload_dict: dict` + validates internally — the TS port takes the TYPED ComputePolicyRulesInputV1 directly (the DataConverter handles serialization), closing that dict-dispatch deviation (ADR-0047). Mirror the sibling activities.',
  '- REGISTER `computePolicyRules` in ' + REPO + '/apps/backend/src/backend/worker/registry.ts alongside the existing activities (additive; workflow NOT touched).',
  'TIER-1 PARITY: tools/parity/run_policy_compute_ref.py writes a FIXTURE workspace (guideline files at various paths: a root CLAUDE.md/AGENTS.md, a nested docs/, files matching custom_patterns, a file that should be capped, optionally a symlink-escape) into a temp dir, runs compute_policy_rules_activity (or the chain helpers) with given changed_paths + custom_patterns + knowledge_enabled, dumps ComputedPolicyRulesV1. test/parity/policy_compute_oracle.ts runs the TS computePolicyRules with the SAME fixture workspace + inputs, asserts ComputedPolicyRulesV1 byte-matches. Cover: discovery + extraction + per-path bundles; the knowledge_enabled=false short-circuit (empty bundles, no walk); a custom-pattern match; the file cap -> truncated=true; a changed_path with NO applicable rules -> empty bundle; fnmatch edge patterns.',
  'Return component="compute_policy", files_written, commands, all_green, notes (the fnmatch port approach + any divergence risk, the symlink-guard mechanism, the cap value + survivor ordering, the hash algo, the knowledge short-circuit, and the typed-input ADR-0047 closure of the dict-dispatch).',
].join('\n')

const port = await agent(PORT, { label: 'port:compute-policy', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL Tier-1 verifier for the compute_policy_rules port. REFUTE that the TS computePolicyRules matches the frozen compute_policy_rules_activity value-for-value over fixture workspaces.',
  STYLE,
  'Built: ' + JSON.stringify(port).slice(0, 600),
  'Independently drive BOTH the frozen Python (' + PY + ', the chain: discover_guideline_files + extract_rules + resolve_guidance, or compute_policy_rules_activity) and the TS computePolicyRules via a throwaway tools/parity/_pol_scratch.ts (npx tsx; DELETE after — do NOT leave scratch in tools/parity, it breaks tsc). Same fixture workspace dir + same inputs on both sides; byte-compare ComputedPolicyRulesV1:',
  '1. DISCOVERY + BUNDLES: a workspace with a root guideline file + a nested docs/ guideline + a changed_path that the nested rules scope to -> the per-path bundles match (rules, scope, ordering, dedup) in BOTH.',
  '2. FNMATCH custom_patterns: a custom_pattern like "docs/**/*.md" or "*.guidelines" matching some files and not others -> the SAME files discovered in BOTH (this is the fnmatch-parity risk; probe * / ? / [seq] patterns).',
  '3. FILE CAP: more guideline files than MAX_GUIDELINE_FILES_PER_REPO -> truncated=true AND the SAME surviving file set + order in BOTH.',
  '4. SYMLINK GUARD: a guideline file that is a symlink resolving OUTSIDE the workspace -> REJECTED (absent from discovered.files) in BOTH.',
  '5. KNOWLEDGE SHORT-CIRCUIT: knowledge_enabled=false -> ComputedPolicyRulesV1{bundles:{}, truncated:false} WITHOUT walking the workspace, in BOTH (even if the workspace has guideline files).',
  '6. NO-RULES PATH: a changed_path with no applicable rules -> an empty ResolvedGuidanceBundleV1 (not missing) in BOTH; the typed input (ComputePolicyRulesInputV1, ADR-0047) + computePolicyRules registered in worker/registry.ts.',
  'Run (cd ' + REPO + ' && npx vitest run <the policy_compute tests>) + check_clock_random; tsc clean (delete scratch BEFORE tsc). verdict=WEAK if the discovered file set, the fnmatch matching, the cap/truncated, the symlink guard, the short-circuit, or any per-path bundle diverges from Python; SOUND otherwise. Exact diverging fixture for any failure. Clean up scratch (your files only).',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:compute-policy', phase: 'Verify', schema: VERIFY_SCHEMA })

return { port, verify }
