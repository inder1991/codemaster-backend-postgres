export const meta = {
  name: 'phase21-review-parser',
  description: 'bedrock sub-part 2: the review response parser — parse_tool_use (coerce → ReviewFindingV1/ArbitrationIntentV1) + _parse_with_skip_malformed (skip-malformed, inv-14 scope enforcement, inv-15 evidence-refs subset check, counters). Deterministic; Tier-1 parity vs frozen Python over the response fixtures',
  phases: [
    { title: 'Port', detail: 'tool-block parser + skip-malformed loop + scope/evidence enforcement + the pipeline_metrics counters' },
    { title: 'Verify', detail: 'adversarial Tier-1 vs frozen Python: clean/N-findings/malformed-skip/scope-drop/evidence-subset over the bedrock/review_chunk fixtures + constructed cases' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC_TS = REPO + '/vendor/codemaster-py/codemaster/review/tool_schema.py'
const SRC_ACT = REPO + '/vendor/codemaster-py/codemaster/review/activities.py'
const FIX = REPO + '/vendor/codemaster-py/tests/cassettes/bedrock/review_chunk'

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
  'IMPORTS: #contracts/* , #platform/* , #backend/* ; same-dir relative ./x.js.',
  'ALREADY PORTED + REUSE — DO NOT re-implement: #backend/llm/contract_coercion.js (coerceForContract — the LLM-output coercion). #backend/security/output_safety.js (if parse applies output-safety). the finding-authority oracle ported during compute_policy (activityMayEmitScope — grep apps/backend/src/backend for it: policy/ or review/; it takes (activityName, scope) -> boolean). #backend/llm/review_prompt.js exports REVIEW_TOOL_NAME + ARBITRATION_INTENT_TOOL_NAME (and the schemas) — IMPORT the NAMES, do NOT redefine. #platform/observability/metrics.js (getMeter — for the counters). Contracts: #contracts/review_findings.v1.js (ReviewFindingV1 + FindingScope), #contracts/arbitration_intent.v1.js (ArbitrationIntentV1), #contracts/review_chunk_response.v1.js (ReviewChunkResponseV1).',
  'PARITY TOOLING (established Tier-1): a DEDICATED tools/parity/run_review_parser_ref.py + test/parity/review_parser_oracle.ts driving frozen Python via ' + PY + '. Compare the parsed (findings, intents) tuples — ReviewFindingV1 carries a bare-float confidence (strip from the canonical compare + assert structurally, the established pattern).',
  'GATE: apps/** + libs/**/src scanned by check_clock_random (parser is pure, no Date/Math.random/setTimeout) + check_tenant_scoped_raw_sql (no DB). NO NEW DEPS. Frozen Python READ-ONLY at vendor/codemaster-py.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit; CLEAN UP scratch (UNIQUE name; delete from tools/parity). You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

phase('Port')

const PORT = [
  'Port the review-response PARSER 1:1 to TypeScript (bedrock sub-part 2). It parses the LLM tool_use response blocks into findings + arbitration intents, enforcing the activity-boundary invariants. Deterministic (blocks -> findings); the inv-14/15 enforcement layer.',
  STYLE,
  'READ FULLY: ' + SRC_TS + ' (332 lines: REVIEW_TOOL_NAME/ARBITRATION_INTENT_TOOL_NAME, ReviewFindingParseError, parse_tool_use at line 248 — for a tool_use block named report_finding it does coerce_for_contract(payload, ReviewFindingV1, _block_id) then ReviewFindingV1.model_validate; for report_arbitration_intent -> ArbitrationIntentV1; non-tool/text blocks ignored; malformed -> ReviewFindingParseError) and ' + SRC_ACT + ' _parse_with_skip_malformed (line ~865 — the per-block loop: parse_tool_use([block]) with skip-on-ReviewFindingParseError; then the inv-14 SCOPE enforcement [activity_may_emit_scope("bedrock_review_chunk", finding.scope) -> drop + record_finding_scope_violation_attempted]; then the inv-15 EVIDENCE-REFS check [allowed_evidence_ids None=disabled / frozenset()=none-allowed / subset-check; empty refs -> pass + record_findings_without_evidence_refs(manifest_present); invalid refs -> drop + record_finding_evidence_ref_invalid(source=parser)]).',
  'PORT TO:',
  '- ' + REPO + '/apps/backend/src/backend/review/tool_schema.ts — REVIEW_FINDING_PARSE_ERROR class (ReviewFindingParseError, carries block_id + reason) + parseToolUse(blocks: Array<Record<string,unknown>>): [ReviewFindingV1[], ArbitrationIntentV1[]] (coerceForContract -> ReviewFindingV1.parse / ArbitrationIntentV1.parse; the tool-name dispatch via the imported REVIEW_TOOL_NAME / ARBITRATION_INTENT_TOOL_NAME). Mirror the Python malformed-detection (what triggers ReviewFindingParseError — read precisely: missing input, wrong shape, coercion/validation failure -> raise with the block_id + reason).',
  '- ' + REPO + '/apps/backend/src/backend/review/chunk_response_parser.ts — parseWithSkipMalformed(blocks, { allowedEvidenceIds?: ReadonlySet<string> | null }): { findings: ReviewFindingV1[]; intents: ArbitrationIntentV1[] }. The per-block skip-malformed loop + the scope-authority drop (activityMayEmitScope) + the evidence-refs subset enforcement, EXACTLY mirroring the Python branch logic (None disables; empty set forbids; subset check; empty-refs pass-with-counter). Emit the 3 counters via getMeter (record_finding_scope_violation_attempted{scope_emitted}, record_finding_evidence_ref_invalid{source="parser"}, record_findings_without_evidence_refs{source_present_in_manifest}) — bounded-cardinality labels ONLY. Per inv-14 the scope-violation counter is SINGLE-SOURCED here at the parser.',
  'TIER-1 PARITY: tools/parity/run_review_parser_ref.py drives the frozen _parse_with_skip_malformed over given (blocks, allowed_evidence_ids) and dumps (findings, intents) as JSON. test/parity/review_parser_oracle.ts + the test run the TS parser on the SAME inputs + assert byte-parity. Cover (use the response.content blocks from ' + FIX + '/{clean,five_findings,fifty_findings,malformed_block}.yaml AS the block inputs + constructed cases): clean text-only -> 0 findings; five_findings -> 5; fifty_findings -> 50; malformed_block -> the bad block SKIPPED + the good ones kept; a finding with scope=cross_chunk / pr_global -> DROPPED (activity is chunk-scoped); allowed_evidence_ids=null -> evidence validation disabled; frozenset() -> any non-empty refs dropped; a subset of allowed ids -> kept; a finding with refs NOT a subset -> dropped. confidence float stripped from the canonical compare + asserted structurally.',
  'Return component="review_parser", files_written, commands, all_green, notes (the parse_tool_use malformed triggers, the scope + evidence enforcement branch map, the counters single-sourced at the parser, the coerce_for_contract reuse, and any divergence risk for the verifier).',
].join('\n')

const port = await agent(PORT, { label: 'port:review-parser', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL Tier-1 verifier for the review-response parser. REFUTE that the TS parseWithSkipMalformed matches the frozen _parse_with_skip_malformed value-for-value over blocks + allowed_evidence_ids.',
  STYLE,
  'Built: ' + JSON.stringify(port).slice(0, 600),
  'Independently drive BOTH the frozen Python (' + PY + ', codemaster.review.activities._parse_with_skip_malformed) and the TS parseWithSkipMalformed via a throwaway tools/parity/_revparse_scratch.ts (npx tsx; DELETE after — UNIQUE name). Use the SAME (blocks, allowed_evidence_ids); byte-compare the (findings, intents) — confidence float stripped + asserted structurally:',
  '1. FIXTURES: the response.content blocks from ' + FIX + '/{clean,five_findings,fifty_findings,malformed_block}.yaml -> finding counts 0/5/50 and the malformed block SKIPPED (others kept). Match Python.',
  '2. SCOPE ENFORCEMENT (inv-14): a finding with scope=cross_chunk or pr_global -> DROPPED (bedrock_review_chunk is chunk-scoped) in BOTH; a chunk_observed finding kept. The drop count + the surviving set match.',
  '3. EVIDENCE-REFS (inv-15): allowed_evidence_ids=null -> NO validation (all findings kept regardless of refs); frozenset() -> any finding with non-empty refs DROPPED; a non-empty allowed set -> findings whose refs ⊆ allowed kept, refs ⊄ allowed DROPPED, empty-refs KEPT. Match Python in every branch.',
  '4. MALFORMED-SKIP: a deliberately malformed tool block (missing input / wrong shape) -> SKIPPED (not fatal) while sibling good blocks parse; arbitration-intent malformed silently skipped. Match Python.',
  '5. ARBITRATION INTENTS: a report_arbitration_intent block -> an ArbitrationIntentV1 in the intents tuple; mixed finding+intent blocks split correctly.',
  'Run (cd ' + REPO + ' && npx vitest run <the parser tests>) + check_clock_random; tsc clean (delete scratch first). verdict=WEAK if the parsed findings/intents, the scope drops, the evidence-refs branch behavior, or the malformed-skip diverges from Python; SOUND otherwise. Exact diverging blocks for any failure. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:review-parser', phase: 'Verify', schema: VERIFY_SCHEMA })

return { port, verify }
