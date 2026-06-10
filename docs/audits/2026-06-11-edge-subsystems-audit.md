# Edge-Subsystems Audit — 2026-06-11

**Scope:** embedder generation lifecycle + knowledge retrieval, admin API / auth surface,
background resource loops (field-encryption key lifecycle, Vault HTTP adapter, GitHub
installation-token providers). These subsystems were **not** covered by the
workflow/pipeline audits but are load-bearing for production resilience and review quality.

**Target:** worktree `/Users/ascoe/Projects/.cmb-worktrees/de-temporal-runner-phase1`,
branch `feat/de-temporal-runner-phase1`. codemaster is an internal AI PR-review platform
(TS/Node backend) serving 60+ GitHub orgs / ~3000 repos; Postgres + pgvector + Vault.

**Inputs:** 29 raw findings, deduped + re-ranked into **25** distinct findings
(5 Critical, 11 High, 7 Medium, 2 Low). Three near-duplicate cuts in the embedder
cluster were merged (see Dedup notes). Severities were re-ranked against a single
cross-subsystem axis: *can this silently wedge the core review loop, corrupt the audit
trail, or degrade review quality with no observable signal?*

---

## Executive Summary

The edge subsystems share one structural failure mode: **machinery that looks wired but
no-ops in production**, with no signal that it has done nothing. The audit surfaces three
clusters.

**1. The embedder generation lifecycle is decorative end-to-end (EC1–EC3, EH1–EH5).**
The admin "re-embed" flow dispatches workflows to a task queue (`embedder-maintenance`)
that **has zero consumers** — verified by grep: every reference is a producer or a
`FOLLOW-UP-embedder-maintenance-worker` comment. A single `/reembed/start` wedges the
whole subsystem into HTTP 409 until an operator hand-cancels the stuck generation. The
dominant repo-knowledge corpus (the 3000-repo context that drives PR review) **never
reads `chunk_embeddings` and never tracks the active generation** — only the smaller
Confluence corpus is wired to the EmbedderCache. The only writer of `chunk_embeddings` is
the Confluence dual-write (`confluence_chunks_repo.ts:214`, verified), so the coverage
gate's `knowledge_missing` can never reach 0 and `generation_only` is structurally
unreachable for repo knowledge. A model swap that keeps 1024 dims passes every guard yet
silently poisons cosine relevance with zero observability. Net: the documented mechanism
to improve retrieval quality cannot be exercised, and activation is a no-op for the corpus
that matters most.

**2. The admin/auth surface ships with security + resilience seams deferred to no-ops
(EC4, EH6–EH10, EM4–EM7).** **CSRF verification is never wired** — `sameSite:lax` session
cookies are the sole credential for every privileged mutation (credential rotation, repo
enablement, role grants, cost caps), so the most privileged surface on the platform is
CSRF-forgeable. **Audit emission is dead on the production server path** — `server.ts`
calls `registerAdminRoutes(...)` with **no `audit` key** (verified) and `authenticate()`
with no audit factory, so credential rotation, role grants, repo enablement, and login
attempts produce **no audit row**. There is **no global Fastify error handler** (verified:
zero `setErrorHandler`), so any unmapped throw — including the `UndefinedColumn` the
`members_read.ts` header itself documents — leaks raw Postgres schema text in a 500.
Revoked role grants still authenticate at login (`role_resolver.ts` deliberately omits
`revoked_at IS NULL`, verified). Three list endpoints fetch entire tables and paginate
in-memory. There is no operator surface to inspect or replay stuck outbox / workflow jobs
— the exact failure class (ADR-0064 mutex leak) that previously required manual DB surgery.

**3. The background resource loops have a fatal cross-pod coupling and missing rotation
loops (EC5, EH11, EM1–EM3).** The field-encryption key registry is loaded in **exactly
one place** (verified: `server.ts:64`, gated behind `CODEMASTER_AUTH_ROUTES_ENABLED`),
so **worker and runner pods never load it** — every housekeeping activity that emits an
audit row (mutex janitor, reaper, retention, repo reconcile) throws
`LocalKeyEncryptionError` inside its transaction and fails the sweep, **re-wedging the
stuck-review class ADR-0064 was built to fix.** There is **no 30-minute key-refresh loop**
anywhere, so ADR-0033's hot key rotation becomes a fleet-wide rolling-restart event. Vault
401/403 (expired/leased-out token) is **not retried** (verified: only 5xx and transport
errors retry), defeating the per-attempt token-file re-read that exists for exactly this
recovery. Two divergent installation-token implementations coexist with different
freshness/retry/cache-bounding semantics.

**The throughline:** these are not isolated bugs. They are *deferred seams that compile,
type-check, and pass component tests while doing nothing in production* — precisely the
class the smoke-runbook gate exists to catch, exercised here against subsystems the smoke
does not yet cover. The highest-leverage fixes are the ones that turn a silent no-op into
a loud failure: load the key registry at worker boot with a fail-loud self-check, wire CSRF
verification and audit emission before exposing the admin surface, and gate `/reembed/start`
behind a real worker (or return 501) instead of minting a permanently-stuck generation.

