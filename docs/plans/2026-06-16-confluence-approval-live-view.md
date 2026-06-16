# Plan: Confluence approval view — surface LIVE pages so `default` pages are approvable before ingest (Option C)

- **Status:** REVISED **r3** (2026-06-16). r1→r2 folded review #1 (label decoupling), #2 (namespaced cursors), #3 (fast-fail), #4 (route seam), #5 (approval validation), #6 (lifecycle), #7 (revoked-status); **D7 confirmed** (resync does a full single-page ingest). **r3** adds: **real AbortSignal cancellation** (not just Promise.race); **audit-only label recording** (no schema change); **best-effort resync dispatch** (approval never rolls back on enqueue failure); **legacy bare-numeric cursor back-compat**; **safer SPA copy** (don't over-encourage approvals); **deterministic latest-approval ordering** + revoke/reapprove tests. Decisions in §9.
- **Date:** 2026-06-16
- **Branch (proposed):** `fix/confluence-approval-live-view` off the deployed HEAD (`fix/review-detail-port-and-confluence-test`)

---

## 1. Problem
`listPagesForIntegration` (`confluence_pages_read.ts:118`) lists pages **`FROM core.confluence_chunks`** — only stored pages. A `default`-labeled page is rejected at ingest until approved (invariant `confluence_chunks_default_approval_biconditional`, `0001_baseline.sql:4507`). So a never-approved `default` page (SEP **196626**) has 0 chunks → invisible → unapprovable → deadlock.

**Option C** keeps the invariant; surfaces the space's pages from **live Confluence** so any page is visible + approvable. **Approve-then-ingest.**

## 2. Goal / end-state
```
label `default` → page shows as not_ingested → approve (existing route, now with existence-check)
  → approval best-effort-dispatches a page-resync → resync fetches+sanitizes+chunks+embeds+upserts it
  → retrieval includes it (approval-drift safeguard satisfied)
```
No schema change, no ingest-rule change. **D7 confirmed:** resync = full single-page ingest (`event_handlers.ts:557`→`_confluence_page_sync.ts:226`→`confluence_sync.activity.ts:536`).

