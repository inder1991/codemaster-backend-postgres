# Remediation plan — 2026-06-14 deep-dive (P0 + P1 + P2)

Closes the P0/P1/P2 findings in [`2026-06-14-MASTER-codebase-deep-dive.md`](./2026-06-14-MASTER-codebase-deep-dive.md).
P3 + the security/threat-model items are **out of scope** of this plan (tracked in the audit doc; deferred per
the "functionality + deployment" steer).

**Method per wave (non-negotiable, same as W3.x):** RED test first → watch it fail for the right reason →
minimal GREEN → **full battery** (`typecheck` + `lint` + `gates` + unit/gates/smoke + integration on `:5446` +
deploy-artifact drift gate + helm lint) → one commit. Waves are grouped so each is a coherent commit touching a
bounded file set; intra-phase waves are mostly independent and can parallelize across sessions.

**Branch:** continue on `feat/deploy-contract-preflight`; push to `postgres-repo/main` per phase (your call each time).

Legend: **F<n>** = fix wave · *Closes* = audit IDs · each lists the fix, the RED test, and the files.

---

## Phase 1 — Deploy blockers (the 5 P0s + their coupled P2s). Ship before go-live.

### F1 — Partition lifecycle: register every partman parent + a runway preflight  ·  *Closes P0-1*
- **Fix:** a migration that calls `partman.create_parent(...)` for every partitioned parent (`audit.webhook_events`,
  `telemetry.llm_calls`, `telemetry.llm_payloads`, `core.diff_snapshots`, `audit.workflow_events`,
  `core.feedback_events`, `audit.audit_events`) with premake + retention configured; OR replace the no-op
  `run_maintenance()` delegation in `partition_maintenance.activity.ts` with explicit premake/drop DDL. Add a
  preflight in `deploy_preflight.ts` that **fails** when any partitioned parent's furthest future partition is
  within N days (e.g. 14).
- **RED:** integration test — run maintenance on a fresh DB, assert future partitions are premade for each parent
  (`tables_processed > 0`); preflight test — a parent whose runway ends in <N days → preflight throws.
- **Files:** `migrations/000X_partman_register.sql` (new), `activities/partition_maintenance.activity.ts`,
  `config/deploy_preflight.ts`, the partition-maintenance integration test.
- **Watch-out:** if any `*_default` partition already holds rows, `create_parent`/attach for an overlapping range
  fails — the migration must handle the already-defaulted case (detach/repartition or document a manual step).

