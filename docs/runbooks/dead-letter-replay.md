# Dead-letter replay (W3.1)

When a side effect permanently fails, its row dead-letters instead of retrying forever. After the cause is
fixed (or a transient outage clears), an operator can **replay** it — reset it so the runner re-attempts it.

## Outbox (implemented)

The outbox is the meta-boundary: it drives review enqueue + every GitHub post. A row reaches `state='dead'`
when `markAttemptFailed` hits `maxAttempts` (or a permanent sink error), or via operator `markDead`.

- **List** — `GET /api/admin/dead-letter/outbox?limit=N` (`platform_operator`+). Returns the dead rows'
  routing + failure metadata (`id`, `sink`, `attempts`, `last_error`, `last_attempted_at`, `installation_id`,
  `run_id`), newest-failure first. **Never** returns the payload (it can be large / secret-bearing).
- **Replay** — `POST /api/admin/dead-letter/outbox/:id/replay` (`super_admin`). Resets the row → `pending`
  with its fence columns cleared (`attempts→0`, `leased_until→NULL`, `last_error→NULL`) so the dispatcher
  re-claims and re-attempts it. Fenced to `state='dead'` (a non-dead id → `404`). Emits an `outbox.replayed`
  audit event that **archives the prior dead state** (`before: {state:'dead', attempts, last_error}` →
  `after: {state:'pending'}`) before it's cleared.

Replay is safe because every destination is idempotent on redrive — see
[external-boundary-idempotency](./external-boundary-idempotency.md). Replaying a row that already had its
side effect partially applied will no-op at the destination (markers / claims / content-addressed keys).

## Other dead-letter classes (same shape, not yet wired)

W3.1 also calls for replay/clear of these classes; they follow the identical list + replay + audit +
archive-before-mutate + RBAC shape and are the remaining W3.1 work:

- **dead `review_jobs`** — reset a `dead` job → `ready` (clear `lease_owner`/`attempt_token`/`leased_until`,
  reset `attempts`). Re-runs a permanently-failed review.
- **dead `background_jobs`** — same, for the background-job runner.
- **stranded `pr_review_mutex`** — force-release a live mutex with no owning live job (belt-and-braces; the
  reapers now release in lockstep — see [review-state-machine](./review-state-machine.md) OH9).
- **blocked installations (`repository_repair_state`)** — clear a `blocked` repair state → `ready` so
  reconcile/ingest resumes (the RH14 `repository.repair_blocked` audit + alert lands here).
