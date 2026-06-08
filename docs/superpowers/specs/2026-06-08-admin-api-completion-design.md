# Admin API Completion — Design Spec

**Date:** 2026-06-08
**Status:** Draft (awaiting review)
**Sub-project 1 of 2** in the codemaster frontend migration. Sub-project 2 (extract + wire
`codemaster/frontend` → `codemaster-frontend`) gets its own spec once this lands.

## Goal

Port the **20 admin HTTP endpoints** that the existing Next.js admin frontend consumes but the
new TypeScript backend (`codemaster-backend`) does not yet expose. After this, the new backend
covers **100%** of the frontend's `/api/admin/*` + `/api/auth/*` surface, so the frontend migration
becomes a clean extract + rewire with zero API gaps.

This is **continuation work**, not new design: every endpoint already exists in the frozen Python
backend and is ported **1:1** following the established admin-endpoint methodology.

- **Port source (frozen reference):** `/Users/ascoe/Projects/codemaster/codemaster/api/admin/`
- **Target:** `codemaster-backend` (`apps/backend/src/api/admin/`, `libs/contracts/src/admin.v1.ts`,
  `apps/backend/src/domain/repos/`)
- **Sequencing:** all 20 in one sweep (per project-owner decision), internally batched by cluster.

## Architecture — the 5-layer admin-endpoint pattern

Each endpoint is built from the same five layers (mirror the cited exemplars):

1. **Zod contract** in `libs/contracts/src/admin.v1.ts` — request (writes) + response, `.strict()`,
   `schema_version: z.literal(1).default(1)`. Re-exported so the frontend's wire-types stay in sync.
2. **Repo** in `apps/backend/src/api/admin/<cluster>_read.ts` / `<cluster>_write.ts` — pure async
   functions over `sql\`…\`` with explicit row→contract mappers; reads return mapped contracts,
   writes use optimistic CAS + typed errors. Exemplars: `embedder_read.ts`, `cost_caps_read.ts`,
   `cost_caps_write.ts`, `flags_write.ts`, `repositories_write.ts`.
3. **Route handler** registered in `admin_routes.ts::registerAdminRoutes()` —
   `scope.METHOD(path, { preHandler: requireRole([...ROLES]) }, handler)`; validate path/query
   params; `Zod.safeParse` body → 422; delegate to repo; map typed errors to HTTP codes;
   `reply.code(n).send(ContractV1.parse(data))`. Exemplar: the reviews-list route at
   `admin_routes.ts:1732`.
4. **RBAC** via `_authz.ts::makeRequireRole` — per-route explicit allow-set; 401 invalid session,
   403 (sorted-roles detail) on role miss; `platform_owner` is installation-scoped, `super_admin`
   widest.
