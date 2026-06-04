export const meta = {
  name: 'phase21-review-client',
  description: 'post sub-part 2: GhReviewClient — port integrations/github/review_client.py (CreatedReviewV1 + find_existing_review_by_marker / create_review [event=COMMENT, 2-call comment-IDs] / update_review [PUT] + the issue-comment methods) over the ported GitHubApiClient; REST-shape parity vs frozen Python',
  phases: [
    { title: 'Port', detail: 'CreatedReviewV1 + GhReviewClient type + GitHubApiReviewClient (6 REST methods) over GitHubApiClient' },
    { title: 'Verify', detail: 'adversarial REST-shape parity vs frozen GhReviewHttpClient: find/create(2-call comment-ids)/update(PUT)/issue-comment; event=COMMENT invariant' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC = REPO + '/vendor/codemaster-py/codemaster/integrations/github/review_client.py'

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
  'ALREADY PORTED + REUSE: apps/backend/src/backend/integrations/github/api_client.ts (GitHubApiClient) + check_run_client.ts (the SIBLING just landed — mirror its shape: a typed client over the GitHubApiClient, tested via a recording GitHubHttpClient transport stub). FIRST check whether GitHubApiClient exposes generic get/post/put/delete helpers (the Python review_client calls self._api.get/post/put/delete with installation_id + json); if it does NOT, add the minimal generic REST helpers to GitHubApiClient (over its existing _request) — mirror how check_run_client got its requests through (consistent with that sibling).',
  'PARITY TOOLING: REST-shape parity — drive the frozen Python GhReviewHttpClient + the TS client over a RECORDING stub of the GitHub HTTP transport, byte-compare the emitted method/url/json. A DEDICATED tools/parity/run_review_client_ref.py + test/parity/review_client_oracle.ts if the generic oracle does not fit; or a recording-stub vitest test (mirror the check_run_client real-wire test).',
  'GATE: apps/** + libs/**/src scanned by check_clock_random + check_tenant_scoped_raw_sql (no DB here). NO NEW DEPS. Frozen Python READ-ONLY at vendor/codemaster-py.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit; CLEAN UP any scratch (delete from tools/parity). You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

phase('Port')

const PORT = [
  'Port the GitHub review client 1:1 to TypeScript (post sub-part 2). It is the GitHub-Reviews-API surface the post_review_results activity (the next, big sub-part) depends on. Clean, no DB, no Temporal activity — just the REST client.',
  STYLE,
  'READ FULLY: ' + SRC + ' (249 lines: CreatedReviewV1 dataclass + GhReviewHttpClient with 6 methods). Port EVERY method 1:1 with the EXACT endpoints/bodies:',
  '- CreatedReviewV1: { review_id: number; comment_ids: ReadonlyArray<number> } — INTERNAL return of create_review (client→activity; does NOT cross the Temporal boundary, so a plain exported TYPE in review_client.ts is fine — NOT a versioned contract, unlike the activity-boundary PostedCheckRunV1). Document the invariant: comment_ids length == comments GitHub accepted (the activity layer asserts this — invariant-12 comment_ids length-mismatch).',
  '- findExistingReviewByMarker({owner, repo, prNumber, marker}): GET /repos/{owner}/{repo}/pulls/{prNumber}/reviews → first page; return the id of the FIRST review whose body CONTAINS marker (skip body==null); else null.',
  '- createReview({owner, repo, prNumber, body, commitId, comments}): POST /repos/{owner}/{repo}/pulls/{prNumber}/reviews with body {commit_id, body, event:"COMMENT" (HARD-CODED — invariant 9; the type must NOT expose an event param so APPROVE/REQUEST_CHANGES is structurally impossible), comments}. Parse review_id from the response id. THEN, ONLY if comments is non-empty: GET /repos/{owner}/{repo}/pulls/{prNumber}/reviews/{review_id}/comments → comment_ids = the response comments\' ids IN ORDER (GitHub returns id-ascending == submission order). Empty comments → comment_ids=[] and SKIP the GET. Return CreatedReviewV1.',
  '- updateReview({owner, repo, prNumber, reviewId, body}): PUT (NOT PATCH — reviews use PUT, unlike check-runs) /repos/{owner}/{repo}/pulls/{prNumber}/reviews/{reviewId} with {body}.',
  '- createIssueComment({owner,repo,prNumber,body}): POST /repos/{owner}/{repo}/issues/{prNumber}/comments {body} → id. listIssueComments({owner,repo,prNumber}): GET /repos/{owner}/{repo}/issues/{prNumber}/comments → array. deleteIssueComment({owner,repo,commentId}): DELETE /repos/{owner}/{repo}/issues/comments/{commentId} (NO pr_number in the URL — global comment id). These serve the (future) placeholder activities; port them now to complete the client file.',
  'PORT TO ' + REPO + '/apps/backend/src/backend/integrations/github/review_client.ts: the CreatedReviewV1 type + a GhReviewClient type (the 6-method surface, args-object, camelCase) + a concrete GitHubApiReviewClient implementing it over an injected GitHubApiClient + installationId (constructor validates installationId>=1). If GitHubApiClient lacks generic get/post/put/delete, add them minimally over _request (same file as api_client.ts) — note that in your return.',
  'TEST ' + REPO + '/test/unit/integrations/github/review_client.test.ts (recording GitHubHttpClient transport stub, mirror the check_run_client real-wire test): assert the EXACT method/url/json for each method; create_review with comments → TWO requests (POST review then GET comments) + comment_ids parsed in order; create_review with NO comments → ONE request (POST only), comment_ids=[]; event is ALWAYS "COMMENT" (the invariant-9 pin — there is no way to send APPROVE/REQUEST_CHANGES); update uses PUT; delete_issue_comment URL omits pr_number.',
  'Return component="review_client", files_written, commands, all_green, notes (whether you added generic get/post/put/delete to GitHubApiClient, the create_review 2-call comment-ids flow, the event=COMMENT invariant pin, CreatedReviewV1 as a plain type not a contract + why).',
].join('\n')

const port = await agent(PORT, { label: 'port:review-client', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL verifier for the GitHub review client port. REFUTE that the TS GitHubApiReviewClient issues the same REST requests + parses CreatedReviewV1 the same as the frozen GhReviewHttpClient.',
  STYLE,
  'Built: ' + JSON.stringify(port).slice(0, 600),
  'Independently drive BOTH the frozen Python GhReviewHttpClient (' + PY + ', over a recording stub of its GitHubApiClient) and the TS GitHubApiReviewClient (over a recording GitHubHttpClient transport) via a throwaway tools/parity/_rev_scratch.ts (npx tsx; DELETE after — never leave scratch in tools/parity):',
  '1. FIND-BY-MARKER: GET pulls/{n}/reviews; returns the FIRST review whose body contains the marker (skips body==null, skips non-matching); null when none match. Byte-equal request + result in BOTH.',
  '2. CREATE with comments: POST pulls/{n}/reviews body {commit_id, body, event:"COMMENT", comments} → THEN GET pulls/{n}/reviews/{id}/comments → comment_ids in returned order. Confirm BOTH requests + the CreatedReviewV1{review_id, comment_ids} match. CREATE with EMPTY comments: only the POST (no GET), comment_ids=[].',
  '3. EVENT INVARIANT (invariant 9): the create body ALWAYS has event="COMMENT"; the client type exposes NO way to send APPROVE/REQUEST_CHANGES. Confirm structurally.',
  '4. UPDATE: PUT (not PATCH/POST) pulls/{n}/reviews/{id} {body}.',
  '5. ISSUE COMMENTS: createIssueComment POST issues/{n}/comments; listIssueComments GET issues/{n}/comments; deleteIssueComment DELETE issues/comments/{id} (NO pr_number). Match Python.',
  'Run (cd ' + REPO + ' && npx vitest run test/unit/integrations/github/review_client.test.ts) + check_clock_random; tsc clean (delete scratch before tsc). verdict=WEAK if any method/url/body, the create 2-call flow, the comment-id ordering, or the event=COMMENT invariant diverges from Python; SOUND otherwise. Exact diverging request for any failure. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:review-client', phase: 'Verify', schema: VERIFY_SCHEMA })

return { port, verify }