### F2 — Graceful shutdown + pool sizing + timer hygiene (one coupled fix)  ·  *Closes P0-3, P2-1, P2-2*
- **PREREQUISITE (review feedback #2):** `runServer` currently builds the Fastify instance **internally**
  (`server.ts:41`), `await app.listen(...)` (`:183`), and returns `Promise<void>` — so `main.ts` has **no handle
  to close**. The wave must FIRST give `main.ts` a shutdown lever: either (a) `runServer` returns a handle
  (`{ close: () => app.close() }` or the `app`), or (b) `runServer` accepts an injected `AbortSignal`/shutdown
  callback and registers its own `app.close()` on it. Without this, the wave as originally scoped cannot stop
  accepting HTTP. `api/server.ts` (and `api/app.ts` if the factory signature changes) are now **in scope**.
- **Fix:** make `main.ts` the single shutdown owner — one SIGTERM/SIGINT handler that (1) closes the HTTP server
  via the new handle (stop accepting HTTP + finish in-flight), (2) runner `stopAll` (drain loops), (3) dispose the
  shared pool **last** (only the final owner ends it; remove the runner's mid-life `disposePool`). Add
  `CODEMASTER_PG_POOL_MAX` env override at the single `getPool` site and size it for the combined pod (API + 4
  loops + `CHUNK_CONCURRENCY` + mutex/claimCheck ≥ ~2/poller). Make `WallClock.sleep` accept a signal / `.unref()`
  + `clearTimeout`, and have `cancellableSleep` cancel the underlying timer on abort.
- **RED:** (a) `runServer` returns/accepts a working close handle (calling it stops the listener); (b) shutdown
  test — SIGTERM → server stops listening AND the pool is not disposed while a request is in flight, process
  exits; (c) pool-max test — `CODEMASTER_PG_POOL_MAX=N` is honored; (d) timer test — an aborted `cancellableSleep`
  leaves no pending timer (no open handle).
- **Files:** `api/server.ts`, `api/app.ts`, `main.ts`, `runner/background_runner_main.ts`,
  `libs/platform/src/db/database.ts`, `libs/platform/src/clock.ts`, `runner/outbox_dispatcher_loop.ts`.

### F3 — Keyset pagination correctness (3 reads)  ·  *Closes P0-4, P2-6, P2-7*
- **Fix:** make the predicate direction-consistent with the ORDER BY in `listFindings` and `listPullRequests`
  (`(created_at < c OR (created_at = c AND id > f))`); fix the audit-events cursor to carry full µs precision
  (`created_at::text` in the cursor, bind back via `CAST(... AS timestamptz)`) like the sibling reads.
- **RED:** seed >limit findings sharing one `created_at` (the bulk-insert shape), page through, assert **every**
  finding is returned exactly once (no drops, no dupes). Same for PRs; an audit-events page-seam test across a
  sub-ms boundary.
- **Files:** `api/admin/admin_read_repo.ts`, `api/admin/audit_events_read.ts`, their integration tests.

### F4 — LLM rate-limit class preservation  ·  *Closes P0-5*
- **Fix (review feedback #1 — preserve the failure cleanup):** the `invokeModel` catch (`client.ts:682-722`)
  does real always-on cleanup BEFORE it throws — `recordFailure`, `releaseCostCapReservation`,
  `shadowJournalAppend("settle")`, `maybeExportLangfuseTrace`. The fix must **keep all of that cleanup** and only
  change the FINAL thrown value: `throw e instanceof LlmInvocationError ? e : new LlmInvocationError(...)`. Do NOT
  early-return/re-throw at the top of the catch (that would skip the failure-row write + the reservation release →
  a leaked cost-cap reservation, the exact P2-11 drift). The typed subclass (`LlmRateLimitError` +
  `retryAfterSeconds`) is what then survives to the throttle-defer layers.
- **Telemetry (open Q resolved — recommend yes):** also give `recordFailure` a distinct status/label for
  rate-limits (e.g. `status: 'rate_limited'` alongside `failed`/`timeout`) so 429s are visible in telemetry
  rather than buried in `failed`. Low-cost, high-signal; fold into this wave.
- **RED:** (a) a stubbed SDK 429 → `invokeModel` throws `LlmRateLimitError` (not `LlmInvocationError`) **AND** the
  cost-cap reservation was released + the journal `settle(−estimated)` appended + a failure row written (the
  cleanup is NOT skipped); (b) `recordFailure` is called with the `rate_limited` status on a 429; (c) end-to-end:
  a 429 routes to `deferRetry` (throttle park), not the generic backoff.
- **Files:** `integrations/llm/client.ts`, `integrations/llm/client.test.ts` + a runner retry-hint test.

### F5 — Two-person approval: approver identity + tenant scope (one fix, two findings)  ·  *Closes P0-2, P2-14*
- **Fix:** in the members + cost-cap approve/reject routes use `principal.userId` as the approver (drop the body
  field, or assert it equals `principal.userId` → 403). In `approveRoleChange`/`rejectRoleChange` (and cost-cap
  twins) load the pending row and reject when `row.installation_id !== principal.installationId` and the caller
  isn't `super_admin` (mirror the members READ route's tenancy gate).
- **RED:** (a) **approve** with a body `approver_user_id ≠ session user` → 403 (no grant applied); (b)
  **reject** with a body `approver_user_id ≠ session user` → 403 (review feedback #4 — the reject route
  `admin_routes.ts:875` also trusts the body; even as a self-cancel the audit *actor* must not be forgeable, so
  the rejected-row's `approved_by_user_id`/audit actor must be `principal.userId`); (c) a `platform_owner` of
  installation A approving **or rejecting** a pending row of installation B → 403.
- **Files:** `api/admin/admin_routes.ts`, `api/admin/members_write.ts`, `api/admin/cost_caps_write.ts`,
  the admin members/cost-cap integration tests.

---

## Phase 2 — Resilience (P1 + coupled P2/P3).

### F6 — GitHub client resilience  ·  *Closes P1-A, P1-B, P2-21, P2-22, + P3 (webhook-500, Retry-After date, UA)*
- **Fix (host-agnostic — always do A/B/C/E):** (A) add a `forceRefresh` seam to the token provider that evicts
  the cached entry before re-mint, and call it on the 401-refresh; (B) add a 429 branch →
  `GitHubRateLimitExceeded(retry-after)` and, before the generic 403 mapping, treat `x-ratelimit-remaining:0` as
  retryable with the reset hint; (C) emit structured warn logs on each retry / 401-refresh / rate-limit raise
  (never the token); (E) P3 nits: 401-on-invalid-signature webhook persist failure → log + 401 (not 500);
  `Retry-After` HTTP-date parse; `User-Agent: codemaster-app/<ver>`.
- **Fix (D) — GitHub host config. DECISION LOCKED: support BOTH (GHE now, github.com next year).** One mechanism
  covers both — a configurable host that **defaults to github.com** (zero config) and is set for GHE. The
  `baseUrl` is needed at **~15 construction sites**, NOT just `buildGithubApiClient`. Every site funnels through
  `GitHubAppTokenProvider.fromEnv` + `new GitHubApiClient`/`new GitHubIssueClient`:
  `runner/in_process_ports.ts` (×3), `runner/handlers/event_handlers.ts` (×3), `runner/handlers/cron_handlers.ts`,
  `worker/build_activities.ts` (×4, incl. `GitHubIssueClient`), and the posting/enrich/hydrate activities —
  `post_review_results.activity.ts:1542`, `post_check_run.activity.ts:144`, `update_pr_description_summary`,
  `post_review_placeholder`, `delete_review_placeholder`, `enrich_pr_files`, `hydrate_installation_repositories`,
  plus the clone path.
  - Add a **single GitHub host-config helper** (one resolver, read once) supplying the base to `fromEnv` (token
    exchange) and to every `GitHubApiClient`/`GitHubIssueClient` constructor + the clone-URL builder. Route ALL
    ~15 sites through it.
  - **URL-SHAPE difference (must handle — not a hostname swap):** github.com REST = `https://api.github.com`
    (api subdomain, no path); GHE REST = `https://HOST/api/v3`. GraphQL: `.../graphql` (github.com) vs
    `https://HOST/api/graphql` (GHE). The **git clone URL uses the WEB host**, separate from the API host:
    `https://github.com/owner/repo.git` vs `https://HOST/owner/repo.git`. So **two settings**: an **API base**
    (`GITHUB_API_BASE`, default `https://api.github.com` — operator supplies the FULL base incl. `/api/v3` for
    GHE) and a **git/web host** (`GITHUB_WEB_HOST`, default `github.com`) for the clone path. Resolve via the
    layered config tier (DB > env > default), same pattern as the other settings.
  - **RED must prove post-review AND post-check-run use the configured API base** (a stub host is hit by the
    posting activities, not only the review client), AND the clone path uses the configured web host. A
    no-config run still resolves to github.com (the next-year default works untouched).
- **RED:** real-provider 401-then-200 (forceRefresh re-mints); 429 + primary-limit-403 → retryable typed error
  carrying reset; a retry emits a log; configured GHE base reaches the posting activities + token exchange + the
  clone web-host; no-config defaults to github.com.
- **Files:** `integrations/github/api_client.ts`, `token_provider.ts`, `issue_client.ts`, `installation_token.ts`,
  a new `config/github_host.ts` helper, `runner/in_process_ports.ts`, `runner/handlers/{event,cron}_handlers.ts`,
  `worker/build_activities.ts`, the 7 posting/enrich/hydrate activities above, the clone path,
  `api/github_webhook_routes.ts`, + tests. (Larger wave — consider splitting into F6a *resilience A/B/C/E* and
  F6b *host config D* so each stays one coherent commit.)

### F7 — Mutex renew fail-open → bounded transient tolerance  ·  *Closes P1-C*
- **Fix:** distinguish definitive lease loss (`false`) from a transient renew error; allow N consecutive transient
  failures then abort the review **fail-closed**; count/log the transient renews.
- **RED:** N consecutive renew throws → the review aborts (no further paid calls / no post); a single transient
  followed by success continues.
- **Files:** `runner/review_job_shell.ts`, its integration test.

### F8 — Rerank timeout actually aborts the in-flight call  ·  *Closes P1-D*
- **Fix:** thread an `AbortSignal` (from the same transport budget) into `invokeModel({signal})` so the soft
  timeout cancels the Bedrock call; delete the stale "no AbortSignal seam" comment.
- **RED:** a rerank that exceeds the soft timeout aborts the LLM call (the stub observes an aborted signal) rather
  than letting it run to completion.
- **Files:** `retrieval/llm_backed_rerank.ts`, test.

### F9 — Review pipeline: event-loop + fail-soft edges  ·  *Closes P1-E, P1-F, P2-3, P2-4, P2-5*
- **Fix:** (E) per-file byte cap + `fs.promises.readFile` before chunk/parse, skip oversize with a degradation
  note; (F) cheap NUL/binary sniff → skip non-text files; (P2-3) batch the dedup embed in ≤128-text chunks; (P2-4)
  add a degradation note when a chunk's structured output hits `stop_reason==="max_tokens"`; (P2-5) when
  `selection.carried.length>0`, degrade (post carried + note) instead of aborting at ratio 1.0.
- **RED:** a >cap minified file is skipped (event loop not blocked, note emitted); a binary file is skipped before
  the LLM; a 200-finding review still runs semantic dedup (batched); a truncated chunk emits a note; an
  all-new-chunks-fail review with carried findings posts the carried set.
- **Files:** `activities/chunk_and_redact.activity.ts`, the chunkers, `review/aggregation_semantic.ts`,
  `review/review_activity.ts`, `review/orchestrator.ts`, tests.

### F10 — Embedding dimension: source from the active generation  ·  *Closes P1-J*
- **Fix:** replace the hardcoded `EMBEDDING_DIM (1024)` assert in the doc-chunk + query embed paths with the
  expected dim sourced from the active generation / configured provider (the embedder cache already tracks it);
  fail loud + once on a true mismatch instead of silently skipping/throwing per call.
- **RED:** an `openai_compat`/Ollama provider with dim≠1024 → chunks embed + persist (index non-empty) and queries
  succeed; a genuine dim drift → one clear typed error.
- **Files:** `activities/embed_doc_chunks.ts`, `activities/embed_query.activity.ts`, tests.
- **Note:** coupled with F13's pre-insert dim validation — can merge if convenient.

---

## Phase 3 — Confluence data-lifecycle (P1 + coupled P2). **Gated on a Python-parity check.**

### F11 — Parity pre-step (research, no code)
Confirm against the frozen Python whether a `superseded_at` step + per-chunk `chunk_embeddings` GC existed
(regression) or were never implemented (new work). Decide whether to fix at write-time (supersede on upsert) or
read-time (max-version filter). This gates the design of F12–F14.

### F12 — Version supersede + embedding GC  ·  *Closes P1-G, P1-H*
- **Fix:** on upsert of version N of a page, mark prior-version rows `superseded_at = now()` (and/or restrict
  retrieval to the current version per `page_id`); on reconcile/soft-delete/supersede also DELETE the matching
  `core.chunk_embeddings (chunk_table='confluence_chunks', chunk_id=…)` rows.
- **RED:** edit a page (v→v+1) → old-version chunks superseded AND their `chunk_embeddings` deleted; retrieval
  returns only current-version chunks; the per-space count excludes dead versions.
- **Files:** `domain/repos/confluence_chunks_repo.ts`, retrieval SQL, tests.

### F13 — Empty-set guard + poison ceiling + dim validation + indexes  ·  *Closes P1-I, P1-K, P2-9, P2-15, P2-16*
- **Fix:** skip `reconcileDeletions` when `livePageIds` is empty (P1-I); persist a per-page consecutive-failure
  count → quarantine/alert after N cycles (P2-15); validate the embedder vector **width** pre-insert with a typed
  error (P2-16); migration adding an HNSW index on `confluence_chunks.embedding` + a `(space_key) WHERE
  deleted_at IS NULL` btree (P1-K, P2-9) — or gate `generation_only` as the production retrieval mode.
- **RED:** empty fetch → reconcile skipped (corpus intact); N-consecutive page failures → quarantined + alert;
  a wrong-width vector → one typed error (not a per-page DB cast failure); `EXPLAIN` uses the new index.
- **Files:** `runner/handlers/cron_handlers.ts`, `confluence_chunks_repo.ts`, `confluence_sync.activity.ts`,
  `migrations/000X_confluence_indexes.sql`, tests.

### F14 — Fetch checkpoint/resume + shared client  ·  *Closes P2-17, P2-18*
- **Fix:** stream/cap `fetchSpacePages` under the runtime ceiling with a persisted cursor checkpoint (resume
  instead of restart-from-scratch); build one shared disposable `ConfluenceClient`/embedder in
  `buildBackgroundRunner` and inject it into both `registerCronHandlers` + `registerEventHandlers`.
- **RED:** an aborted fetch resumes from the checkpoint (doesn't re-fetch page 1); only one token-refresh loop /
  Vault reader is constructed.
- **Files:** `confluence_sync.activity.ts`, `runner/background_runner_main.ts`, `cron_handlers.ts`,
  `event_handlers.ts`, tests.

---

## Phase 4 — Remaining P2 hygiene (independent, batchable).

### F15 — DB + cost + observability hygiene  ·  *Closes P2-8, P2-10, P2-11*
- Migration: `(created_at) WHERE state='pending'` index on `core.outbox` (P2-8). Assert `numAffectedRows===1` in
  the `embedder_runtime_state` writers, fail-closed (P2-10). Emit a bounded counter on cost-cap release failure
  (P2-11). RED per: `EXPLAIN` uses the outbox index; a missing-singleton write throws; a release failure increments
  the counter.

### F16 — Edge hardening  ·  *Closes P2-12, P2-13, P2-19, P2-20*
- Set Fastify `requestTimeout`/`connectionTimeout`/`keepAliveTimeout` (P2-12). Add a per-session/IP limiter on the
  admin scope, esp. the outbound `/test`+`/preflight` routes (P2-13). Wire the field-key refresh loop at the
  `main.ts` composition root (P2-19). Add an overall boot deadline around `installFieldKeyRegistryAtBoot` /
  DSN resolve (P2-20). RED per behavior.

---

## Sequencing & effort

| Phase | Waves | Gates go-live? | Notes |
|-------|-------|----------------|-------|
| 1 | F1–F5 | **Yes** | Small, mechanical, high-impact. Do first. F1 has a data-migration watch-out. |
| 2 | F6–F10 | No (resilience) | F6 needs the **GHE-in-scope?** decision. F10 couples to F13. |
| 3 | F11–F14 | No (data quality) | **Gated on F11 Python-parity check.** Biggest/riskiest phase; F12–F14 are coupled. |
| 4 | F15–F16 | No (hygiene) | Independent; batch freely. |

**Open decisions before Phase 2/3:** (1) ~~GitHub Enterprise in scope?~~ **RESOLVED 2026-06-14 — support BOTH:
GHE now, github.com next year (one configurable host, defaults to github.com). F6-D locked.** (2) Confluence
write-time supersede vs read-time max-version filter (F11 output). (3) Confluence production retrieval mode —
fix `fallback` with a `confluence_chunks` index, or gate the cutover to `generation_only`? (F13).
