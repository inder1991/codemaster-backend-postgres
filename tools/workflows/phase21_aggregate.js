export const meta = {
  name: 'phase21-aggregate',
  description: 'Phase 2.1 first activity: aggregate_findings — typed AggregateFindingsInputV1 envelope (closes the inv-11 positional-dispatch violation) + the deterministic aggregate core (scope-consistency, exact dedup, rank+cap) + skip-path semantic, Tier-1 parity vs frozen Python',
  phases: [
    { title: 'Port', detail: 'AggregateFindingsInputV1 contract + aggregation core (scope/exact/rank-cap) + skip-path semantic seam + activity + worker registration' },
    { title: 'Verify', detail: 'adversarial Tier-1 parity vs frozen _do_aggregate: dedupe_stats, scope drops, exact-dedup ordering, rank+cap, semantic_skipped path' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC_ACT = REPO + '/vendor/codemaster-py/codemaster/review/aggregate_activity.py'
const SRC_AGG = REPO + '/vendor/codemaster-py/codemaster/review/aggregation.py'
const SRC_SEM = REPO + '/vendor/codemaster-py/codemaster/review/aggregation_semantic.py'

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
  'TS STYLE (validate-fast = gates -> lint -> typecheck -> test): ESM .js import specifiers; "type" alias not "interface"; Array<T>; NO any (unknown+narrow); named exports; explicit return types; import { type X }; no unused vars; snake_case FILENAMES; camelCase members.',
  'IMPORTS: #contracts/* (libs/contracts/src), #platform/* (libs/platform/src), #backend/* (apps/backend/src/backend); same-dir relative ./x.js.',
  'PARITY TOOLING (the established Tier-1 pattern — see tools/parity/run_*_ref.py + test/parity/*_oracle.ts): a DEDICATED Python ref driver tools/parity/run_aggregate_ref.py (NOT the generic run_python_ref.py — that canonicalizes/rejects bare floats; aggregate findings carry a confidence float) + a TS oracle test/parity/aggregate_oracle.ts. Drive the frozen Python via ' + PY + ' (can import codemaster.*). The contracts ReviewFindingV1 + AggregatedFindingsV1 (+ DedupeStatsV1) are ALREADY ported in libs/contracts/src; confidence float is stripped before the canonical compare + asserted structurally (the established bare-float handling).',
  'GATE: apps/** + libs/**/src scanned by check_clock_random (no Date/Math.random/setTimeout outside seams) + check_tenant_scoped_raw_sql (aggregate touches no DB — N/A). NO NEW DEPS. Frozen Python READ-ONLY at vendor/codemaster-py.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

phase('Port')

const PORT = [
  'Port the aggregate_findings activity + its deterministic core 1:1 to TypeScript (Phase 2.1, first activity). This establishes the activity-port pattern (typed envelope -> activity -> worker registration -> Tier-1 parity) that the remaining core-loop activities reuse.',
  STYLE,
  'READ FULLY: ' + SRC_ACT + ' (the @activity.defn aggregate_findings + _do_aggregate pipeline), ' + SRC_AGG + ' (the PURE functions: aggregate_exact, rank_and_cap, and find assert_finding_scope_consistency — it may live here or in a policy/finding_authority module; FOLLOW the import), ' + SRC_SEM + ' (aggregate_semantic + the semantic_skipped fallback).',
  'THE PIPELINE (_do_aggregate, port EXACTLY): input_count=len(findings); (after_scope, _dropped)=assert_finding_scope_consistency(findings) [drops findings whose scope != CHUNK_OBSERVED — structural typed FindingScope check, the invariant-14 enforcement; port its authority oracle activity_may_emit_scope / finding_authority registry too if not already in TS]; after_exact=aggregate_exact(after_scope); exact_dropped=len(after_scope)-len(after_exact); (after_semantic, semantic_skipped)=aggregate_semantic(after_exact, embedder); semantic_merged=len(after_exact)-len(after_semantic); (after_cap, capped)=rank_and_cap(after_semantic); return AggregatedFindingsV1{findings: after_cap, dedupe_stats: {input_count, exact_dropped, semantic_merged, capped, semantic_skipped}, policy_revision}. Preserve aggregate_exact dedup KEY + ordering, and rank_and_cap rank ORDER + the cap constant EXACTLY (read the source — order is observable + parity-significant).',
  'SEMANTIC SKIP-PATH (the deterministic boundary): aggregate_semantic does the Qwen embedder merge and returns semantic_skipped=True on embedder failure/absence. Port the seam so that with NO embedder (embedder undefined/null) it SKIPS: after_semantic=after_exact, semantic_skipped=true, semantic_merged=0. The REAL Qwen semantic merge is DEFERRED (needs the Qwen EmbeddingsPort — a separate sub-project; tracked FOLLOW-UP-aggregate-semantic-qwen). Document this clearly; the activity for now constructs with no embedder (skip path).',
  'PORT TO:',
  '- ' + REPO + '/libs/contracts/src/aggregate_findings.v1.ts — AggregateFindingsInputV1 (Zod): the TYPED ENVELOPE that REPLACES the Python 2-positional dispatch (findings: tuple, policy_revision: int) — closes the CLAUDE.md invariant-11 / ADR-0047 violation the Python carries. Fields: findings: z.array(ReviewFindingV1), policy_revision: z.number().int(), schema_version default 1. (There is NO Python Pydantic contract for this envelope — it is a NEW typed input we introduce during the port; note that in the file header. Add a parity test only for round-trip/validation since there is no Python counterpart to diff — assert it accepts a valid findings+policy_revision and rejects extras via .strict() if appropriate.)',
  '- ' + REPO + '/apps/backend/src/backend/review/aggregation.ts — aggregateExact, rankAndCap, assertFindingScopeConsistency (+ the finding-authority oracle if unported). Pure functions, deterministic, no clock/random/DB.',
  '- ' + REPO + '/apps/backend/src/backend/review/aggregation_semantic.ts — the aggregateSemantic seam (skip-path; deferred Qwen merge documented).',
  '- ' + REPO + '/apps/backend/src/backend/activities/aggregate_findings.activity.ts — export `aggregateFindings(input: AggregateFindingsInputV1): Promise<AggregatedFindingsV1>` that runs the _do_aggregate pipeline (no embedder -> skip path). Mirror the persist activity\'s structure (the sibling already-landed activity).',
  '- REGISTER it: add `aggregateFindings` to ' + REPO + '/apps/backend/src/backend/worker/registry.ts (the activities map) alongside persistReviewFindings. (Do NOT modify the workflow — aggregate is not yet wired into an orchestrator; that is 2.2.)',
  'TIER-1 PARITY: tools/parity/run_aggregate_ref.py drives the frozen Python _do_aggregate (construct findings as ReviewFindingV1, pass a no-op/failing embedder to force the skip path, policy_revision) and dumps the AggregatedFindingsV1 as JSON. test/parity/aggregate_oracle.ts runs the TS _doAggregate on the SAME findings + asserts the AggregatedFindingsV1 matches (findings list + ORDER + dedupe_stats), confidence-float stripped from the canonical compare + asserted structurally. Cover: passthrough (no dups), exact-dedup (2 identical findings -> 1, exact_dropped=1), scope-drop (a non-chunk_observed finding dropped), rank_and_cap (> the cap -> capped>0), semantic_skipped always True on the skip path, empty findings -> empty + zeroed stats.',
  'Return component="aggregate", files_written, commands, all_green, notes (the dedup key, the rank+cap order + cap constant, what finding-authority you had to port, the skip-path decision + the deferred Qwen follow-up, and the typed-envelope inv-11 closure).',
].join('\n')

const port = await agent(PORT, { label: 'port:aggregate', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL Tier-1 verifier for the aggregate_findings port. REFUTE that the TS _doAggregate matches the frozen Python _do_aggregate value-for-value on the deterministic (skip) path.',
  STYLE,
  'Built: ' + JSON.stringify(port).slice(0, 600),
  'Independently drive BOTH the frozen Python (' + PY + ', import codemaster.review.aggregate_activity._do_aggregate with a skip-forcing embedder) and the TS _doAggregate via a throwaway tools/parity/_agg_scratch.ts (npx tsx; DELETE after). For each scenario, build the SAME findings input and assert the AggregatedFindingsV1 matches (findings + ORDER + dedupe_stats), confidence float stripped from the byte-compare but asserted structurally + range:',
  '1. PASSTHROUGH: 3 distinct findings, none droppable -> all 3 returned in the SAME order; dedupe_stats {input_count:3, exact_dropped:0, semantic_merged:0, capped:0, semantic_skipped:true}.',
  '2. EXACT DEDUP: 2 byte-identical findings (same dedup key) + 1 distinct -> 2 returned; exact_dropped=1. Confirm the TS dedup KEY + which duplicate survives (first vs last) matches Python.',
  '3. SCOPE DROP: include a finding with scope != chunk_observed (e.g. pr_global) -> dropped by assertFindingScopeConsistency; confirm it is absent in BOTH and the input_count still counts it.',
  '4. RANK + CAP: feed MORE than the cap constant -> capped = overflow count in BOTH; the SURVIVING set + their ORDER match Python rank_and_cap exactly (the ranking is parity-significant).',
  '5. SEMANTIC_SKIPPED: on the no-embedder path, semantic_skipped is ALWAYS true and semantic_merged=0 in BOTH (the Qwen merge is deferred).',
  '6. EMPTY: 0 findings -> empty findings + dedupe_stats all-zero (input_count 0) in BOTH.',
  'ALSO: confirm AggregateFindingsInputV1 is a typed single-arg envelope (ADR-0047 / inv-11 closure — NOT 2 positional args) and aggregateFindings is registered in worker/registry.ts. Run (cd ' + REPO + ' && npx vitest run <the aggregate tests>) + check_clock_random + tsc clean (do NOT run tsc if your scratch would pollute it — delete scratch first, or run tsc before creating scratch).',
  'verdict=WEAK if the findings set/order, any dedupe_stat, the dedup key, the rank+cap survivors/order, or the scope-drop diverges from Python; SOUND otherwise. Exact diverging input+output for any failure. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:aggregate', phase: 'Verify', schema: VERIFY_SCHEMA })

return { port, verify }