5. **Audit emit** (mutations) — `await opts.audit?.({ actorUserId, installationId, action, targetKind,
   targetId, before, after, now })` **after** the DB transaction, keyed to the **affected resource's**
   `installation_id` (not the actor's); `null` for platform-scope. Two-person flows use
   `two_person_approval.ts` helpers.

**Testing per endpoint** (`test/integration/api/admin_<feature>.integration.test.ts`, disposable
Postgres `:5434`, never the cluster): happy path + the authorization matrix (one cookie per role →
401/403/200) + validation (422) + concurrency (409/428 CAS) + audit-callback assertions, and a
**parity check** of the response shape against the frozen Python endpoint.

## Scope — the 20 endpoints (5 clusters)

### Cluster A — Reviews (2) · `review_detail.py`, `your_reviews.py`
| Endpoint | RBAC | Data source (TS) | Port notes |
|---|---|---|---|
| `GET /api/admin/reviews/{review_id}` | operator/owner/super | `core.pull_request_reviews`, `pull_requests`, `repositories`, `review_runs`, `posted_reviews`, `review_findings`, `audit.workflow_events` | tables exist; add `ReviewDetailV1` Zod + `reviews_detail_read.ts`. **medium** |
| `GET /api/admin/your-reviews` | reader/operator/owner/super/security_auditor | — | **Pattern-A foundation**: faithfully returns **empty** `authored`/`assigned` tuples (engineer-identity link + `pr_assigned_reviewers` are deferred Phase-2 work). Add `YourReviewsPageV1` Zod + a stub repo returning empty. **easy** |

### Cluster B — Knowledge writes (3) · `knowledge.py`
| Endpoint | RBAC | Data source | Port notes |
|---|---|---|---|
| `PUT /api/admin/knowledge/{learning_id}` | owner/super | `core.learnings` (CAS on `version`) + `core.learnings_revisions` (atomic INSERT) | If-Match version → 409 stale `{current_body, current_version}`, 428 missing If-Match. New `UpdateLearningBodyV1`/`StaleWriteV1` + `knowledge_write.ts`. **medium** |
| `POST /api/admin/knowledge/proposals/{proposal_id}/approve` | owner/super | `core.learning_proposals` (state validate) | self-approval → 403; already-decided → 409. **Emits Temporal ApprovalSignal** to `KnowledgeApprovalWorkflow`. **hard (signal wiring)** |
| `POST /api/admin/knowledge/proposals/{proposal_id}/reject` | owner/super | `core.learning_proposals` | body `{reason: 10–2048}`; emits Temporal RejectSignal. **hard (signal wiring)** |

### Cluster C — Confluence pages (4) · confluence admin handlers
| Endpoint | RBAC | Data source | Port notes |
|---|---|---|---|
| `GET …/confluence-spaces/{integration_id}/pages` | owner/super | `confluence_page_approvals_repo` / `confluence_chunks_repo` (exist) | read; add Zod + handler. **easy** |
| `POST …/pages/{page_id}/approval` | owner/super | confluence page approvals | write + audit. **medium** |
| `DELETE …/pages/{page_id}/approval` | owner/super | confluence page approvals | write + audit. **medium** |
| `GET …/confluence-spaces/{integration_id}/quarantined-chunks` | owner/super | confluence chunks | read. **easy** |

### Cluster D — Embedder write-lifecycle (8) · `embedder.py` + `embedder/service.py`
All require `{platform_owner, super_admin}`. Tables `core.embedding_generations` +
`core.embedder_runtime_state` exist with all CHECK constraints; repos exist
(`embedding_generations_repo.ts`, `embedder_runtime_state_repo.ts`). **Shared work:** port an
`EmbedderGenerationService` class wrapping those repos, a new `embedder_write.ts` with the 8 handlers,
and the **Temporal workflow dispatcher** wiring.

| Endpoint | Action | Workflow / signal | Port notes |
|---|---|---|---|
| `POST …/reembed/start` | INSERT backfilling + set pending | dispatch `ReembedGenerationWorkflow` | contract `ReembedGenerationInputV1` exists. **easy** |
| `POST …/reembed/cancel` | transition→retired(cancelled) + clear pending | best-effort cancel signal (ignore NotFound/Completed) | **easy** |
| `POST …/reembed/validate` | state-check (∈ backfilling/ready) | dispatch `ValidateGenerationWorkflow` (ALLOW_DUPLICATE) | **medium** |
| `POST …/reembed/activate` | single-active demote+promote (1 tx) | — | preconditions: ready/retired, validation≠false, gc null, chunks>0. **easy** |
| `POST …/reembed/rollback` | alias of activate (allows from retired) | — | delegate to activate. **easy** |
| `POST …/reembed/manual-retire` | transition→retired(manual) | — | guard state='ready'. **trivial** |
| `POST …/reembed/gc` | record `gc_started_at` (retention guard) | dispatch `GarbageCollectGenerationWorkflow` **only on success** | retention default 30 days. **easy** |
| `POST …/embedder/retrieval-mode` | set runtime-state mode | coverage gate (422 if `generation_only` and gap) | needs `setRetrievalMode` service method. **easy** |

### Cluster E — Status + Review-timeline (3) · `status.py`, `review_timeline.py`
| Endpoint | RBAC | Data source (TS) | Port notes |
|---|---|---|---|
| `GET /api/admin/status/pipeline` | reader/operator/owner/super | `core.review_runs`, `core.review_findings`, `telemetry.llm_calls`, `pg_stat_database`, Temporal health (cached 30s) | new `status_repo.ts`. **schema-prefix fix** `review.*`→`core.*`. **medium** |
| `GET /api/admin/status/pilot-progress` | owner/super | `core.installations`, `core.review_runs` (7-day window) | new `status_repo.ts` methods; `sprint_day` = days-since-Monday. **easy** |
| `GET /api/admin/review-timeline` | owner/super | `audit.webhook_events`, `core.outbox` (delivery_id), `telemetry.llm_calls` | new `review_timeline_repo.ts`; external chains (Temporal/Langfuse/GitHub) are **Day-1 shims** → partial-render + `warnings[]`, **no 503**. **hard** |

## Cross-cutting decisions

- **`review.*` → `core.*` schema prefix.** The Python status/review-timeline repos query a `review`
  schema; the TS baseline puts those tables under `core`. The TS port uses `core.*` directly — no
  new schema, no view. (Documented divergence from the Python SQL text; behaviourally identical.)
- **`your-reviews` ships empty (Pattern A).** Faithful to the frozen reference. A follow-up
  (`Phase-2-your-reviews-gh-link`) wires the engineer-identity link + `pr_assigned_reviewers`; out of
  scope here.
- **Temporal signal/dispatch adapters are first-classed once.** Knowledge approve/reject (signals)
  and the embedder writes (dispatch) share a production Temporal-client adapter that replaces the
  current test stub. Built once, reused by both clusters. In tests, the stub is injected (no-op /
  recording), matching the established worker-test pattern.
- **review-timeline external shims stay shims.** Temporal/Langfuse/GitHub chain enrichment returns
  warnings (`ReviewTimelineExternalPort` Day-1 behaviour); production wiring is a tracked follow-up,
  not a blocker for the endpoint.

## Testing & parity

Reuse the admin test harness (`describeDb`, `issueCookie`, `app.inject`). For each endpoint: happy
path + authz matrix + validation + concurrency + audit assertions, plus a response-shape parity
check against the frozen Python endpoint. Mutations that touch Temporal assert the **dispatch/signal
was invoked** (recording stub) rather than a live workflow.

## Risks & open items

1. **Temporal client adapter** (signals + dispatch) is the highest-effort shared piece — it gates
   Clusters B (proposals) and D (embedder). Build + test it first within the sweep.
2. **`migrations/0035`** (an index on `core.outbox.delivery_id`, referenced by the review-timeline
   contract) was not found in the baseline — verify it exists or add the index migration.
3. **`pg_stat_database` raw SQL** + the **30s Temporal-health cache** in `status/pipeline` must be
   ported faithfully (raw `sql()`, in-process TTL cache) to avoid per-request gRPC storms.
4. **`your-reviews` empty result** must be clearly surfaced to the frontend team (the page renders
   but is empty until the Phase-2 identity link).

## Out of scope

- The frontend extraction + rewiring (sub-project 2).
- `your-reviews` real data (Phase-2 engineer-identity link).
- Production wiring of review-timeline's Temporal/Langfuse/GitHub external chains.
- The FE-side `platform-credentials/{provider}` generic-path shim (resolved in the FE client; the
  backend already exposes the fixed `/confluence` + `/embedder/qwen` paths).
