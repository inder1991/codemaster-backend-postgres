# Codemaster-backend — whole-codebase deep-dive review (2026-06-14)

**Method.** 8 parallel read-only review agents, one per subsystem, each applying the full rubric (bugs ·
blockers · error-handling · integration · logging · edge-cases · performance · resilience). The 6
highest-impact findings were then **re-verified by hand** against the source (marked ✅ VERIFIED). Findings
the agents self-corrected mid-review are already dropped. Severity: **P0** = gate go-live / data-loss /
broken control; **P1** = high; **P2** = medium; **P3** = low/informational.

This is a **findings report — nothing was changed.** Fix sequencing is at the end; pick what to action.

---

## P0 — gate go-live

### P0-1 ✅ pg_partman has zero registered parents → partition runways exhaust in ~10 days, retention never runs
`migrations/0001_baseline.sql` (empty `partman.part_config`), `apps/backend/src/activities/partition_maintenance.activity.ts`
The daily maintenance activity delegates 100% to `partman.run_maintenance()`, which only premakes/drops
partitions for parents registered via `create_parent(...)`. **There are zero `create_parent` calls anywhere**
(verified: migrations, deploy_preflight, schema_preflight, bootstrap). Statically pre-created runways end soon
— `audit.webhook_events` **ends 2026-06-24 (~10 days out)**, `telemetry.llm_calls` 2026-07-08, most others
2026-09-01. After a table's runway ends, rows fall into its `*_default` partition (so INSERTs don't fail —
masking it), but: retention/drop is silently defeated (unbounded growth), per-partition indexes degrade to
default-partition scans, and a populated default partition **blocks future `create_parent`/`ATTACH`** for
overlapping ranges (the fix gets harder the longer it's left). The cron runs green reporting `tables_processed=0`.
**Fix:** register every partitioned parent with `create_parent` (premake + retention) in a migration/idempotent
bootstrap, OR replace the no-op delegation with explicit premake/drop DDL; add a preflight that fails when a
parent's furthest future partition is within N days.

### P0-2 ✅ Member role-change approve/reject takes the approver identity from the request BODY → two-person approval bypass
`apps/backend/src/api/admin/admin_routes.ts:845-857,875-887` + `members_write.ts:389`
The approve/reject routes pass `approverUserId: parsed.data.approver_user_id` (**from the request body**) into
`approveRoleChange`, and `checkSelfApproval` compares the requester against *that body value* — never against
`principal.userId`. So an authenticated member-mutation-role caller approves their own pending role grant by
putting any other UUID in the body; the self-approval guard only trips when the body UUID equals the
requester's. The cost-caps equivalent does it correctly (`approverUserId: principal.userId`, lines 1487/1513) —
members is the outlier. This nullifies the two-person control on privileged role grants.
**Fix:** drop `approver_user_id` from the body and use `principal.userId` (mirror cost-caps); or assert
`body.approver_user_id === principal.userId` and 403 otherwise.

### P0-3 ✅ SIGTERM never exits the combined pod; the shared pool is disposed while the API still serves
`apps/backend/src/main.ts:116-128`, `api/server.ts` (no `app.close`/SIGTERM hook), `runner/background_runner_main.ts` (`stopAll` + `disposePool`)
The only signal handlers live in the runner and just `loop.stop()` the four loops. `main.ts` awaits
`runServer` then `Promise.all(tasks)` with **no SIGTERM handler and no `app.close()`**. On SIGTERM: loops drain
→ `Promise.all` resolves → `main()` returns — but Fastify is still listening, **keeping the event loop alive**,
so the process never exits until k8s SIGKILL. Worse, the runner's shutdown disposes the *shared* pool, so for
the whole grace window the still-serving API runs against an ended pool → every DB-backed request throws. Every
rolling deploy hits this.
**Fix:** one shutdown owner in `main.ts`: SIGTERM → stop accepting HTTP (`app.close()`) → stop the loops →
dispose the pool last (only the final owner ends the shared pool). Or wire `closeWithGrace`.

### P0-4 ✅ `listFindings` keyset pagination pages the wrong side of a tie → silently drops findings
`apps/backend/src/api/admin/admin_read_repo.ts:757` vs `:774`
Predicate `(rf.created_at, rf.review_finding_id) < (cursor_created_at, cursor_finding_id)` against
`ORDER BY rf.created_at DESC, rf.review_finding_id ASC`. The secondary key is **ASC** but the predicate's tie
branch selects `finding_id < cursor` — the wrong direction — so on a `created_at` tie the remaining findings
(`finding_id > cursor`) are skipped entirely. Findings are bulk-inserted with a single `clock.now()` per
review, so **all findings of a review share an identical `created_at`** — ties are the common case. A page
boundary landing mid-review drops the rest of that review from the admin findings list.
**Fix:** `(rf.created_at < ${c} OR (rf.created_at = ${c} AND rf.review_finding_id > ${f}))`.

### P0-5 ✅ Bedrock/Anthropic 429 loses its rate-limit class in `invokeModel`'s catch → the entire throttle-defer machinery is dead on the LLM path
`apps/backend/src/integrations/llm/client.ts:722`
The SDK adapter correctly maps a 429 to `LlmRateLimitError` and parses `retry-after`, but the `invokeModel`
catch does an unconditional `throw new LlmInvocationError(...)`, discarding the subclass + the hint. Three
layers key on the error **name** `"LlmRateLimitError"` (`runner/retry_hints.ts`, `review/pipeline/parallelism.ts`,
`runner/retry_policies.ts`) — so a Bedrock throttle never triggers `deferRetry`; instead it runs the generic
exponential-backoff curve and **retries straight back into the open rate-limit window**, deepening the throttle.
The parsed `retry-after` is dead code on this path.
**Fix:** in the catch, `if (e instanceof LlmInvocationError) throw e;` (re-throw the typed subclass the adapters
already raise) and only wrap genuinely-unmapped values.

---

## P1 — high

**Resilience / correctness**
- **P1-A — GitHub 401-refresh is a no-op against the production token provider.** `integrations/github/api_client.ts:434-443` + `token_provider.ts:311-344`. On 401 it re-calls the provider, which returns the *same cached token* (no invalidation seam on the prod LRU cache; the only `invalidate()` is on a dead unused cache module). A mid-life token revocation (app secret rotated, re-permissioned, GitHub-side revoke) → terminal `GitHubAppUnauthorized` instead of a fresh mint. Masked in tests by a fake provider that yields a distinct second token. **Fix:** add a `forceRefresh` path that evicts the cache entry before re-mint; test against the real provider.
- **P1-B — No 429 handling; primary-rate-limit 403 → non-retryable.** `api_client.ts:446-490`. No 429 branch; a primary-limit 403 (`x-ratelimit-remaining:0`) maps to `GitHubForbiddenError` (terminal), discarding the reset hint. Transient rate-limits become hard review failures. **Fix:** 429 → `GitHubRateLimitExceeded(retry-after)`; on 403 check remaining==0 first.
- **P1-C — Mutex renew is fail-open on ALL errors.** `runner/review_job_shell.ts:260-264,290-296`. `.catch(() => true)` maps any renew error (incl. DB outage) to "still holds the lease," disabling the lease-loss safety net during DB degradation — a stolen/superseded review can keep paying Bedrock + post. **Fix:** tolerate N consecutive transient renew failures then abort fail-closed; count/log them.
- **P1-D — Rerank soft-timeout abandons but never aborts the in-flight LLM call.** `retrieval/llm_backed_rerank.ts`. The "no AbortSignal seam" comment is stale — `invokeModel` now accepts `signal`, but the reranker passes none, so every rerank timeout leaves a Bedrock call billing with nothing consuming it. **Fix:** thread the abort signal into `invokeModel({signal})`.

**Performance / event-loop**
- **P1-E — Synchronous unbounded file read + tree-sitter parse blocks the runner event loop.** `activities/chunk_and_redact.activity.ts:172`. `readFileSync` + sync `parser.parse` with **no per-file byte cap** (only a 50k-line cap, which a minified/generated file passes). One large file stalls heartbeats + the mutex-renew loop + every concurrent job in-process. **Fix:** per-file byte cap + `fs.promises.readFile`; skip oversize files with a degradation note.
- **P1-F — Binary files in the changed set are decoded to U+FFFD and sent to the paid LLM.** all chunkers `TextDecoder("utf-8").decode` with no NUL/binary sniff. Wasted spend + noise findings. **Fix:** cheap binary heuristic; skip like deleted files.

**Data lifecycle (Confluence) — confirm against frozen Python before treating as regressions**
- **P1-G — Stale OLD-version Confluence chunks are never superseded/deleted on a page version bump.** `domain/repos/confluence_chunks_repo.ts`. `chunk_id` is version-seeded, so v6 inserts new rows and v5 rows persist (reconcile only deletes pages *absent* from the live set; an edited page is still live). Nothing ever writes `superseded_at` for confluence. Result: every edit leaves stale **retrievable** chunks (old text competes in ANN), unbounded growth, and the per-space cap counts dead versions. The `confluence_chunks_natural_key` + the `WHERE superseded_at IS NULL` partial index imply a supersede step was designed but not wired. **Fix:** on upsert of version N, mark prior-version rows superseded/deleted, and/or restrict retrieval to the max version per page.
- **P1-H — Dual-write `chunk_embeddings` rows are orphaned on every delete path; no per-chunk GC.** `chunk_embeddings` has no FK/cascade to `confluence_chunks`; reconcile/soft-delete/stale/version-bump touch only `confluence_chunks`. In Phase-C (the indexed path) dead vectors accumulate in the HNSW index until the whole generation is retired. Compounds P1-G. **Fix:** delete matching `chunk_embeddings` rows on reconcile/supersede.
- **P1-I — `reconcileDeletions` has no empty-live-set guard → a transiently-empty space wipes the corpus.** `runner/handlers/cron_handlers.ts:280-287`. If `fetchSpacePages` returns zero pages (genuinely empty, or a v2 list endpoint returning empty `results` during reindex/permission-propagation rather than erroring), `NOT (page_id = ANY('{}'))` is TRUE for every row → all chunks soft-deleted, then re-ingested next cycle (a retrieval-blackout + thundering re-embed). **Fix:** skip reconcile when `livePageIds` is empty.
- **P1-J — Embedding write path hard-rejects any non-1024-dim vector → silently empties the index for the supported `openai_compat`/Ollama provider.** `activities/embed_doc_chunks.ts:116-120`, `embed_query.activity.ts:66-72`. The embeddings port explicitly documents callers MUST NOT assert 1024, yet these do (doc-chunk silently skips, query throws). Under that supported config: empty knowledge index + hard-failing query path, no signal. **Fix:** source expected dim from the active generation, not the hardcoded constant.

**Confluence ANN performance**
- **P1-K — No vector index on `confluence_chunks.embedding`; the production `fallback` mode's `COALESCE(...)` ORDER BY can't use any index → full-scan ANN.** `migrations/0001_baseline.sql`, `postgres_confluence_retrieval.ts`. Confluence retrieval is an unindexed seq-scan+sort over the whole corpus until an operator flips to `generation_only`; degrades linearly with the (P1-G/H-inflated) corpus and competes with the review hot path. **Fix:** HNSW index on `confluence_chunks.embedding`, or make `generation_only` the gated production target; at minimum document that `fallback` isn't production-scale.

---

## P2 — medium (condensed)

| # | Area | Finding | Location |
|---|------|---------|----------|
| P2-1 | Runner | Shared `max:8` PG pool across API + 4 loops + review fan-out, **no env override**; scheduler needs ≥2 conns/poll → a txn-holding caller needing a 2nd conn from an exhausted pool self-deadlocks | `libs/platform/src/db/database.ts:43`; all `getPool(dsn)` bare |
| P2-2 | Runner | `cancellableSleep` never clears `WallClock.sleep`'s un-`unref`'d `setTimeout`; per-dispatch watchdog leaks a ≤1s timer per row (compounds P0-3's exit hang) | `outbox_dispatcher_loop.ts:300-316`, `clock.ts:41-45` |
| P2-3 | Review | Semantic dedup silently defeated for any review >128 findings (embed batch rejects >128 → fail-open to exact-only); surfaced as a degradation note | `review/aggregation_semantic.ts:151-166` |
| P2-4 | Review | LLM `max_tokens` truncation accepted silently — no degradation note when a chunk's structured output is cut off (admitted as deferred follow-up) | `review/review_activity.ts:199-204` |
| P2-5 | Review | All-chunks-fail abort (ratio 1.0) re-raises **before** grafting carried findings → throws away deliverable prior-review findings | `review/orchestrator.ts:735-756` |
| P2-6 | Data | `listPullRequests` has the identical wrong-side-of-tie keyset defect as P0-4 (lower trigger freq) | `admin_read_repo.ts:836` vs `:845` |
| P2-7 | Data | Audit-events cursor truncates µs→ms → page-seam skip (the EM7 class the sibling reads already fixed via `created_at::text`) | `audit_events_read.ts:213` |
| P2-8 | Data | Outbox drain hot query has no index supplying `created_at` order over the pending set → sorts the whole pending backlog each tick (bites under a wedged sink) | `outbox_repo.ts:219-228` |
| P2-9 | Data | `confluence_chunks.reconcileDeletions` is a full-table scan (no `space_key` index) | `confluence_chunks_repo.ts:279-285` |
| P2-10 | Data | `embedder_runtime_state` writers commit silently on 0 rows affected (missing-singleton → config bumps become silent no-ops) | `embedder_runtime_state_repo.ts` |
| P2-11 | LLM | Cost-cap reservation release on SDK failure is a bare `catch {}` → repeated failures leak `estimated` into `cost_daily`, shrinking the effective cap until midnight; reconciler doesn't heal the aggregate | `client.ts:954-969` |
| P2-12 | API | No `requestTimeout`/`connectionTimeout`/`keepAliveTimeout` on Fastify (slowloris/hung-handler) | `api/app.ts:78` |
| P2-13 | API | No rate limiting on admin routes — esp. the outbound-calling `/test`/`/preflight` endpoints (amplification) | `admin_routes.ts` (no limiter on the admin scope) |
| P2-14 | API/multi-tenancy | Member & cost-cap approve/reject do **no tenant check** on the pending row (PK-only lookup) → a foreign-tenant `platform_owner` can approve/reject another tenant's pending change; contradicts the READ route's tenancy gate | `members_write.ts:384,444`, `cost_caps_write.ts:324,392` |
| P2-15 | Confluence | No per-page poison ceiling / quarantine / dead-letter — a permanently-failing page warns every 6h forever (admitted follow-up) | `cron_handlers.ts:262-277` |
| P2-16 | Confluence | Embedder vector **dimension** never validated pre-insert → wrong-dim drift fails late per-page at the `vector(1024)` column with an opaque error, after paying for the embed | `confluence_sync.activity.ts:279-363` |
| P2-17 | Confluence | `fetchSpacePages` accumulates the whole space in memory, no cap, **no checkpoint/resume** — a space that can't finish in the runtime ceiling re-fetches from scratch every cycle and never converges | `confluence_sync.activity.ts:214-234` |
| P2-18 | Confluence | Two independent `ConfluenceTokenProvider` refresh loops + Vault readers per runner (ingest vs resync each build their own) — redundant Vault load + divergent caches | `cron_handlers.ts:598`, `event_handlers.ts:548` |
| P2-19 | Boot | Field-key refresh loop wired only inside the runner task, not at the `main.ts` composition root → if the runner is delayed/api-only, the API/auth registry never refreshes across a Vault key rotation | `main.ts:111-114` vs `background_runner_main.ts:700` |
| P2-20 | Boot | No overall boot deadline; per-leg Vault timeouts (login retry × KV retry × auth-invalidate) compose to a ~40-60s silent boot stall worst case before fail-loud | `vault_http.ts` + `vault_reader_factory.ts` |
| P2-21 | GitHub | The `_request` retry/refresh/rate-limit loop emits **zero logs** — no operability into degraded GitHub / rate-limit storms / 401-refreshes at fleet scale | `api_client.ts:397-508` |
| P2-22 | GitHub | GHE `baseUrl` is never threaded from config (github.com hard-wired; the `baseUrl` constructor params are dead) — non-functional on GHE, or the params lie | `api_client.ts:381` + `in_process_ports.ts:180` |

---

## P3 — low / informational (selected)

- **Runner:** dead-letter replay (the new W3.1 code) resets `attempts→0`, re-opening the full retry budget — fine for idempotent sinks, worth an explicit assertion; backoff-exponent convention divergence between the job repos (`attempts-1`) and the outbox repo (`attempts`); `deferRetry` non-busy-loop relies load-bearingly on the 60s retry-hint floor (pin it with a test); `computeNextRun` runs twice per due schedule per poll; cron lateness WARN false-positives on the first tick after seed/re-enable.
- **GitHub:** webhook persist-failure returns 500 even for invalid-signature deliveries → GitHub redelivers spoofed traffic under DB pressure; token-exchange 403 always classified Permanent + 60s-negative-cached (swallows primary-rate-limit 403s); `Retry-After` HTTP-date form → NaN → dropped; generic `User-Agent: node`.
- **Confluence:** negative integer `Retry-After` not floored at 0; `Retry-After: 0` storm burns the 6-attempt budget in ms; **`/api/v2` cursor pagination is Cloud/modern-DC-only — older self-hosted Data Center paginates with `start`/`limit` offsets, so `listSpaces`/`listPages` can 404** (auth is DC-aware, paging is not); no non-advancing-cursor guard (infinite-pagination risk); silent label-fetch swallow drops a page from the default corpus with no log.
- **LLM:** 1¢ floors on estimate/final inflate cost telemetry; `tool_use` `input` blocks not redacted in the response archive; rerank parse allows duplicate/omitted indices (minor reorder).
- **Data:** non-finite floats corrupt the pgvector literal (contract lacks `.finite()`); per-row INSERT loops inside upsert transactions; `deleteOrphanChunks` SELECT-then-DELETE not txn-wrapped; `code_owners` "latest" pick lacks a deterministic tiebreaker; three repos' comments overstate runtime tenancy enforcement.
- **API:** two routes return the raw ZodError as the 422 body (schema-shape disclosure); one confluence-approval DELETE skips UUID validation (parity only).

## Security / threat-model (per your "leave attacker issues / focus on functionality" steer — listed, de-prioritized)

- **SSRF (SEC-H1):** `validateExternalUrl` runs only at credential-write time and the validated IP is discarded; the actual outbound fetches (probe + Confluence ingest) re-resolve the hostname (DNS-rebind TOCTOU), and the **cron ingest path validates nothing** — the stored `base_url` is trusted every run. Partly functional (unvalidated ingest), partly threat-model. `platform_credentials_write.ts:108`, `confluence/client.ts`.
- **Crypto (low, need DB-write access):** legacy `kms:` (AAD-free) rows defeat the column-isolation property (holds only for `kms2:`); the `plain:v1:` cleartext audit format is forgeable (no GCM tag) and the read path sniffs the prefix globally.
- **Config (defense-in-depth):** `assembleDsn` interpolates unencoded/unvalidated `host`/`port` from env.

---

## Verified-clean / well-built (credit — these are genuinely strong)

Fenced `owner+attempt_token` lease discipline (every stale write is a rowcount-0 no-op); the F4 atomic
job+run terminal settle; the RC7 permanent/retryable sink taxonomy + R-6 fence; per-loop supervision;
**SQL injection: none found** anywhere (all parameterized; IN-lists via `sql.join`; no dynamic ORDER BY);
the field-codec per-column AAD bindings (symmetric, distinct per column); the W2.1 lock-free atomic cost-cap
reserve gate (correct under READ COMMITTED, deadlock-free lock ordering); the LLM invocation ledger
(content-addressed, replay-safe, no double-pay); webhook HMAC (constant-time, length-guarded, raw-body
isolation) + dedup (`ON CONFLICT DO NOTHING` idempotency claim); installation-token cache (single-flight,
LRU, monotonic negative cache, 80%-TTL refresh, clock-injected JWT skew hardening); session/CSRF
(timing-safe, fail-closed); the SSRF validator *internals* (all-addresses rebind check, IPv4-mapped unwrap,
WHATWG canonicalization); the TenancyPlugin AST walker (stricter than the Python baseline); boot fail-loud
ordering; Vault token redaction + K8s SA-auth lease/renew/invalidate.

---

## Suggested remediation sequence

1. **Deploy-blockers first (small, mechanical, high-impact):** P0-1 partman registration, P0-3 shutdown owner, P0-4 findings keyset (one-line SQL), P0-5 LLM 429 re-throw (one-line). Each is a contained TDD fix.
2. **Broken control:** P0-2 + P2-14 (members/cost-cap approver from body + tenant check) — same two `*_write.ts` functions.
3. **Resilience pass:** P1-A/B (GitHub token-refresh + 429), P1-C (renew fail-open), P1-D (rerank abort), P2-1 (pool max override + sizing), P2-2 (timer unref).
4. **Confluence data-lifecycle (confirm vs frozen Python first):** P1-G/H (supersede + embedding GC), P1-I (empty-set guard), P1-K (vector index) — these are coupled; design as one slice.
5. **Event-loop/perf:** P1-E/F (file cap + binary sniff), P2-8/9 (indexes).
6. The P2/P3 backlog as hygiene.
