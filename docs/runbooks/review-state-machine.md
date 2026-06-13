# Review state machine — single source of truth (W3.3)

The PR-review lifecycle spans four tables. This doc is the **single source of truth** for their states,
legal transitions, and the cross-table invariants. Each invariant names the code that enforces it and the
test that pins it. (Post-Temporal: the Postgres runner *is* the driver — the `review_jobs` claim/lease
replaces the Temporal workflow; the `review_runs` row is the durable review record.)

## The four entities

### `core.review_jobs` — the runner's claimable unit of work
States (CHECK `review_jobs_state_check`): `ready` → `leased` → terminal `{done, dead, cancelled}`.
- **ready** — enqueued, awaiting claim. (`enqueue`, default state.)
- **leased** — claimed by a pool member; carries `lease_owner` + `attempt_token` (fence) + `leased_until` + `timeout_at`. (`claim`.)
- **leased → ready** — retry: `deferRetry` (throttle, attempts−1, future `run_after`) or `markFailed` below the attempt cap (exponential backoff).
- **done** (terminal) — `markDone`: success; `finished_at` set, lease cleared.
- **dead** (terminal) — `markFailed` at the attempt cap, `terminalSettle('dead')`, or the job-reaper `reapStuckRuns` (lease expired + attempts exhausted); `dead_reason` + `finished_at` set.
- **cancelled** (terminal) — `markCancelled` / `terminalSettle('cancelled')` (supersede, operator, suspend/disable); `cancel_reason` + `finished_at` set.
Uniqueness: `uq_review_jobs_active_run` — a partial unique index on `run_id` WHERE `state IN ('ready','leased')` → **at most one active job per run**.

### `core.review_runs` — the durable review record
States (CHECK `ck_review_runs_lifecycle_state`): `PENDING` → `RUNNING` → terminal `{COMPLETED, FAILED, CANCELLED, PARTIAL}` (+ `WAITING_RETRY`).
- Terminal states carry a biconditional timestamp, DB-enforced: `COMPLETED ⇔ completed_at`, `FAILED ⇔ failed_at`, `CANCELLED ⇔ cancelled_at` (CHECKs `ck_review_runs_*_at_present` / `_state`). You cannot mark a run terminal without its timestamp, nor stamp the timestamp without the matching state.
- **Supersede**: `cancel_reason='superseded' ⇒ superseded_by_run_id IS NOT NULL` and `superseded_by_run_id ⇒ lifecycle_state='CANCELLED'` (CHECKs `ck_review_runs_supersede_*`). `cancel_reason` is an enum (`superseded|operator_cancelled|timeout|repository_disabled|installation_suspended|shutdown`).
- The "live" run for a PR is `pull_request_reviews.current_run_id`.

### `core.pr_review_mutex` — the per-PR review mutex
No state column; liveness is implicit:
- **live (held)** — `released_at IS NULL` AND `lease_expires_at > now()`.
- **released** — `released_at IS NOT NULL` (explicit release), OR reclaimable once `lease_expires_at < now()`.
Uniqueness: `uq_pr_review_mutex_live_pr` — partial unique on `(installation_id, repository_id, pr_number)` WHERE `released_at IS NULL` → **at most one live mutex per PR**. Acquire reclaims an expired row then inserts fresh (`acquirePrReviewMutex`); release sets `released_at` (`releasePrReviewMutex`).

### `core.posted_reviews` — the posted-review marker / idempotency row
Key `(pr_id, marker)`. `publication_outcome ∈ {inline_posted, body_only_posted, degraded_unposted}` with a biconditional CHECK: `degraded_unposted ⇔ github_review_id IS NULL` (a posted outcome MUST carry the GitHub review id; a degraded one MUST NOT). The `marker` (`<!-- codemaster:review-marker:<pr_id> -->`) is the GitHub-side recovery oracle. See [external-boundary-idempotency](./external-boundary-idempotency.md).

## The invariants

| # | Invariant | Enforced by | Test |
|---|---|---|---|
| 1 | **done ⇒ terminal run** — a `done` job's run is in a terminal state | `markDone` is only called after the workflow completed → `finalize_review_run` flips the run to `COMPLETED`; no path sets a job `done` over a live run. The run's terminal-timestamp biconditional CHECKs prevent a half-terminal run. | the biconditional-CHECK rejection test in `review_state_invariants.integration.test.ts` |
| 2 | **dead/cancelled ⇒ no live mutex** — a reaped/terminal run holds no live mutex | the job-reaper releases the mutex in its txn; the run-reaper now releases it **in lockstep** (W3.3/OH9, `review_run_reaper.activity.ts`) | `review_run_reaper.activity.integration.test.ts` ("releases the PR mutex … in lockstep") |
| 3 | **live job ⇒ current_run_id match** — a live job's `run_id` matches the PR's live run | ingest sets `pull_request_reviews.current_run_id` to the new run before enqueueing the job with that `run_id`; supersede cancels the old job+run together | covered by the runner end-to-end integration tests (a completed run leaves `current_run_id` at that run) |
| 4 | **posted review ⇒ recoverable** — a posted review is recoverable by the DB row or the GitHub marker | `posted_reviews` row (durable, `ON CONFLICT (pr_id) DO NOTHING` claim) + the head-agnostic marker scan (`findExistingReviewByMarker`, paginated) | `post_review_results*.integration.test.ts` |
| 5 | **no two live jobs per run** — at most one active job per `run_id` | `uq_review_jobs_active_run` partial unique index; `enqueue` coalesces a `23505` to the existing active job (idempotent redelivery) | `review_jobs_repo.integration.test.ts` (redelivery idempotency) + `review_state_invariants.integration.test.ts` |

## The reapers (self-healing)

- **Job reaper** (`ReviewJobsRepo.reapStuckRuns`) — a `leased` job whose `leased_until < now()` AND `attempts >= max_attempts` → `dead`, **and releases its held mutex in the same txn**.
- **Run reaper** (`reviewRunReaperActivity`) — a `RUNNING` run older than `staleAfterSeconds` **with no live job** (`NOT EXISTS … state IN ('ready','leased')` — the *gate-④ live-job shield*) → `CANCELLED/timeout`, **and releases the held mutex in lockstep** (W3.3/OH9). The live-job shield is the post-Temporal staleness signal (OH8): a run still driven by a `ready`/`leased` job — including one in a long retry backoff (M11) — is never reaped on age. Audit `installation_id` is resolved via `review_id → pull_request_reviews.repo_id → repositories` (a LEFT JOIN; `review_runs` carries no `installation_id`); an orphan (NULL) is reaped but skips its audit row rather than rolling back the whole sweep (RM8/OM8).