**Dedup notes:** 29 raw → 25. Merged: the two raw "repo-knowledge not wired to EmbedderCache"
+ "hardcoded query model" findings into **EC2** (same root: ANN path ignores active
generation). Kept the coverage-gate finding (**EC3**) separate because its failure mode
(gate structurally unsatisfiable) is distinct from the retrieval no-op. The
`buildEmbedderCoverage` SQL-duplication low (EL-merged into EH3's fix) is folded as a
sub-recommendation. No findings were dropped — the two raw lows on token-cache negative
eviction and llm-provider re-read are retained as EL1/EL2.

---

## Critical

### EC1 — `/reembed/start` mints a permanently-stuck generation and wedges the subsystem into HTTP 409
- **Subsystem:** embedder generation lifecycle
- **Location:** `apps/backend/src/api/admin/admin_routes.ts:668-686` (dispatch `ReembedGenerationWorkflow` → `embedder-maintenance`); `apps/backend/src/domain/services/embedder_generation_service.ts:106-149` (`startGeneration` sets pending); **no consumer anywhere** (grep-verified)
- **Problem + scenario:** `POST /reembed/start` inserts a generation in state `backfilling`, sets `embedder_runtime_state.pending_generation`, and dispatches workflow type `ReembedGenerationWorkflow` to task queue `embedder-maintenance`. Grep across `apps/backend/src` for `ReembedGenerationWorkflow` / `ValidateGenerationWorkflow` / `GarbageCollectGenerationWorkflow` / `embedder-maintenance` returns **only producers and `FOLLOW-UP-embedder-maintenance-worker` comments** — no worker registers these workflows, nothing polls that queue. So after start: (a) the dispatch silently no-ops; (b) the generation sits in `backfilling` forever with `chunks_backfilled=0`; (c) `transitionToReady` is only callable by the absent backfill worker; (d) cancel is the only exit. Worse, `startGeneration:126-130` throws `PendingGenerationInFlightError` whenever `pending_generation` is non-null — which start just set — so **every subsequent start returns 409** until an operator manually cancels. Scenario: an operator clicks "start re-embed" to adopt a better embedding model across the corpus; they get a generation that never completes and a subsystem locked into 409.
- **Impact:** The admin re-embed lifecycle is non-functional end-to-end. There is no path to ever populate `chunk_embeddings` for repo knowledge; `generation_only` is unreachable for that corpus; knowledge-retrieval quality cannot be improved via the documented mechanism. A single start wedges all future starts.
- **Fix:** Either (1) implement the `embedder-maintenance` worker — `BackfillGenerationActivity` (batch `countCanonicalChunks` → embed via Qwen consumer → `INSERT chunk_embeddings` under the new generation → `updateBackfillProgress` → `transitionToReady`), registered on the `embedder-maintenance` queue under the **exact** workflow type strings dispatched in `admin_routes.ts`; **or** (2) until that lands, make `/reembed/start` return **501/409 with an explicit "embedder-maintenance worker not deployed" error** rather than minting a stuck generation that pins the pending pointer. Also reconcile the PascalCase dispatch strings (`admin_routes.ts:674,813,994`) with the snake_case wire names the docstrings name as the eventual contract.

### EC2 — Repo-knowledge ANN retrieval ignores the active generation and embeds queries with a hardcoded model
- **Subsystem:** embedder generation lifecycle / knowledge retrieval
- **Location:** `apps/backend/src/wiring/retrievers.ts:90-92` (`buildAnnPort` has no `embedderCache`); `apps/backend/src/retrieval/ann_port.ts:141-171` (`PostgresAnnPort` reads `core.knowledge_chunks.vector` directly, no `generation_id` predicate); `apps/backend/src/worker/build_activities.ts:721,726` + `ann_retriever.ts:76-79` (hardcoded `qwen3-embed-0.6b`)
- **Problem + scenario:** *(merged from two raw findings — same root.)* The Confluence adapter is wired to the EmbedderCache and scores against `chunk_embeddings` under the active generation. The **repo-knowledge ANN path — the larger 3000-repo corpus that dominates PR-review context — is not.** `buildAnnPort()` constructs `PostgresAnnPort` with no embedder cache; `PostgresAnnPort.search` reads `knowledge_chunks.vector` directly with no generation predicate (only the `_sql_no_cache` branch is ported; Phase-A/Phase-C SELECTs are `FOLLOW-UP-ann-embedder-cache`). Separately, the query is embedded with the boot-time hardcoded `qwen3-embed-0.6b`, never `embedder_runtime_state.active_model_name`. Scenario: an operator activates a new generation; repo-knowledge retrieval changes nothing, and if the active model differs, the query vector (`qwen3-embed-0.6b`) silently diverges from the operator's intended corpus model.
- **Impact:** For the dominant corpus the entire generation machinery is decorative. Re-embedding repo knowledge under a new model is impossible (no producer, no reader). A model change silently degrades cosine relevance and therefore review quality, with no counter and no degraded flag. The "active generation feeds `retrieve_knowledge`" contract holds only for Confluence.
- **Fix:** Port the Phase-A/Phase-C SELECT branches into `PostgresAnnPort` and thread the EmbedderCache through `buildAnnPort` exactly as `buildConfluencePort` does, so `knowledge_chunks` retrieval JOINs `chunk_embeddings` under the active generation. Drive the query-embed model from `embedder_runtime_state.active_model_name` (via the cache) instead of the hardcoded `qwen3-embed-0.6b`, so query and corpus vectors stay model-consistent across an activation.

### EC3 — Coverage gate's `knowledge_missing` can never reach 0 → `generation_only` is structurally unreachable for repo knowledge
- **Subsystem:** embedder generation lifecycle / coverage gate
- **Location:** `apps/backend/src/domain/repos/embedding_generations_repo.ts:432-440` (`countCoverageGap` knowledge anti-join); `apps/backend/src/domain/services/embedder_generation_service.ts:300-319` (`setRetrievalMode` gate); **only Confluence dual-writes** `chunk_embeddings` (`confluence_chunks_repo.ts:211-225`, grep-verified)
- **Problem + scenario:** `setRetrievalMode('generation_only')` refuses the flip if `totalMissing > 0`, where `totalMissing = confluence_missing + knowledge_missing`. `knowledge_missing` counts active `knowledge_chunks` with no `chunk_embeddings` row under the active generation. But **nothing ever inserts a `knowledge_chunks` row into `chunk_embeddings`** — grep confirms only `confluence_chunks_repo.ts:211-225` writes that table, and only for `chunk_table='confluence_chunks'`. No backfill worker (EC1), and the knowledge-indexing path does not dual-write. So `knowledge_missing` equals the full active `knowledge_chunks` count and never drops.
- **Impact:** Two failure modes. (1) If repo knowledge exists, `generation_only` can **never** be enabled — the documented Phase-C cutover is unreachable. (2) If an operator somehow forces `generation_only`, Phase C INNER-JOINs `chunk_embeddings`, so repo-knowledge retrieval returns **empty**, silently zeroing knowledge context in reviews. The gate's only green state is "repo knowledge is empty" — it structurally encodes that as an unstated precondition.
- **Fix:** Make the knowledge-indexing path dual-write to `chunk_embeddings` under the active generation (symmetric to `confluence_chunks_repo.upsertChunks`), **and** implement the backfill worker (EC1) so existing `knowledge_chunks` get rows. Until both exist, either exclude `knowledge_chunks` from `countCoverageGap` **or** document `generation_only` as Confluence-only — do not let the gate silently encode an empty-corpus precondition.

### EC4 — CSRF double-submit verification is never wired; every cookie-authenticated admin/auth mutation is forgeable
- **Subsystem:** admin-auth (SECURITY)
- **Location:** `apps/backend/src/api/auth/auth_routes.ts:13-16,221-234` (token-SEED only); `apps/backend/src/api/admin/admin_routes.ts` (no verify hook); `apps/backend/src/api/server.ts:74-96`
- **Problem + scenario:** The session cookie is `sameSite:"lax"` (`auth_routes.ts:106`, **not** `strict`) and is the **sole** credential for every admin mutation. `/api/auth/csrf` only **seeds** the double-submit token; the verification middleware is explicitly deferred and unwired (`FOLLOW-UP-csrf-verification-middleware`). Grep finds **no `addHook`/`onRequest`/`verifyCsrf`** in `apps/backend/src/api` (verified: only the `CSRF_COOKIE_NAME` constant exists). `makeRequireRole` checks only the session cookie. Scenario: a super_admin visits a malicious page that auto-submits a top-level POST/PUT; `sameSite:lax` carries the session cookie, and there is no token check — the request rotates LLM provider credentials, enables repos, changes cost caps, or approves role changes.
- **Impact:** Classic CSRF wedge on the most privileged surface in the platform. Full privileged state change with no token check, from any cross-site context.
- **Fix:** Land `FOLLOW-UP-csrf-verification-middleware`: a Fastify `onRequest`/`preHandler` hook on all non-GET admin+auth routes that compares the `csrf_token` cookie against an `X-CSRF-Token` header (timing-safe), 403 on mismatch. Wire the already-loaded `csrfSecret` (`server.ts:68-71`) into the hook and tighten the admin session cookie to `sameSite:"strict"`. **Do this before the admin surface is exposed.**

### EC5 — Worker + runner pods never load the field-encryption key registry → every housekeeping audit emit throws and fails its sweep
- **Subsystem:** field-encryption key lifecycle / worker audit emit (RESILIENCE)
- **Location:** `apps/backend/src/api/server.ts:56-66` (**only** loader call site, gated behind `CODEMASTER_AUTH_ROUTES_ENABLED`, verified); `apps/backend/src/worker/main.ts` (no load, verified); `apps/backend/src/worker/build_activities.ts` (no `setAuditKeyRegistry`); `apps/backend/src/security/audit_field_codec.ts:90-98` (`requireRegistry` throws); `apps/backend/src/audit/emit.ts:136-137`
- **Problem + scenario:** `loadFieldEncryptionKeyRegistry() + setAuditKeyRegistry()` are called in **exactly one place** — the `CODEMASTER_AUTH_ROUTES_ENABLED==="true"` branch of `runServer()` (verified at `server.ts:64-66`). The codec keeps the registry in a module-global; `encryptAuditJsonBytea()` → `requireRegistry()` throws `LocalKeyEncryptionError` when null. The Temporal worker and background runner **never call any loader**, yet they run many activities that emit audit rows with non-null `before/after`: `mutex_janitor.activity.ts:124-140`, `review_run_reaper.activity.ts:189-190`, `run_id_retention.activity.ts:320-321,639-640`, `reconcile_repositories.activity.ts`, `hydrate_installation_repositories.activity.ts`, `start_review_for_webhook.activity.ts:125-140`. In the documented split-pod topology (`codemaster-worker-review` / `codemaster-worker-ingest`, separate from the api pod) these processes have **no registry at all**. Even in a combined entrypoint they only inherit a populated module-global by accident, coupled to an env flag that has nothing to do with audit encryption.
- **Impact:** Every scheduled mutex sweep, retention close, reaper cancellation, and repo reconcile throws inside its transaction and **fails the activity**. The mutex janitor and reaper — the self-healing loops that release stuck PR-review mutexes — cannot commit their sweep because the in-transaction audit INSERT explodes, **directly re-wedging the stuck-review class ADR-0064 was built to fix.** Silent dependency on an unrelated env flag.
- **Fix:** Load the registry **unconditionally** at worker boot (`worker/main.ts`) and runner boot (`background_runner_main.ts`): `loadFieldEncryptionKeyRegistry(VaultHttpPort.fromEnv())` then `setAuditKeyRegistry(...)` before `Worker.create` / before the loops start; **fail-loud if Vault is unreachable.** Decouple registry loading from `CODEMASTER_AUTH_ROUTES_ENABLED` in `server.ts`. Add a worker/runner startup self-check (`getAuditKeyRegistry() !== null`, analogous to `startupSelfCheck()` for tree-sitter) so a missing registry crashes the pod at boot, not mid-sweep.

---

## High

### EH1 — `activate()` updates the two generation tables in separate transactions → durable split-brain active pointer
- **Subsystem:** embedder generation lifecycle (RESILIENCE)
- **Location:** `embedder_generation_service.ts:228-233` (`transitionToActive` then `stateRepo.activate`); `embedding_generations_repo.ts:279-298`; `embedder_runtime_state_repo.ts:125-145`
- **Problem + scenario:** `activate` calls `gensRepo.transitionToActive(id)` (its own `db.transaction`) and **then** `stateRepo.activate(...)` (a **separate** `db.transaction`). If the process dies / connection drops / request cancels between them, `embedding_generations` marks the target `active` (and demotes the old one to `ready`), but `embedder_runtime_state.active_generation` still points at the **old** generation. Both rows independently satisfy their biconditional CHECKs, so nothing rejects it. The EmbedderCache and all retrieval read `active_generation` from runtime_state, so retrieval keeps serving the old generation while the generations table claims the new one is active — and there is **no reconciler**.
- **Impact:** Durable split-brain: retrieval serves the old generation indefinitely while `/embedder/state` shows contradictory truth. A third `activate` would demote the "wrong" active in the generations table. No self-healing path; an operator must hand-edit one of the two tables.
- **Fix:** Make `activate` atomic across both tables — run `transitionToActive` and the runtime_state update inside **one** `db.transaction` (thread a shared tx into both repo methods). Ordering alone does not fix it; only a single commit does. Additionally add a startup/periodic reconciler asserting `runtime_state.active_generation == the single state='active' generation row`, fail-loud / repair on mismatch.

### EH2 — Confluence dual-write stamps the active generation's model name onto boot-time-embedder vectors → corrupted provenance
- **Subsystem:** embedder generation lifecycle / dual-write (QUALITY)
- **Location:** `apps/backend/src/activities/confluence_sync.activity.ts:556-565` (resolves `activeModelName` from cache, passes `chunk.embedding`); `confluence_chunks_repo.ts:213-224` (writes `embedding_model_name=active model`, `embedding=row.embedding`)
- **Problem + scenario:** `chunk.embedding` is computed upstream by `chunk_and_embed` using the fixed boot embedder (the same `qwen3-embed-0.6b` wiring). The dual-write stores that **same vector** into `chunk_embeddings` but stamps `embedding_model_name = embedderCache.getActiveModelName()` — whatever the active generation names. If an operator activates a generation whose model differs from the boot embed model, every subsequent dual-write row claims model X but holds a model-Y vector. `content_sha256` is text-derived, so it can't detect the skew.
- **Impact:** `chunk_embeddings.embedding_model_name` becomes unreliable provenance. A future `generation_only` Phase-C read trusts these rows; mixing model-X-labeled-but-model-Y vectors with genuine model-X vectors in one generation degrades cosine relevance (cross-model vectors aren't comparable). The 1024-dim guard won't catch a same-dimension model swap. Silent quality degradation with a corrupted audit trail.
- **Fix:** Make the vector and its recorded model name always agree — embed the chunk with the active generation's model at dual-write time, **or** only dual-write when active `model_name` equals the boot embed model, **or** stamp `embedding_model_name` with the model that actually produced the vector (the boot model).

### EH3 — No model/dimension-consistency guard at retrieval; only a static `==1024` check at the cache boundary
- **Subsystem:** embedder generation lifecycle / retrieval (QUALITY)
- **Location:** `apps/backend/src/adapters/embedder_cache.ts:222-237` (`validateDimInvariant` checks only `==1024`); `ann_port.ts:158-168` + `postgres_confluence_retrieval.ts:189-219` (pgvector `<=>` with no model/dim assertion)
- **Problem + scenario:** The only consistency guard asserts active `embedding_dimension == 1024`. It does **not** compare the query-embed model to the corpus model, and the retrieval SQL computes cosine with no guard that the query vector came from the same model as the stored vectors. Because the platform is 1024-locked, two **different** 1024-dim models (a model swap via activate) both pass the invariant, but their vectors are not cosine-comparable.
- **Impact:** A model change that keeps 1024 dims passes every guard yet silently destroys relevance — cosine scores become meaningless across models, so top-k chunks fed to the review LLM are near-random. Zero observability (`AnnRetriever` only degrades on embed-service errors). Combined with EC2's hardcoded query model, an activation can quietly poison retrieval.
- **Fix:** Carry embedding-model identity through retrieval — bind `embedding_model_name` into the Phase-A/Phase-C predicates (already a `chunk_embeddings` column) so only same-model vectors are scored, and assert the query-embed model equals the active generation's `model_name` before the search. Emit a degraded signal + counter on disagreement. **(Fold in the EL coverage-SQL dedup: `buildEmbedderCoverage` at `embedder_read.ts:196-209` should delegate to `countCoverageGap`/`getCoverage` rather than re-implement the anti-join, so any model-name predicate added here lands in one place.)**

### EH4 — No 30-minute field-encryption key-refresh loop exists; ADR-0033's hot rotation is unimplemented
- **Subsystem:** field-encryption key lifecycle / rotation drift (SELF-HEALING)
- **Location:** `apps/backend/src/security/field_encryption_keys_loader.ts` (load-once only); `server.ts:64-66` (single `await`, no interval); `audit_field_codec.ts:28-33` (names the missing `FOLLOW-UP-audit-vault-key-loader`)
- **Problem + scenario:** ADR-0033 / CLAUDE.md require field-encryption keys "refreshed every 30 min via the FastAPI / worker lifespan." The TS port loads the registry **exactly once** (verified) and has **no periodic refresh** anywhere. The Confluence token provider got its 30-min loop ported (`token_provider.ts:227 refreshLoop`); the field-encryption keyset did not.
- **Impact:** When an operator rotates the key (adds vN, advances `current_version`), running pods keep encrypting under the **old** `current_version` indefinitely until restart. If a restarted pod writes rows under vN+1, a long-lived pod that loaded the keyset earlier cannot decrypt them (`KeyNotFoundError` → `LocalKeyEncryptionError`), so `audit_events` / `users.email` / feedback reads fail until restart. Across a fleet of long-lived worker pods, rotation becomes a fleet-wide rolling-restart event instead of the hot operation ADR-0033 promises.
- **Fix:** Port the periodic refresh: a clock-driven loop (reuse the `ConfluenceTokenProvider` pattern — injected `Clock.sleep(1800 ± jitter)`, fail-open on transient Vault error keeping the prior registry, structured warn on stale) that re-reads the keyset and calls `registry.set(makeKeySet(...))` atomically. Wire its start into `runServer`/`runWorker`/`runBackgroundRunner` lifespans and its disposal into SIGTERM teardown (`disposables.disposeAll` already exists at `background_runner_main.ts:507`).

### EH5 — Per-chunk single-row INSERTs + no-retry embedder make a 3000-repo backfill O(N) round-trips with no batching
- **Subsystem:** embedder generation lifecycle / backfill throughput (SCALABILITY)
- **Location:** `confluence_chunks_repo.ts:173-228` (per-row INSERT loop in one txn); `apps/backend/src/integrations/qwen/consumer.ts:120-160` (one `/embed` POST, 10s timeout, **no retry**); `embedder_cache.ts:195-216` (lazy 15s-TTL refresh per query/batch)
- **Problem + scenario:** The dual-write loops one INSERT per chunk — for a full re-embed across 60+ orgs / 3000 repos that is millions of single-row round-trips, serialized inside one transaction per page, holding the connection and accumulating WAL. The Qwen consumer embeds with a single POST, a 10s timeout, and **no retry** — at backfill scale a transient 429/5xx aborts the activity, and Temporal retries the **whole page**, re-embedding everything (`findExistingChunkEmbedding` is per-chunk). The cache's 15s lazy refresh re-reads `embedder_runtime_state` per query/batch — a steady stream of singleton-row SELECTs (read contention on the one runtime_state row) under high throughput.
- **Impact:** A real platform-wide re-embed (the subsystem's entire purpose) would be very slow and connection-hungry. The ADR-0062 pool budget is already tight (kind pg ~89/100 per project memory), so a backfill risks `TooManyConnections` and crowds out the live review pipeline. The no-retry embedder + whole-page Temporal retry amplifies embed cost and wall-clock.
- **Fix:** Batch the dual-write as multi-row `INSERT ... VALUES` (or `COPY`) per page; batch embed requests (Qwen `/embed` already takes `texts[]`) with bounded retry/backoff on 429/5xx in the consumer so a blip doesn't abort + re-embed a page; and run the backfill worker on its **own connection pool / task queue** per the core-loop-isolation invariant so it can't starve the review pipeline.

### EH6 — No global Fastify error handler → unmapped throws leak raw Postgres schema text in the 500 body
- **Subsystem:** admin-auth (RESILIENCE)
- **Location:** `apps/backend/src/api/app.ts:48-103` (`buildApp`, no `setErrorHandler`); whole-backend grep for `setErrorHandler` returns **zero** (verified)
- **Problem + scenario:** `buildApp` registers no `app.setErrorHandler(...)` and there is none anywhere. Dozens of admin handlers end with a bare `throw e;` after mapping their known typed errors (`admin_routes.ts:1089,1313,1409,1526,2578,2621`, etc.). Any unmapped throw — an asyncpg `UndefinedColumn`/`UndefinedTable` (the `members_read.ts:10-22` header documents its frozen SQL is stale and "would raise UndefinedColumn at runtime"), pool exhaustion, a JSONB read-contract mismatch — propagates to Fastify's default handler, which responds 500 with `{statusCode,error,message}` where `message` is the raw `Error.message` (Postgres echoes column/table names and sometimes query fragments).
- **Impact:** Operator-facing 500s leak internal schema/topology/error detail with no uniform redaction. Combined with the documented schema drift, `GET /api/admin/members` against the real schema 500s with the DB's column-not-found text. Inconsistent error envelope also breaks frontend error rendering.
- **Fix:** Add `app.setErrorHandler` in `buildApp` that logs the full error server-side (structured) and returns a generic `{detail:"internal error", request_id}` 500 with **no** raw `error.message`, plus a 404 not-found handler.

### EH7 — Audit emission is dead on the production server path → privileged operations leave no audit trail
- **Subsystem:** admin-auth (SECURITY)
- **Location:** `apps/backend/src/api/server.ts:74-96` (`registerAuthRoutes` + `registerAdminRoutes` calls omit audit seams — **verified: opts object has no `audit` key**); `auth_routes.ts:142-150` (`authenticate` omits `auditCallbackFactory`); `admin_routes.ts:329-331` (`audit?` optional → no-op)
- **Problem + scenario:** `server.ts` calls `registerAdminRoutes({db,signingKey,clock,registry,vault,getPreflightValidator,pageResyncDispatcher})` — **no `audit`** (verified by inspecting the opts object), so `opts.audit` is undefined and every `await opts.audit?.(...)` across the router is a silent no-op: LLM-credential rotation (`admin_routes.ts:2256`), repo-enable (`1279`), role-change approvals, cost-cap changes emit **no audit row**. Likewise `registerAuthRoutes` is called without an audit factory, so login success/failure audit never fires (`FOLLOW-UP-login-audit-emit-wiring`). `admin_routes.ts:329-331` documents "the TS audit-emit pg-client wiring is dormant."
- **Impact:** The most security-sensitive operations on the platform (credential rotation, role grants, repo enablement, login attempts) produce **no audit trail** in production. `GET /api/admin/audit-events` exists but has nothing to read for these actions. Post-incident forensics and the compliance story are unmet; a malicious or compromised super_admin leaves no record.
- **Fix:** Wire a concrete `MemberAuditEmitter` / `AuditCallback` (the TS audit-emit pg-client) into both `registerAuthRoutes` and `registerAdminRoutes` in `server.ts` **before the admin surface is exposed.** (Note: this depends on EC5 — the audit emit path itself throws on worker/runner without the key registry; fix EC5 first.)

### EH8 — No operator surface to inspect or replay stuck/dead-lettered outbox + workflow jobs
- **Subsystem:** admin-ops (SELF-HEALING)
- **Location:** `apps/backend/src/api/admin/admin_routes.ts` (only read-only `review-timeline` at `2799-2860`); `page_resync_dispatcher.ts:72` (drops to outbox, no inspect/replay route)
- **Problem + scenario:** The admin surface has **no** endpoint to list, inspect, retry, or release stuck/dead-lettered outbox rows or stuck review workflows. `GET /api/admin/review-timeline` is read-only and per-single-delivery, and its workflow + GitHub-posting chains are hardcoded Day-1 shims that always return `null+warning` (`2834-2838`). Project memory records a real prior incident class — the 37-row mutex leak / stuck reviews (ADR-0064) — that required manual DB surgery (scale deploy 0→1) to recover.
- **Impact:** When the outbox or a workflow wedges (a failure mode the platform has already hit), operators have **no in-product way** to find the stuck rows or replay them — recovery needs direct Postgres/Temporal access. This is the missing self-healing operator surface for a system whose core loop depends on outbox + Temporal dispatch.
- **Fix:** Add operator read+action endpoints, gated to `platform_operator+`: `GET /api/admin/outbox?status=failed` (list dead-lettered rows with `last_error`/`attempts`), `POST /api/admin/outbox/:id/retry` (reset for re-dispatch, **archived per the migration-safety archive-before-mutate rule**), and a stuck-review lister/releaser.

### EH9 — Three list/dashboard reads fetch ALL rows then paginate in-memory → unbounded query cost at scale
- **Subsystem:** admin-read (SCALABILITY)
- **Location:** `apps/backend/src/api/admin/admin_read_repo.ts:204-225` (`listLearningsPage`), `240-271` (`listProposalsPage`), `357-377` (`listIntegrationsPage`); slice helper `_keyset_cursor.ts:34-66`
- **Problem + scenario:** Three paginated reads run `SELECT ... FROM <table> ORDER BY ...` with **no `LIMIT` / cursor pushdown**, load the entire result set into Node, then `keysetSlice` in memory to return one page. `listIntegrationsPage` selects **every** integration platform-wide (no tenancy filter, `363-368`). Header comments concede this is a faithful port of Python's "fetch-all + `_apply_keyset_slice`."
- **Impact:** At 60+ orgs / 3000 repos, learnings and Confluence integrations grow without bound. Every page-1 request transfers and sorts the **full** table, so latency and worker memory scale O(N) with total rows regardless of page size, and the connection holds a large result set (worsening the kind pg connection-budget pressure). A large tenant can make these endpoints slow/OOM-prone and starve the shared core pool.
- **Fix:** Push the keyset predicate + `LIMIT size+1` into SQL (the `listFindings`/`listPullRequests` reads already do this correctly at `678-698` and `757-768` — mirror that). Decode the cursor to `(ts,id)` and add `WHERE (updated_at, learning_id) < (:ts,:id) ... ORDER BY ... LIMIT :n`.

### EH10 — Reviews list uses OFFSET pagination + `COUNT(*) OVER ()` with a full per-PR finding aggregation across all repos
- **Subsystem:** admin-read (SCALABILITY)
- **Location:** `admin_read_repo.ts:80-164` (`searchReviews`); route `admin_routes.ts:2583-2601`
- **Problem + scenario:** `searchReviews` paginates by `LIMIT size OFFSET (page-1)*size` and computes `COUNT(*) OVER ()` on every request. The `counted` CTE aggregates COUNT + MAX-severity over `core.review_findings` for the **entire** matching set (for super_admin's platform view, all findings across all 3000 repos) before the outer LIMIT/OFFSET. There is no upper bound on `page`.
- **Impact:** OFFSET forces Postgres to scan-and-discard `(page-1)*size` rows per request; the windowed COUNT and unbounded `counted` CTE force a full aggregation over `review_findings` on each page load. For a platform-view super_admin this is a full-table aggregate **per dashboard refresh** — high latency, heavy I/O, pool contention against the hot core store, worst on deep pages.
- **Fix:** Switch to keyset pagination on `(pr.created_at, pr.review_id)` (already the ORDER BY) and drop `COUNT(*) OVER ()` in favor of has-more over-fetch (as `listFindings` does), or cap `page`. Constrain the `counted` CTE to the PRs on the current page via a JOIN/lateral.

### EH11 — Vault HTTP 401/403 (expired/leased-out token) is not retried → a token-lease blip fails the in-flight operation
- **Subsystem:** Vault HTTP adapter / token-lease expiry (RESILIENCE)
- **Location:** `apps/backend/src/adapters/vault_http.ts:273-307` (retry loop; **verified: only 5xx + thrown transport errors retry**, 4xx falls through to `return resp`)
- **Problem + scenario:** The `_request` retry loop re-reads the token file at the top of each attempt (good — handles Vault Agent rotation) but only retries on thrown transport errors and HTTP 5xx (verified: the `>=500 && <600` branch is the only status-based retry; everything else returns to the caller). A **403** (what Vault returns when `X-Vault-Token` has expired or its lease was revoked) is a 4xx: it short-circuits past the retry branch, becomes a `VaultConnectivityError` with **no second attempt** — even though re-reading the token file on a fresh attempt is exactly the recovery the per-attempt re-read was designed for.
- **Impact:** During the window where the Vault Agent has rendered an about-to-expire token (or is mid-renewal), a single 403 fails the in-flight operation: an LLM-credential Transit decrypt fails the review activity, a webhook-secret read 403s and the webhook is rejected, an installation-token mint's downstream Vault read fails. The recovery (next attempt re-reads the fresh token) never runs. At fleet scale, frequent token renewals surface this as intermittent, hard-to-diagnose review/webhook failures.
- **Fix:** Classify 401/403 from Vault as retryable in `_request` (retry with backoff, re-reading the token file on the next attempt) up to `MAX_RETRIES`, then surface `VaultConnectivityError`. Keep other 4xx non-retryable (404 → `VaultPathNotFound`, 400 → CAS mismatch). Mirrors the GitHub token provider's 401-retry-with-fresh-credential pattern (`token_provider.ts:411-420`).

---

## Medium

### EM1 — `activate()` precondition gap: a `ready` generation can be activated mid-backfill, demoting the live active and orphaning the pending pointer
- **Subsystem:** embedder generation lifecycle (RESILIENCE)
- **Location:** `embedder_generation_service.ts:198-239` (activate preconditions); `embedder_runtime_state_repo.ts:125-145` (activate clears pending unconditionally)
- **Problem + scenario:** `activate` checks state ∈ {ready,retired}, `gc_completed_at` null, `validation_passed ≠ false`, `chunk_embeddings > 0`. It does **not** check whether `pending_generation` is set to a **different** generation still backfilling. `stateRepo.activate` unconditionally clears `pending_generation`/`pending_model_name`. So if generation N is mid-backfill (pending) and an operator activates an older `ready` generation M, the activation succeeds and silently wipes N's pending tracking. The `chunk_embeddings > 0` guard is weak: any single row passes, so a generation that backfilled 1 of 3000 chunks can go live.
- **Impact:** An activate during an in-flight re-embed orphans the pending generation (the backfill worker, once it exists, and the cancel-by-pending logic lose the pointer) and can promote a near-zero-coverage generation. In `generation_only` this collapses retrieval to near-empty, zeroing review knowledge context. Single-active invariant is preserved but the pending lifecycle is corrupted.
- **Fix:** In `activate`, reject (or require an explicit `force`) when `pending_generation` is a different `generation_id`. Strengthen the coverage precondition from `chunk_embeddings > 0` to `countCoverageGap(activeGeneration) == 0`, consistent with the `setRetrievalMode` gate, so a partially-backfilled generation cannot go live.

### EM2 — Installation-token cache TTL mixes GitHub server time with local clock → clock skew distorts the refresh boundary
- **Subsystem:** GitHub installation-token cache / clock skew (RESILIENCE)
- **Location:** `apps/backend/src/integrations/github/token_provider.ts:478-480` (`ttlSeconds = expiresAt - mintedAt`), `490-498` (`mintedAt = clock.now()`)
- **Problem + scenario:** `cachePut` stamps `mintedAt` with local `clock.now()`; `expiresAt` comes from GitHub's server response. `cacheLookup` derives `ttlSeconds = (expiresAt - mintedAt)/1000` — a duration spanning two clocks — and compares elapsed against `ttlSeconds * refreshAtFraction`. If the pod clock runs behind GitHub's, `ttlSeconds` is overstated and the refresh boundary moves later. The 0.8 default gives ~12 min cushion on a 60-min token (absorbs ordinary skew), but a pod with minutes-to-hour skew (NTP failure, VM pause) can compute a refresh boundary past true expiry and present a dead token.
- **Impact:** On a skewed pod, tokens can be served past expiry → 401s from GitHub on review-comment posts / clone fetches. A cache-served stale token surfaces as a downstream GitHub API error (not a mint-time 401 the retry path handles), so it manifests as flaky "token expired" failures correlated with one bad node.
- **Fix:** Derive freshness from server-authoritative `expires_at` directly against `clock.now()` (refresh when `clock.now() >= expiresAt - margin`, additionally bounding by `refreshFraction` of nominal TTL), matching the `installation_token.ts:142-148` sibling. Do not infer TTL by subtracting a local timestamp from a server timestamp.

### EM3 — Two divergent installation-token implementations coexist with different freshness/retry/cache-bounding semantics
- **Subsystem:** GitHub installation-token providers (SCALABILITY)
- **Location:** `token_provider.ts` (LRU-bounded + refresh-fraction 0.8 + negative cache + 5xx backoff) vs `installation_token.ts:120-227` (unbounded Map, fixed `expires_at-30s` margin, no retry, no negative cache)
- **Problem + scenario:** `installation_token.ts` exposes a full second token path: `InstallationTokenCache` (an **unbounded** `Map<number,...>`, unlike `token_provider`'s 1000-entry bound) plus `getInstallationToken()` with a fixed `expires_at-30s` margin, **no** 5xx retry/backoff, **no** negative cache. `token_provider.ts` re-exports `KeyedMutex` from this module but reimplements the cache/mint with stronger semantics. Which one a call site uses determines its resilience profile, and the two disagree on the refresh boundary (0.8-fraction vs fixed 30s).
- **Impact:** Any live call site routing through `getInstallationToken`/`InstallationTokenCache` (a) leaks one Map entry per installation forever — across 3000 repos / churned installations the Map grows unbounded in a long-lived pod; (b) has no negative cache, so a deleted/suspended installation under webhook-redelivery fan-out hammers GitHub's mint endpoint; (c) has no 5xx backoff, so a GitHub blip fails the first call. Behaviour silently depends on which seam was wired at composition.
- **Fix:** Designate `GitHubAppTokenProvider` as the single token path (LRU bound + negative cache + backoff) and delete/downgrade `InstallationTokenCache`/`getInstallationToken` to test-only, **or** back the latter with the same LRU bound + negative cache. Audit every `getToken`/`getInstallationToken` call site to confirm one seam. Keep the shared `KeyedMutex` (that reuse is correct).

### EM4 — `role_grants` resolution does not filter `revoked_at` → a revoked role still authenticates at login
- **Subsystem:** admin-auth (SECURITY)
- **Location:** `apps/backend/src/api/auth/role_resolver.ts:11-13,78-83` (**verified: faithful-port note explicitly states `revoked_at IS NULL` is not filtered**)
- **Problem + scenario:** `PostgresRoleResolver.resolve` selects from `core.role_grants` matching subject/scope but deliberately does not filter `revoked_at IS NULL` (verified header note: "revocation is not honored at resolve time"). The session role is therefore computed from grants that may already be revoked.
- **Impact:** Revoking a grant has **no effect** on the next login: the user still receives a session cookie carrying the highest-precedence (possibly revoked) role for up to the 12h session lifetime. There is no server-side session revocation either (stateless HMAC, idle enforcement deferred), so a de-provisioned operator retains access — a real privilege-revocation-doesn't-take gap.
- **Fix:** Add `AND revoked_at IS NULL` to the `role_grants` SELECT (`role_resolver.ts:79-83`) and to `InMemoryRoleResolver` parity. This is a deliberate parity-break the header flags as a separate decision — make it; the security cost of honoring stale grants outweighs Python parity.

### EM5 — Per-IP login rate limiter is an in-process Map → defeated by multi-replica admin-api and unbounded key growth
- **Subsystem:** admin-auth (SCALABILITY/RESILIENCE)
- **Location:** `apps/backend/src/api/auth/rate_limit.ts:3-9,28` (in-process `#failures` Map); `auth_routes.ts:89-96` (one limiter per process)
- **Problem + scenario:** `LoginRateLimiter` stores failure timestamps in a process-local `Map<key, Date[]>`; the header assumes "single-pod admin-api needs no cross-pod coordination." The IP key is the leftmost `X-Forwarded-For` (`auth_routes.ts:71-82`), client-spoofable if the edge doesn't strip/normalize it. The Map is pruned only per-key on access, so keys for IPs that never retry are never evicted.
- **Impact:** On OpenShift the admin-api can scale to >1 replica; a spray distributed across pods means each pod sees < threshold and the limit never trips (credential-spraying protection silently void). A spoofed/rotating XFF bypasses per-IP bucketing entirely. The unbounded Map is a slow memory leak / DoS vector under a distinct-IP flood.
- **Fix:** Move the rate-limit counter to Postgres (the header notes it "lifts cleanly to Postgres"), keyed on a **trusted** client IP derived from the known proxy hop count, with periodic GC of stale keys; or pin admin-api to one replica and document it.

### EM6 — Audit before/after decrypt fails OPEN to a placeholder excerpt → silently masks key-rotation/corruption on the forensic surface
- **Subsystem:** admin-read (RESILIENCE)
- **Location:** `apps/backend/src/api/admin/audit_events_read.ts:9-10,123-134` (`decryptExcerpt` catch → `VAULT_UNAVAILABLE`), `28`
- **Problem + scenario:** `decryptExcerpt` wraps `decryptAuditJsonBytea` in a try/catch that, on **any** failure (wrong AAD, missing key generation, ciphertext corruption, format drift), returns the constant `<encrypted; vault unavailable>` instead of surfacing the error. Per-row, so a systemic decrypt failure (e.g. a key-registry generation mismatch after rotation — see EH4) renders the **whole** audit page as placeholders with a 200 OK.
- **Impact:** A field-encryption key rotation/registry-load bug, or `before/after` written under a generation the reader can't resolve, is invisible: the reader returns 200 with every row redacted to a benign-looking placeholder. Operators cannot distinguish "no data" from "decryption is broken platform-wide," defeating the forensic purpose at exactly the moment it matters.
- **Fix:** Count/emit a metric on decrypt failure and distinguish transient-vault-unavailable from key-mismatch/corruption (different placeholder + structured warn per failure); consider a degraded-flag in the response envelope so the UI can warn.

### EM7 — Audit-events cursor stores `occurred_at` but the keyset compares `created_at` → microsecond skew can skip or duplicate page boundaries
- **Subsystem:** admin-read (QUALITY)
- **Location:** `apps/backend/src/api/admin/audit_events_read.ts:71-88` (cursor encodes `occurred_at`), `192-205` (WHERE on `(created_at, audit_event_id)`; ORDER BY `created_at DESC, audit_event_id DESC`), `211-214`
- **Problem + scenario:** The SELECT projects `created_at AS occurred_at` and orders by `created_at DESC, audit_event_id DESC`, but the keyset predicate compares `(created_at, audit_event_id) < (:occurredAt, :auditEventId)` where `:occurredAt` is an ISO string round-tripped via `new Date(last.occurred_at).toISOString()`. Postgres compares the bound ISO string against `created_at timestamptz`; if `created_at` has microsecond precision the JS `toISOString()` (millisecond truncation) loses precision, so the strict `<` tuple comparison can skip rows at a page boundary or mis-order at equal timestamps.
- **Impact:** Operators paging the audit log can silently **miss** rows whose `created_at` microseconds differ from the millisecond-truncated cursor, or get shifted/duplicate boundaries. For an audit/forensics surface, silently dropping events at page seams is a correctness/compliance defect.
- **Fix:** Bind the cursor as a timestamptz cast (`(created_at, audit_event_id) < (CAST(:ts AS timestamptz), :id)`) and carry full microsecond precision in the cursor (encode the raw DB value, not a JS-truncated ISO).

---

## Low

### EL1 — `PUT /llm-provider-config` with `role='secondary'` returns the PRIMARY slot's metadata and 500s when no primary row exists
- **Subsystem:** admin-write (QUALITY)
- **Location:** `admin_routes.ts:2267-2274` (re-read hardcodes primary via `getLlmProviderConfig` default); `admin_read_repo.ts:478-500`
- **Problem + scenario:** After writing secondary-role settings, the handler re-reads via `getLlmProviderConfig(opts.db)`, which defaults to `role='primary'`. The code comment acknowledges the carried-over Python quirk: a `secondary` PUT returns the primary slot's body and 500s when no primary row exists even though the secondary write succeeded.
- **Impact:** A super_admin rotating the **secondary** provider credential gets the wrong slot's metadata (confusing UI) or a spurious 500 after a successful write — the write persisted but the response says it failed, inviting a duplicate retry. Low (super_admin-only, secondary slot) but a real response-correctness bug.
- **Fix:** Re-read the slot just written — pass `body.role` to `getLlmProviderConfig` (`admin_routes.ts:2270`), as the legacy bedrock-config path already does (`2400` passes `'primary'` explicitly).

### EL2 — Token-provider negative cache is evicted only lazily on re-lookup → entries for never-revisited installations leak for process lifetime
- **Subsystem:** GitHub token-provider negative cache (SCALABILITY)
- **Location:** `token_provider.ts:209` (`negativeCache` Map, no size bound), `342-345` (insert on permanent error), `513-524` (delete only inside `checkNegativeCache` for that id)
- **Problem + scenario:** Unlike the positive cache (LRU-bounded via `cachePut` eviction), the `negativeCache` Map has no size bound and no sweep. An entry is deleted only when `getToken` is called again for that exact `installation_id` after its 60s TTL. An installation that hit a `PermanentTokenError` once and is never requested again leaves its entry resident for the process lifetime.
- **Impact:** Bounded in practice (entries only on permanent failures — deleted/suspended installs — small relative to 3000 active repos), so not a wedge. But over a very long-lived pod with churning installations it is a slow, unbounded-in-principle accumulation of `NegativeCacheEntry` objects (each holding a `PermanentTokenError` with a captured stack).
- **Fix:** Bound the negative cache the same way as the positive cache (LRU cap, or an opportunistic sweep of expired entries on insert).

---

## Prioritized Implementation Order

The ordering optimizes for *fail-loud-not-silent* and *unblock-the-blockers*: fix the
seams whose absence currently produces no signal, then the ones that gate everything else,
then quality/scalability hardening.

**P0 — Production-blocking before the admin surface or worker fleet is exposed:**
1. **EC5** — load the field-encryption key registry at worker/runner boot with a fail-loud
   self-check, decoupled from `CODEMASTER_AUTH_ROUTES_ENABLED`. *Gates EH7 and the
   self-healing loops; re-wedges ADR-0064 if left.* Smallest change, largest blast radius.
2. **EC4** — wire CSRF verification + tighten the admin cookie to `sameSite:strict`.
3. **EH7** — wire concrete audit emission into `registerAuthRoutes`/`registerAdminRoutes`
   (after EC5, since the emit path needs the registry).
4. **EH6** — add the global Fastify error handler (stop leaking schema text); pairs with
   EH7 so unmapped throws are logged, not echoed.
5. **EM4** — filter `revoked_at IS NULL` in the role resolver (one-line security fix).

**P1 — Make the embedder lifecycle real (or honestly closed) + key rotation hot:**
6. **EC1** — either build the `embedder-maintenance` worker or return 501 from
   `/reembed/start`. Decide the path; do not leave a stuck-generation wedge.
7. **EH4** — port the 30-min key-refresh loop (unblocks hot rotation; pairs with EC5).
8. **EH1** — make `activate()` atomic across both generation tables + add a reconciler.
9. **EC2 + EC3** — wire repo-knowledge ANN to the EmbedderCache/active generation and
   dual-write `knowledge_chunks` (or document `generation_only` as Confluence-only). These
   two move together — the coverage gate and the retrieval reader must agree.
10. **EH11** — classify Vault 401/403 as retryable (resilience for every secret consumer).

**P2 — Provenance + quality correctness:**
11. **EH2** — fix the vector/model-name provenance mismatch in the Confluence dual-write.
12. **EH3** — add the model/dim consistency guard at retrieval (fold in the
    `buildEmbedderCoverage` SQL-dedup).
13. **EM1** — strengthen `activate()` preconditions (reject mid-backfill activation;
    coverage-gap instead of `>0`).
14. **EM6** — distinguish vault-unavailable from corruption on the audit-decrypt path.
15. **EM7** — fix the audit-events cursor microsecond skew.

**P3 — Scalability + operator surface hardening:**
16. **EH8** — add the outbox/stuck-job operator inspect+replay endpoints.
17. **EH9 + EH10** — convert in-memory pagination and OFFSET+`COUNT(*) OVER ()` to keyset.
18. **EH5** — batch the backfill dual-write + embed requests + retry, on an isolated pool.
19. **EM2 + EM3** — unify the two installation-token providers (server-time freshness,
    single bounded path).
20. **EM5** — move the login rate limiter to Postgres with a trusted client IP.

**P4 — Cleanups:**
21. **EL1** — re-read the written LLM-provider slot.
22. **EL2** — bound the token-provider negative cache.

---

*Audit synthesized from 29 raw findings (deduped to 25) on 2026-06-11. Key claims
spot-verified against the worktree at synthesis time: the `embedder-maintenance` queue has
no consumers; `chunk_embeddings` is written only by the Confluence dual-write; no
`setErrorHandler` exists anywhere in the backend; the field-encryption registry is loaded
only in `server.ts:64`; `registerAdminRoutes` opts carry no `audit` key; the Vault retry
loop retries only 5xx + transport errors; `role_resolver.ts` omits `revoked_at`.*
