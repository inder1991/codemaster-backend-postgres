export const meta = {
  name: 'phase21-post-review',
  description: 'post sub-part 3 (THE core): post_review_results _do_post — the invariant-12 publication-outcome state machine (2-phase atomic claim + stale-write guard + won-claim body-only ladder + lost-claim age-gating + IFF CHECK), real-PG parity vs frozen Python',
  phases: [
    { title: 'Port', detail: '_do_post + _attempt_create_with_body_only_fallback + _record_publication_outcome + _build_review_body + the activity + typed input; real-PG integration test' },
    { title: 'Verify', detail: '2-lens adversarial vs frozen Python on the disposable PG: won-claim (inline/body-only/double-422-degraded/comment-mismatch) + lost-claim/stale-write/IFF' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const DSN = 'postgresql://postgres:postgres@localhost:5434/codemaster'
const SRC = REPO + '/vendor/codemaster-py/codemaster/activities/post_review_results.py'

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
  'ALREADY PORTED + REUSE — DO NOT re-implement: #backend/integrations/github/review_client.js (GhReviewClient + CreatedReviewV1 — find_existing_review_by_marker / create_review / update_review). #backend/domain/stale_write_guard.js (assertCurrentRun — the AD-4 guard; takes the open Kysely tx). #platform/db/database.js (tenantKysely / getPool — the SHARED ADR-0062 pool; NEVER new Pool). #platform/clock.js. #contracts/posted_review.v1.js (PostedReviewV1 + PublicationOutcome — the activity RETURN; the IFF superRefine: publication_outcome=degraded_unposted IFF review_id null). #contracts/walkthrough.v1.js (PrMetaV1). #contracts/dropped_classification.v1.js. #backend/infra/post_commit_emit.js (PendingEmits) if outcome counters are emitted.',
  'DATABASE: a DISPOSABLE Postgres is RUNNING + migrated — DSN ' + DSN + ' (core.posted_reviews present with the IFF CHECK `(publication_outcome=degraded_unposted AND github_review_id IS NULL) OR (publication_outcome<>degraded_unposted AND github_review_id IS NOT NULL)` + the enum CHECK + pk(pr_id)). NEVER touch any other DB. Integration tests under test/integration/** use test/integration/_db.ts (describeDb / INTEGRATION_DSN) — SKIP without CODEMASTER_PG_CORE_DSN. Seed the FK chain like the existing review_findings/stale_write_guard integration tests (installations→repositories→gh_users→pull_requests→pull_request_reviews[current_run_id]→review_runs); posted_reviews.pr_id is the PR id.',
  'GATE: apps/** + libs/**/src scanned by check_clock_random (time via Clock) + check_tenant_scoped_raw_sql (raw SQL on core.posted_reviews must carry installation_id OR a justified inline marker — posted_reviews is keyed by pr_id PK; use the inline `// tenant:exempt reason=... follow_up=...` marker idiom like the stale_write_guard/mutex ports). NO NEW DEPS. Frozen Python READ-ONLY at vendor/codemaster-py.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit. tools/parity holds TRACKED ref drivers — remove ONLY your own scratch, NEVER rm -rf tools/parity. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN="' + DSN + '" npx vitest run <your integration test>); (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx tsx scripts/gates/check_tenant_scoped_raw_sql.ts); and confirm the integration test SKIPS cleanly with NO DSN.',
].join('\n')

phase('Port')

const PORT = [
  'Port post_review_results._do_post 1:1 to TypeScript (post sub-part 3 — THE core). This is the most intricate activity in the codebase: the CLAUDE.md invariant-12 publication-outcome state machine over a 2-phase atomic-claim flow. Faithfulness here is load-bearing.',
  STYLE,
  'READ FULLY: ' + SRC + ' (1891 lines). Port: _do_post (~1202), _attempt_create_with_body_only_fallback (~1773), _record_publication_outcome, _build_review_body (~412), the PostReviewResultsActivity.post_review_results activity (~1862), the typed errors (PostReviewTransientError + the per-call cap / comment-mismatch raises), and the constants (the marker literal, IN_FLIGHT_WINDOW age, any per-call cap). Read the extensive module docstrings — they ARE the spec for the branches.',
  'THE 2-PHASE ATOMIC-CLAIM FLOW (port EXACTLY — this is the durable mutation seam):',
  '- PHASE 1 (claim): db.transaction: assertCurrentRun(tx, runId, reviewId, site="post_review_results._do_post") [AD-4 stale-write guard — a superseded run must NOT win the claim; a violation RAISES]; then INSERT INTO core.posted_reviews (pr_id, marker) VALUES (...) ON CONFLICT (pr_id) DO NOTHING RETURNING pr_id; commit. wonClaim = a row was returned. (The Phase-1 INSERT intentionally OMITS github_review_id+publication_outcome → relies on the column DEFAULTs degraded_unposted/NULL, which satisfy the IFF CHECK as a placeholder.)',
  '- IF WON: call _attempt_create_with_body_only_fallback (create the GitHub review via the injected GhReviewClient): try createReview WITH inline comments → on a 422 (inline-comment-position rejection) RETRY body-only (no comments) → BODY_ONLY_POSTED; on a DOUBLE 422 → return DEGRADED_UNPOSTED *without raising* (the row keeps github_review_id NULL = the degraded marker). Then PHASE 2 via _record_publication_outcome: UPDATE core.posted_reviews SET github_review_id=..., publication_outcome=... — the IFF CHECK enforces (inline/body_only → review_id NOT NULL ; degraded → NULL). On the success ladder set INLINE_POSTED (comments accepted) vs BODY_ONLY_POSTED.',
  '- IF LOST: SELECT github_review_id from the row. NON-NULL → a prior winner published; dispatch updateReview (idempotent body refresh) and INHERIT that row\'s publication_outcome (read it from the row — do NOT hardcode INLINE_POSTED). NULL github_review_id → the winner is still in-flight: if within IN_FLIGHT_WINDOW (now - posted_at) RAISE PostReviewTransientError (Temporal retries); if PAST the window, treat the NULL row as the degraded marker and return the inherited DEGRADED_UNPOSTED *without mutating the row*.',
  'INVARIANTS (must hold): (1) The activity NEVER raises on DEGRADED_UNPOSTED — it is a typed PostedReviewV1.publication_outcome value, NOT an exception. Activity-level RAISE is reserved for: stale-write guard violation, per-call cap breach, GitHub auth/permission errors, the comment_ids length-mismatch data-quality invariant, and the in-flight PostReviewTransientError. (2) comment_ids LENGTH-MISMATCH: assert len(created.comment_ids) == the number of kept inline findings — RAISE if GitHub returned a partial set (data-quality). (3) The IFF: publication_outcome=degraded_unposted ↔ github_review_id IS NULL — enforced BOTH by the DB CHECK and the PostedReviewV1 superRefine. (4) event is always COMMENT (handled inside the review client). (5) the lost-claim path reads the persisted publication_outcome to emit the INHERITED outcome.',
  'INPUT: the frozen activity input (read its actual shape — pr_meta, walkthrough/body inputs, the kept inline findings/comments, run_id, review_id, commit_id, owner, repo, marker, etc.). Port it as a TYPED single-arg envelope (PostReviewInputV1 — ADR-0047; if the frozen Python already dispatches a typed model use it, else introduce the envelope, consistent with the other ports). RETURN PostedReviewV1.',
  'PORT TO: ' + REPO + '/apps/backend/src/backend/activities/post_review_results.activity.ts (the doPost state machine + the helpers + the postReviewResults activity) + ' + REPO + '/libs/contracts/src/post_review_input.v1.ts (the typed input envelope) IF an input contract is needed (+ parity test). Use db.transaction for the 2 phases; assertCurrentRun + the review client are INJECTED. REGISTER postReviewResults in ' + REPO + '/apps/backend/src/backend/worker/registry.ts (additive; workflow untouched). Port _build_review_body faithfully (the walkthrough markdown + the marker — drive parity on the body string).',
  'INTEGRATION TEST ' + REPO + '/test/integration/activities/post_review_results.integration.test.ts (describeDb; seed the FK chain incl. pull_request_reviews.current_run_id + review_runs; inject a STUB GhReviewClient scripting create/find/update + their 422s): WON happy inline (create accepts comments → row github_review_id set, publication_outcome=inline_posted, returns INLINE_POSTED); WON body-only (create 422 then body-only ok → BODY_ONLY_POSTED); WON double-422 (→ DEGRADED_UNPOSTED, row github_review_id stays NULL, NO raise); comment_ids mismatch (create returns fewer ids than kept findings → RAISES); LOST non-null (a pre-seeded posted_reviews row with github_review_id → updateReview dispatched + inherited outcome); LOST in-flight (pre-seeded NULL row within window → RAISES PostReviewTransientError); LOST past-window (NULL row past window → DEGRADED_UNPOSTED inherited, no mutation); SUPERSEDED run (current_run_id != runId → assertCurrentRun RAISES StaleWriteError, no claim). Assert the core.posted_reviews row state (github_review_id, publication_outcome) AND the returned PostedReviewV1 for each.',
  'Return component="post_review_results", files_written, commands, all_green, notes (the 2-phase flow as ported, the won/lost branches, the IN_FLIGHT_WINDOW value + the per-call cap, the comment-mismatch + degraded-never-raises invariants, the input envelope, the tenancy-marker on the posted_reviews SQL, and any divergence risk for the verifier).',
].join('\n')

const port = await agent(PORT, { label: 'port:post-review', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY_COMMON = [
  STYLE,
  'BUILT: ' + JSON.stringify(port).slice(0, 500),
  'You are an ADVERSARIAL verifier. The disposable PG at ' + DSN + ' is the SHARED ground truth. Drive the FROZEN PYTHON _do_post against it (construct the Python activity/helper over the SAME PG — vendor venv has SQLAlchemy; DSN postgresql+asyncpg://postgres:postgres@localhost:5434/codemaster or +psycopg) via a throwaway tools/parity/run_post_review_ref.py + drive the TS doPost via tools/parity/_postrev_scratch.ts (npx tsx). Both inject a STUB GhReviewClient (same scripted responses). Remove ONLY your own scratch; NEVER rm -rf tools/parity. Byte-compare the resulting core.posted_reviews row(s) (github_review_id, publication_outcome) AND the returned PostedReviewV1.',
].join('\n')

const V1 = [
  'LENS 1 — WON-claim publication-outcome ladder. REFUTE that the inline / body-only / double-422-degraded / comment-mismatch branches match frozen Python.',
  VERIFY_COMMON,
  '1. INLINE happy: stub createReview accepts inline comments (returns review_id + matching comment_ids) → posted_reviews row gets github_review_id set + publication_outcome=inline_posted; PostedReviewV1.publication_outcome=inline_posted, review_id set, comment_ids match. Identical in BOTH.',
  '2. BODY-ONLY fallback: createReview raises/returns 422 on the inline attempt, succeeds body-only → publication_outcome=body_only_posted, github_review_id set, comment_ids empty. Identical in BOTH.',
  '3. DOUBLE-422 DEGRADED: both inline AND body-only 422 → publication_outcome=degraded_unposted, github_review_id stays NULL, the activity does NOT RAISE (degraded is a typed return). The IFF CHECK is satisfied (NULL ↔ degraded). Identical in BOTH.',
  '4. COMMENT-IDS MISMATCH: createReview returns FEWER comment_ids than kept inline findings → the activity RAISES (data-quality invariant) in BOTH.',
  'verdict=WEAK if any branch\'s row state, the returned outcome, or the raise/no-raise decision diverges from Python; SOUND otherwise. Exact diverging scenario for any failure. Run the author integration test (with the DSN) + the gates. Clean up scratch.',
].join('\n')

const V2 = [
  'LENS 2 — atomic claim + lost-claim age-gating + stale-write guard + IFF. REFUTE that the claim/lost/guard branches match frozen Python.',
  VERIFY_COMMON,
  '1. ATOMIC CLAIM: two concurrent _do_post for the SAME pr_id → exactly ONE wins the ON CONFLICT DO NOTHING claim; the loser takes the lost-claim path. Never two winners.',
  '2. LOST non-null: a pre-existing posted_reviews row with github_review_id set + publication_outcome=inline_posted → the loser dispatches updateReview (idempotent) and INHERITS inline_posted (reads it from the row, does NOT hardcode). Identical in BOTH.',
  '3. LOST in-flight: a pre-existing row with github_review_id NULL whose posted_at is WITHIN IN_FLIGHT_WINDOW → RAISES PostReviewTransientError (retryable) in BOTH; the row is NOT mutated.',
  '4. LOST past-window: NULL github_review_id row whose posted_at is PAST the window → returns DEGRADED_UNPOSTED inherited, NO mutation, NO raise. Identical in BOTH. (Confirm the IN_FLIGHT_WINDOW boundary value matches Python.)',
  '5. STALE-WRITE: pull_request_reviews.current_run_id != the runId passed → assertCurrentRun RAISES StaleWriteError BEFORE the claim INSERT (a superseded run cannot win the claim); no posted_reviews row is created. Identical in BOTH.',
  '6. IFF CHECK: confirm the DB CHECK + the PostedReviewV1 superRefine both enforce publication_outcome=degraded_unposted ↔ github_review_id IS NULL; a (degraded, non-null) or (inline, null) write is rejected on BOTH the DB and contract layers.',
  'verdict=WEAK if the claim atomicity, the lost-claim inheritance, the in-flight-window raise vs past-window-degraded boundary, the stale-write guard, or the IFF enforcement diverges from Python; SOUND otherwise. Exact diverging scenario for any failure. Run the author integration test + the gates. Clean up scratch.',
].join('\n')

const verifications = await parallel([
  () => agent(V1, { label: 'verify:won-ladder', phase: 'Verify', schema: VERIFY_SCHEMA }),
  () => agent(V2, { label: 'verify:claim-lost-iff', phase: 'Verify', schema: VERIFY_SCHEMA }),
])

return { port, verify: { wonLadder: verifications[0], claimLostIff: verifications[1] } }