## 3. Facts grounding the plan
- Rewrite target: `confluence_pages_read.ts:77` (offset cursor at `:82`; revoked-excluding join at `:119`).
- Live pages: `client.listPages` → `{items, next_cursor}` (cursor-based; **no labels** in summaries — `client.ts:231`).
- **Client retry/backoff:** `client.ts:9,62` — 429 `Retry-After` ≤600s, 5xx ≤3 attempts, before throwing.
- **`ConfluenceFetch` init has NO `signal`** today (`client.ts` ~164-167) — must be added for real cancellation (review r3 #1).
- Creds→client: `confluence_validator_real.ts`. Resync dispatcher: `PageResyncDispatcherPort` (`confluence_pages_write.ts:26`, best-effort in the revoke path) + wired at `server.ts:180`.
- Approval write: `admin_routes.ts:2200` `createPageApproval`; audit seam `after: Record<string,unknown>|null` is free-form (JSONB) → labels can be logged there with **no schema change** (r3 #2).
- Approval upsert revokes the prior active row + inserts a new active one (`confluence_pages_write.ts:43`) → at most one active row per page; history of revoked rows.

## 4. Design decisions (r3)

| # | Decision |
|---|---|
| **D2** | Two label-free DB fields. `ingest_status: ingested \| not_ingested` (from non-deleted `confluence_chunks`). `approval_status: none \| approved \| revoked` (from the latest approval row, D10). SPA derives the lifecycle from the pair. |
| **D3 (r3 #4)** | Cursor parsing accepts: `live:<opaque>` · `stored:<offset>` · **bare numeric (legacy) → `stored:<offset>`** · malformed/empty → first page. **Never 422/500 on a cursor.** On a live failure holding a `live:` cursor → first stored page + `live_list_available:false`. |
| **D4 (r3 #1)** | **Bounded fast-fail WITH real cancellation.** Admin lister builds the client in fast-fail mode (`maxAttempts:1`, no backoff sleep) AND passes an `AbortSignal`; an `AbortController` + ~4s timeout aborts the in-flight transport (not just a Promise.race that orphans the fetch). On abort/error → fast fallback to the stored query + `live_list_available:false`. Background ingest unchanged (full retry, no signal). |
| D5 | `ConfluencePageListerPort.listSpacePages(spaceKey, cursor, signal)` built from `{db, registry}` (mirrors the validator). |
| D6 | Ingest rule unchanged; no migration. |
| D7 (confirmed) | Approval dispatches a page-resync → full single-page ingest. |
| D8 | Route seam `getConfluencePageLister?: () => ConfluencePageListerPort` on `AdminRoutesOptions`, wired at `server.ts`; stubbed in tests. Undefined/failing → stored fallback + `live_list_available:false`. |
| **D9 (r3 #2,#3,#5)** | At approval: fast-fail `getPage` **existence check** → 422 `page_not_found` on miss. **Allow pre-authorization** (no `default`-label requirement — §9.1). **Record observed labels in the approval AUDIT `after` payload only** (free-form JSONB — *no schema change*). Resync dispatch is **best-effort** (r3 #3): the approval COMMITS even if enqueue fails — warn via the existing `ResyncWarn` sink + a metric; the cron is the safety net (mirrors the revoke path). |
| **D10 (r3 #6)** | Latest approval per page, **deterministic**: `DISTINCT ON (page_id) … ORDER BY page_id, (revoked_at IS NULL) DESC, approved_at_utc DESC, approval_id DESC` (prefer active; else most-recent; tie-break by id). `approval_status` from the picked row's `revoked_at`. |

## 5. Work — TDD-ordered phases (r3)

### Phase 0 — Client: fast-fail + AbortSignal (r3 #1)
- Add `signal?: AbortSignal` to `ConfluenceFetch` init and thread it from `getJson` into `fetchImpl`. Add `maxAttempts`/`fastFail` capping both retry budgets to 1 + skipping `clock.sleep`. Defaults unchanged.
- **Tests:** fast-fail ≤1 attempt, no sleep; **an aborted signal cancels the transport** (fetch sees `signal.aborted`/AbortError) and surfaces promptly.

### Phase 1 — `ConfluencePageListerPort` (D5/D8)
- `listSpacePages({spaceKey, cursor, signal})` over the fast-fail client built from active creds; returns `{items, next_cursor}` or throws (caught upstream).
- **Tests:** stub → mapped summaries+cursor; unconfigured/unreachable/abort → throws.

### Phase 2 — Contracts (D2/D10)
- `PageWithApprovalV1`: add `ingest_status`; keep `approval_status` (incl. `revoked`). `PagesListPageV1`: add `live_list_available`. SPA `admin.ts` + regen.
- **Tests:** Zod; `revoked` representable.

### Phase 3 — Rewrite `listPagesForIntegration` (D2/D3/D10)
- Parse namespaced+legacy cursor (D3). Live branch: lister (with a per-request `AbortController`+~4s deadline, D4) → batch page_ids → two batched reads (chunks: ingested?+labels; approvals: **latest** incl. revoked via D10) → merge → rows; `next_cursor = live:<opaque>`. Fallback branch (throw/abort/undefined lister): stored offset query, `next_cursor = stored:<offset>`, `live_list_available:false`; a `live:`/unknown cursor on fallback → first stored page.
- **Tests:** merge across all 5 lifecycle pairs; fast fallback (no hang, transport aborted); cursor namespacing + **legacy bare-numeric**; revoke/reapprove/revoke → correct `approval_status` (D10).

### Phase 4 — Route wiring (D8)
- Add `getConfluencePageLister` to `AdminRoutesOptions`, wire at `server.ts` (creds-backed, fast-fail); pass `{db, lister}` to `listPagesForIntegration`.
- **Tests:** 200 merged; 200 + `live_list_available:false` when lister unwired/failing.

### Phase 5 — Approve: validate + best-effort ingest (D9)
- Handler: fast-fail `getPage` existence check → 422 `page_not_found` on miss; `createPageApproval`; emit audit with observed labels in `after` (no schema change); **best-effort** `pageResyncDispatcher.enqueueResync(...)` — on failure, `ResyncWarn` + metric, **do not fail the approval**.
- **Tests:** missing page → 422; approve existing → audit carries labels + resync dispatched; **enqueue failure → approval still 200 + warning** (no rollback); (integration) approve → resync → chunks stored → retrievable.

### Phase 6 — Frontend (r3 #5)
- Lifecycle chip from the pair. **Copy:** `not_ingested+none` → neutral **"Not ingested"** + an *optional* secondary action **"Approve for default corpus"** (NOT "Approve to add" — avoids encouraging needless approvals for ordinary pages whose labels we don't fetch). `not_ingested+approved` → "Approved · ingesting…"; `ingested+approved` → "In default corpus"; `ingested+revoked` → "Revoked". Degrade note when `live_list_available:false`.
- **Tests (vitest):** chip states; the "Approve for default corpus" action present (not auto-encouraged) for `not_ingested+none`; degrade note.

### Phase 7 — Cluster verify
- Redeploy → SEP view shows **196626 = not_ingested** → approve → resync → stored (approved) → re-run a PR → `SEP/196626` cited.

## 6. Risks & tradeoffs
- Live dependency on an admin read → Phase-0 fast-fail + **real abort** + ~4s deadline + stored fallback (#1,#3).
- Pagination change → namespaced + legacy-tolerant cursors (#2,#4), opaque to the SPA.
- No live labels → status is storage+approval only; SPA copy is non-pushy (#5).
- Bigger build than Option A (client change + read rewrite + seam + approval validation), but no schema change.

## 7. Out of scope
Biconditional invariant (kept); Option A store-pending; `include_labels`↔corpus-label matching for non-default pages.

## 8. Frontend/back split
Backend Phases 0–5 (`postgres-repo/main`); Frontend Phase 6 (`origin/main`); deploy together.

## 9. Open decisions (need sign-off before Phase 0)
1. **D-label-gate** — allow pre-authorization (recommended) vs require a current `default` label at approval.
2. **D2 enum** final values + the SPA lifecycle copy (esp. the non-pushy "Not ingested" + "Approve for default corpus").
3. **D4 deadline** (~4s?) — fast-fail as a client option (recommended) + the AbortController in the lister.
4. **D9 labels-in-audit** — confirm the audit `after` payload is the right home (no schema change) vs dropping label recording entirely.
5. **Branch** off the current deployed HEAD?

No code yet. On sign-off (or edits) to §9, I start Phase 0.
