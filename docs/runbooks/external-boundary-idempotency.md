# External-boundary idempotency (W3.4)

The Postgres runner delivers side effects **at-least-once**: the outbox re-dispatches a row if a pod
crashes between a successful sink call and `markDispatched`, and a Temporal-free activity can be redriven
after a lease expiry. So **every external (non-LLM) side-effecting boundary must be idempotent** — a
redrive/retry must produce **no duplicate artifact**. This doc is the single source of truth for each
boundary's posture; every row is backed by a test (see the `Test` column).

> The LLM-call boundary is deliberately out of scope here (it's covered by the cost-journal + budget
> reservation path). This doc is the *non-LLM* external boundaries.

## The meta-boundary: the outbox

All the GitHub/posting side effects below are driven by `core.outbox` dispatch
(`runner/outbox_dispatcher_loop.ts` + `domain/repos/outbox_repo.ts`). Its contract:

- **At-least-once.** `claimPending` leases a row (`leased_until`) but leaves it `pending`; a crash before
  `markDispatched` lets the row be re-claimed after the lease expires → the sink runs **again**.
- **Per-row idempotency key.** The `outbox.id` is the canonical destination-side dedupe key
  (`SinkContext.outboxRowId`) — a destination that persisted *something* keyed on it can no-op a redrive.
- **Multi-pod fence (R-6).** Both settle paths guard `attempts = expected_attempts` (the claim-time
  snapshot): `markAttemptFailed` and (since the N2 fix) `markDispatched`. A stalled pod whose row was
  re-claimed + failed elsewhere (attempts incremented) becomes a **rowcount-0 no-op** instead of
  overwriting the newer outcome.
- **Bounded retry.** `markAttemptFailed` defers the lease by exponential backoff (2s→…→300s cap) and
  dead-letters at `maxAttempts` (`state='dead'`, lease released — never re-claimed).

So the question for each boundary below is: *given the sink can run twice, does it create a duplicate?*

## The boundaries

| Boundary | File | Idempotency key | Mechanism | Redrive posture | Test |
|---|---|---|---|---|---|
| **Check-run create/update** | `activities/post_check_run.activity.ts` + `integrations/github/check_run_client.ts` | `(owner, repo, head_sha, name)` | find-before-create: `findExistingCheckRun` **paginates** (Link rel=next, cap 20) → PATCH the existing run instead of POST | no duplicate — the existing run is found on any page and updated in place | `test/unit/integrations/github/check_run_client.test.ts` |
| **Review posting (inline comments)** | `activities/post_review_results.activity.ts` + `integrations/github/review_client.ts` | `pr_id` (DB claim) + a hidden `<!-- codemaster:review-marker:<pr_id> -->` in the body | `INSERT … core.posted_reviews ON CONFLICT (pr_id) DO NOTHING` atomic claim; lost-claim path SELECTs the persisted row + comment_ids and refreshes the body; the in-flight window is recovered by `findExistingReviewByMarker` (paginated, head-agnostic) | no duplicate review; a force-pushed head is handled by the marker scan (XM8), not by `head_sha` | `test/integration/activities/post_review_results*.integration.test.ts` |
| **PR-description summary** | `activities/update_pr_description_summary.activity.ts` | `<!-- codemaster-summary-start/end -->` markers | GET → strip the marked block → recompose with the same content → PATCH | idempotent by construction (strip-then-append converges) | `test/unit/activities/update_pr_description_summary.activity.test.ts` |
| **Fix-prompt comment** | `activities/generate_fix_prompt.activity.ts` | `<!-- codemaster:fix-prompt-marker:<review_id> -->` + a claim TTL | claim row; on redrive within TTL, `listIssueComments` scans the marker and recovers the comment id (no second POST); after TTL the claim is reclaimable | no duplicate comment | `test/integration/runner/review_job_shell_gates.integration.test.ts` |
| **Lifecycle finalization** | `activities/record_delivery_lifecycle.activity.ts` | the run row + `delivery_outcome IS NULL` guard | atomic `UPDATE … WHERE delivery_outcome IS NULL`; a redrive matches 0 rows | idempotent no-op (returns count 0) | `test/integration/activities/record_review_lifecycle.activity.integration.test.ts` |
| **Output-safety audit** | `activities/emit_output_safety_audit.activity.ts` | deterministic `uuid5(request_id, kinds, spans, stage)` | pre-INSERT `SELECT 1 … WHERE audit_event_id = …`; hit → COMMIT early | no duplicate audit row | `test/integration/activities/emit_output_safety_audit.activity.integration.test.ts` |
| **Blob archive (LLM payloads)** | `adapters/blobstore_postgres.ts` | `(installation_id, key)` | append a new `blob_id` row per write; `get()` reads `ORDER BY created_at DESC LIMIT 1` | **semantically** idempotent — extra rows per key, but the API always returns the latest (retention GCs the rest) | `test/integration/adapters/blobstore_postgres.integration.test.ts` |
| **Langfuse export** | `observability/langfuse_exporter.ts` | none (fire-and-forget) | best-effort POST, exception swallowed | **may post a duplicate trace** on redrive — accepted by design (advisory telemetry must never block or fail a review; Langfuse dedupes server-side). The only boundary that is NOT no-duplicate, and intentionally so. | `test/unit/observability/langfuse_exporter.test.ts` |

## Rules for adding a new external boundary

1. Pick an **idempotency key** that is stable across redrives — a deterministic id (`uuid5` of the
   content), a marker embedded in the artifact, or `SinkContext.outboxRowId`. Never a fresh `uuid4`/`now()`.
2. **Find-or-claim before create**: a paginated existence scan (like check-run / review-marker) or an
   `ON CONFLICT DO NOTHING` claim row. If you scan a GitHub list endpoint, you MUST paginate (Link
   rel=next, bounded) — the artifact can sit past page 1 (this was XM9).
3. A redrive must hit a **no-op or in-place update**, never a second create.
4. Add a test that runs the boundary **twice** and asserts exactly one artifact.
5. If the boundary is genuinely fire-and-forget (telemetry), document it as such here — it's the only
   acceptable non-no-duplicate posture.
