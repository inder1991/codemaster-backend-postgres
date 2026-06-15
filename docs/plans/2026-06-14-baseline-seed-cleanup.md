# Plan: Fix the /admin/llm experience — seed cleanup + Job Routing refresh + layout redesign

- **Date:** 2026-06-14
- **Status:** PROPOSED — awaiting approval (discuss-before-fixing)

Four workstreams on the LLM admin surface. Together they deliver the intended UX end-to-end: a clean
catalog on fresh deploys → add a model → validate it → assign it to a job → it **actually routes
there**, on a page that looks enterprise-grade. They share no code and can ship separately:

- **Part 1 — Backend** (`codemaster-backend`, this worktree, branch `feat/deploy-contract-preflight`):
  stop shipping dev-seeded model/routing/flag data to fresh deploys.
- **Part 2 — Frontend** (`codemaster-frontend`, branch `feat/go-live-config-ui`): make a
  newly-added/validated model appear in the Job Routing dropdown without a manual page reload.
- **Part 3 — Frontend** (`codemaster-frontend`, branch `feat/go-live-config-ui`): redesign the
  `/admin/llm` layout (section-rail) and fix the visual bugs so it reads as enterprise-grade.
- **Part 4 — Backend + a frontend touch** (`codemaster-backend` worktree + `codemaster-frontend`): make
  the Job Routing UI actually drive execution — a DB-backed purpose resolver + a DELETE/reset route
  (ADR-0060 "step 1").

---

# Routing execution gap (surfaced by review) — RESOLVED → build it (Part 4)

**Decision:** option (A) — build the DB-backed resolver, scoped as **Part 4** below. (The "default
can't be cleared" gap is fixed there too, via the DELETE/reset route.)

**The Job Routing UI persists assignments that review execution ignores.** The admin API writes
`core.llm_purpose_model` (PUT `admin_routes.ts:2457`), but every runtime path picks its model via the
**static** `modelForPurpose()` seed (`model_router.ts:45`) and never reads the table (verified — only
`model_router.ts` references it, in comments). So assigning "Code review → my-model" in the UI has **no
effect** on which model runs; the DB-backed resolver ("ADR-0060 step 1") was deferred. Two coupled gaps:

- **(High) Routing doesn't drive execution.** Decide one:
  - **(A) Build it** — add a backend **Part 4**: a DB-backed purpose resolver (read `llm_purpose_model`,
    merge over `PURPOSE_MODEL_SEED`, fail-open to the seed, short cache) wired into the
    `modelForPurpose()` callers, so the Job Routing UI actually controls execution. The only way
    "assign a model to a job" becomes real.
  - **(B) Document as a known limitation** — keep the UI as display/persistence, label it clearly
    ("routing assignments are recorded but do not yet change the executing model"), and drop the
    "route a job to it" framing.
- **(Medium) "— default —" can't be cleared.** There is **no DELETE/reset route** for
  `llm_purpose_model` (admin exposes only GET `:2448` + PUT `:2457`), and the frontend "default" option
  only mutates local state (`LlmJobRoutingCard:102`) — so a persisted pin **reappears on refresh**. Fix
  depends on the above: under (A) add a DELETE/reset route + wire "default" to it; under (B) make
  "default" visibly non-persistent (or disabled) until backend support lands.

---

# Part 1 — Backend: remove dev-incidental seed data from the squashed baseline

- **Files touched (product):** `migrations/0001_baseline.sql` — the 10 seed INSERTs **and** the header
  note (lines 9–12, which currently asserts "identical seed rows / DO NOT hand-edit"); plus any docs the
  sweep (step 4) corrects.
- **File touched (test):** `test/integration/api/admin_llm_models_write.integration.test.ts`

## Problem

`migrations/0001_baseline.sql` is a squashed `pg_dump` of a **dev** database — every seeded row is
stamped `2026-06-03 20:13` by actor `migration-seed`. The squash captured incidental dev data
alongside the legitimate product defaults, and that dev data now ships to **every fresh customer
deploy**:

- a pre-populated **LLM model catalog** — 3 Claude models the customer never chose;
- **purpose→model routing pins** (3 rows) that surface in the admin Job Routing UI as if the
  customer set them;
- 4 **archived feature-flag** rows — a historical snapshot left over from migration 0090.

Customer standing constraint: **no seeding** of dev data. These rows are dev-specific, not product
defaults.

## Root cause

The baseline was produced by dumping a working dev DB with `--inserts` and no table-level exclusion
of operator/dev-populated tables. There is **no committed squash/regeneration tooling** (no
package.json script, nothing under `tools/`/`scripts/`), so the baseline is hand-maintained —
editing it is the fix, and nothing will silently re-add the rows on a later build.

## Scope — what to remove vs keep

**Remove** (10 INSERTs — dev-incidental):

| Table | Rows | Baseline lines (current) |
|---|---|---|
| `core.flags_archive_0090` | 4 — archived `pull_requests_v1_enabled`, `pr_files_v1`, `pr_issue_links_v1`, `review_findings_persisted_v1` | 3741–3744 |
| `core.llm_models` | 3 — `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5-20251001` (all `anthropic_direct`, `untested`) | 3819–3821 |
| `core.llm_purpose_model` | 3 — `review_finding→sonnet`, `walkthrough→opus-4-7`, `analysis_curator→haiku` | 3834–3836 |

**Keep** (18 INSERTs — product defaults / functional necessities):

- `core.flags` ×3 — cost-cap defaults ($5k global / $1k per-org / kill-switch off).
- `core.platform_config` ×11 — platform defaults.
- `core.embedder_runtime_state` ×1 + `core.embedding_generations` ×1 — the embedder needs an active
  generation to function (functional default).
- `core.global_config` ×1.
- `core.installations` ×1 — the `__platform_sentinel__` row.

Only the INSERT rows are removed; the `CREATE TABLE` + constraints for all three tables stay, so a
fresh deploy gets the empty tables.

## Why this is safe

1. **Existing/deployed DBs are untouched.** `migrate:up` is `node-pg-migrate ... --no-check-order`;
   node-pg-migrate tracks applied migrations by **name** in `pgmigrations` and never re-runs or
   checksums file contents. A DB that already ran `0001_baseline` skips it — the edit affects
   **fresh deploys only**. (`migrate:down` is disabled by design: the squashed baseline is
   irreversible.) Already-deployed labs/customers keep their rows and can delete them via the admin
   UI — the allow-list removal + tolerant-JSON-parser fixes that unblocked the catalog Delete button
   are already live.

2. **No dangling FK inside the baseline.** The only inbound FK into the catalog is
   `fk_llm_purpose_model_model_id (model_id) REFERENCES core.llm_models(model_id) ON DELETE
   RESTRICT`. We remove the `llm_purpose_model` rows **and** the `llm_models` rows, so no purpose row
   is left referencing a deleted model. `llm_provider_settings`, `llm_invocation_ledger`, and
   `review_jobs` have **no** FK into `llm_models` — their `model_id` columns are free strings.

3. **Runtime routing is unchanged — the runtime never reads `llm_purpose_model` at all.** Every runtime
   caller resolves its model through the **static** `modelForPurpose()` (`model_router.ts:45` =
   `PURPOSE_MODEL_SEED.get(purpose) ?? DEFAULT_MODEL`): `review_activity.ts:111`,
   `walkthrough_activity.ts:292`, `curator.ts:262`, `llm_backed_rerank.ts:216`,
   `fix_prompt_theme_activity.ts:175`. The DB-backed resolver that would merge `llm_purpose_model` over
   the seed is **explicitly out of scope** (`model_router.ts:13`, `review_activity.ts:109` —
   "ADR-0060 step 1"), and a grep confirms **no runtime path reads the table**. So removing the DB seed
   cannot change execution — it was never read. (Read side: the admin GET `listLlmPurposeModels`
   (`admin_read_repo.ts:545`) returns only persisted rows and the contract defaults `assignments` to
   `[]` (`admin.v1.ts:510`) — no seed projection. After removal the GET returns `[]`, and the
   **frontend** `LlmJobRoutingCard` defaults each of its 7 hard-coded purposes to "— default —".)
   Reviews already require the customer to configure a provider + credentials (never seeded), so an
   unconfigured deploy's behavior does not change.

## Implementation (TDD)

All edits in the worktree on `feat/deploy-contract-preflight`.

1. **Fix the one dependent test FIRST** so the suite proves the seed is no longer needed.
   `test/integration/api/admin_llm_models_write.integration.test.ts` leans on the **seeded** HAIKU: it
   reads it (lines 48–51) and restores it via `UPDATE` in `afterAll` (58–61), and the "updates existing"
   case (line 97) PUT-upserts HAIKU. It works today ONLY because it never *deletes* HAIKU — and it must
   not: the baseline seeds `analysis_curator → claude-haiku-4-5-20251001` (`0001_baseline.sql:3836`) and
   `fk_llm_purpose_model_model_id` is **ON DELETE RESTRICT** (`:8437`), so deleting HAIKU while that pin
   exists errors. **Do NOT add HAIKU to `cleanup()`.** Instead decouple the test from HAIKU entirely:
   - Introduce a test-owned id `M_UPD = "itest-llmw-upd"` (`anthropic_direct`). In `beforeAll` (after
     `cleanup()`) seed it: `INSERT INTO core.llm_models (provider, model_id, enabled) VALUES ('anthropic_direct', ${M_UPD}, true);`
   - Point the "updates existing" PUT — and the 403/422 cases, where model existence is irrelevant — at
     `M_UPD` instead of `HAIKU`; assert it returns `M_UPD`.
   - Add `M_UPD` to `cleanup()`'s DELETE set (nothing in `llm_purpose_model` references it → FK-safe).
   - Delete the `origHaiku` capture (48–51) and the `afterAll` HAIKU restore (58–61); drop the `HAIKU`
     constant. Fix the stale docstring (6–9) and the line-28 comment (which wrongly claims HAIKU has "no
     dependent purpose" — the seed pins `analysis_curator` to it).
   This decouples the test from BOTH the seeded HAIKU and the `analysis_curator` pin, so it passes
   against the current (seeded) DB **and** the de-seeded one, in any order.

   The other 4 tests that referenced these tables need **no change** (verified):
   `llm_provider_settings_repo` + `review_job_shell_gates` use model_ids only as free-string payloads
   (no catalog FK); `admin_llm_purpose_routing_write` (line 41) and `admin_llm_config` (line 63)
   already **self-seed** their own `llm_models` rows.

2. **Remove the 10 seed INSERTs** from `migrations/0001_baseline.sql`. Remove **bottom-up**
   (`llm_purpose_model` 3834–3836 → `llm_models` 3819–3821 → `flags_archive_0090` 3741–3744) or
   anchor on the exact statement text, so earlier removals don't shift later line numbers. If a
   `-- Data for Name: <table>; Type: TABLE DATA; …` comment header precedes a now-empty block, drop
   it too.

3. **Update the baseline header** (lines 9–12). It asserts the dump is semantic-diff verified to produce
   "identical seed rows" and says "DO NOT hand-edit — regenerate via the recipe above". After this
   surgical edit that is misleading, and regeneration is impractical (the pre-fusion migrations are
   squashed to git history — the recipe cannot be re-run from the working tree). Reword it to: the
   **schema** stays semantic-diff-identical to the pre-fusion migrations; the **seed data** was
   intentionally trimmed post-fusion on 2026-06-14 (the 3 dev `llm_models`, 3 `llm_purpose_model` pins,
   4 `flags_archive_0090` rows — see this plan); and if the baseline is ever regenerated, the source DB
   must exclude these rows. (No CI gate enforces the old claim — verified there is no automated
   semantic-diff/parity check in this repo — so the edit is safe; this is purely keeping the header
   honest.)

4. **Sweep docs for stale claims** that "the baseline seeds" these models/pins/archived flags
   (runbooks, ADRs, first-deploy doc) and correct them
   (`grep -rn 'claude-opus-4-7\|seeds.*model\|purpose.*pin' docs/`).

## Verification

- `npm run typecheck && npm run lint`.
- Unit: `npm test` — full suite green. No unit test depends on the DB seed (a grep for the seeded
  model-ids matched only the 5 integration tests + one corpus fixture).
- Integration on a **fresh** disposable PG (the real proof — never the cluster; use
  `CODEMASTER_PG_CORE_DSN` per `test/integration/_db.js`):
  - create a throwaway DB, `CODEMASTER_PG_CORE_DSN=… npm run migrate:up`;
  - `SELECT count(*)` → **0** for `core.llm_models`, `core.llm_purpose_model`,
    `core.flags_archive_0090`;
  - `SELECT count(*)` → **3** for `core.flags` (cost caps kept), **11** for `core.platform_config`;
    `__platform_sentinel__` installation present;
  - run the 5 LLM/runner integration tests against the fresh DB → all green (especially
    `admin_llm_models_write`).
  - GET `/api/admin/llm-purpose-routing` → `assignments: []`; load `/admin/llm` → all 7 Job-routing
    rows show "— default —" (the frontend default; the backend returns no pins).
- `helm lint` unaffected (no chart change).

## Existing deployments

No data migration is shipped to delete these rows from already-migrated DBs. A blind `DELETE` could
remove a model/pin a customer has since adopted, and `ON DELETE RESTRICT` would block deleting a
model still referenced by a purpose. Existing deploys manage the dev rows via the admin UI if they
want them gone. This part makes **new** deploys clean; it does not touch live data.

---

# Part 2 — Frontend: Job Routing dropdown doesn't reflect newly-added/validated models

- **Repo/branch:** `codemaster-frontend` / `feat/go-live-config-ui`
- **Files:** `src/app/(authed)/admin/llm/page.tsx`, `src/components/admin/LlmModelCatalogCard.tsx`,
  `src/components/admin/LlmJobRoutingCard.tsx` (+ their component tests).

## Problem

On `/admin/llm`, the **Model catalog** card and the **Job routing** card are two independent
components. Each holds its own `models` list in `useState`, fetched **once on mount**
(`useEffect(…, [])`). When you Add / Test / Delete a model in the catalog card, it refreshes *its
own* list — but the routing card is never told, so its dropdown keeps showing the **stale** set
until you manually reload the page.

Dropdown membership is governed by two gates (`LlmJobRoutingCard.tsx:50` —
`m.enabled && m.last_validation_status === "ok"`):

- **Gate 1 — must be validated (`status === "ok"`). This is intended, not a bug.** The catalog card's
  **Add** flow already auto-runs the preflight (`handleAdd`: PUT the row, then `testLlmModel`), so a
  model with valid provider creds goes green on add. The UI documents this: "A model becomes
  assignable only after a green preflight."
- **Gate 2 — the routing card never re-fetches after a catalog change. This is the bug.** Even a
  freshly-green model stays invisible in Job Routing until a page reload.

(Earlier, Gate 1 was *impossible* to clear because the **Test** button 400'd — that empty-body bug is
already fixed. So the only thing still blocking "add a model → route to it" is Gate 2.)

## Root cause

No shared source of truth and no cross-card notification: `LlmModelCatalogCard` and
`LlmJobRoutingCard` each own a private `models` state; catalog mutations call only the catalog card's
own `refresh()`.

## Fix — recommended: single source of truth

Lift the model-list fetch into the parent page (`src/app/(authed)/admin/llm/page.tsx`): the page owns
`models` + a `refreshModels()` and passes them to both cards.

- `LlmModelCatalogCard` receives `models` + `refreshModels` as props; after add/test/delete it calls
  `refreshModels()` instead of its private list refresh.
- `LlmJobRoutingCard` consumes the shared `models` (and keeps its own `listPurposeRouting()` fetch for
  the per-purpose assignments).

Result: the two views can't diverge — a validated model appears in Job Routing immediately, a deleted
one disappears, with no reload. Stay on the plain-`useState` pattern; these cards deliberately avoid
react-query (`LlmJobRoutingCard.tsx:15`).

**Lighter alternative** (if the state-lift is judged too large): keep each card self-fetching, but
pass an `onModelsChanged` callback to the catalog card and a `modelsVersion` counter to the routing
card; the catalog calls it after mutations → the parent bumps the counter → the routing card adds
`modelsVersion` to its refresh `useEffect` deps and re-fetches. Smaller diff, but two fetches of the
same data remain (not a true single source of truth).

## Implementation (TDD) + Verification

- **RED:** a component test that renders the page, adds + validates a model via the catalog card, and
  asserts it appears as a Job Routing option **without** a remount/reload. Fails today (routing card
  is stale).
- **GREEN:** implement the shared-state lift; update the existing card/page component tests for the
  new prop wiring.
- **Manual:** add a model with valid creds → selectable in Job Routing immediately; Test an untested
  model → appears once green; Delete a model → disappears from the options — all with no reload.

## Out of scope for Part 2

An added-but-**unvalidated** model still won't be assignable (Gate 1, intended). If untested models
should also be selectable, that's a separate product decision — not included here.

---

# Part 3 — Frontend: /admin/llm layout redesign (section-rail) + visual fixes

- **Repo/branch:** `codemaster-frontend` / `feat/go-live-config-ui`
- **Files:** `src/app/(authed)/admin/llm/page.tsx`, a new `SettingsSection` component,
  `LlmProviderCard.tsx`, `LlmModelCatalogCard.tsx`, `LlmJobRoutingCard.tsx`,
  `ui/elements/Button.tsx`, `lib/api/llm-models.ts`, `app/globals.css` (+ their tests).

## Problem — why it reads "school project"

Confirmed in `page.tsx`:

- **No shared vertical rhythm** — the left column is `space-y-3`, the right `space-y-8`
  (`:104` vs `:113`), so cards don't align across the gutter.
- **Lopsided 2-column grid** (`:102`) — short "compact-by-design" provider cards beside the tall
  catalog/routing column leave a large dead void at bottom-left (the biggest amateur tell).
- **Doubled headings** — an `<h2>` section label in the page *and* a repeated title inside each card
  (`LlmJobRoutingCard:138` "Job routing", `LlmModelCatalogCard:226` "Model catalog",
  `LlmProviderCard:219`), so e.g. "Job routing" prints twice. This violates the `Card` primitive's own
  contract ("the section `<h2>` stays bare ABOVE the card").
- **Unaligned add-model form** — the 2×2 field grid + a floating "Save & test" don't line up with the
  table above.

## Fix — section-rail settings layout (chosen direction)

Stacked full-width sections; each is a left **rail** (title + description) beside the control card(s),
divided from the next. Stacks to one column below `lg`. Removes the height imbalance and the duplicate
titles by construction and imposes one consistent rhythm.

1. **New `SettingsSection` component** (`src/components/ui/layout/SettingsSection.tsx`):
   - `grid grid-cols-1 lg:grid-cols-3 gap-x-8 gap-y-4 py-8`; top divider (`border-t c-border-default`,
     suppressed on the first).
   - Rail (`lg:col-span-1`): `<h2>{title}</h2>` + muted `<p>{description}</p>`.
   - Content (`lg:col-span-2 space-y-4`): `{children}`. The rail IS the bare section heading the `Card`
     docstring expects.

2. **Rebuild the Inference tab** in `page.tsx` as three `SettingsSection`s, dropping the in-page `<h2>`
   labels (`:105/:116/:122`):
   - *Providers* — "Primary and failover inference credentials; each is configured independently." →
     two `LlmProviderCard`s.
   - *Model catalog* — "Add and validate the models you'll route to. A model becomes assignable only
     after a green preflight." → `LlmModelCatalogCard`.
   - *Job routing* — "Map each job to a validated model; unassigned jobs fall back to the platform
     default." → `LlmJobRoutingCard`.
   Apply the same `SettingsSection` to the **Embedding tab** (Platform credentials / Re-embed
   lifecycle) so both tabs share one layout language.

3. **Strip the duplicate card-internal titles** (the rail now owns the heading):
   - `LlmJobRoutingCard.tsx:138` — remove `<h3>Job routing</h3>` + its description.
   - `LlmModelCatalogCard.tsx:226` — remove `<h3>Model catalog</h3>` (keep the `<h4>Add model</h4>`
     sub-heading at `:349`).
   - `LlmProviderCard.tsx:219/:153` — demote to a card sub-label; simplify `cardTitle` to
     "Primary" / "Secondary" (the rail already says "Providers").

4. **Align the add-model form** — one consistent field grid, with "Save & test" docked to a
   right-aligned action row rather than floating beside "Display name".

## Bundled visual fixes (from the earlier pass)

5. **Button disabled treatment** (`Button.tsx:109` + `globals.css`): replace `opacity-50` — which
   muddies the saturated amber primary to brown on the dark theme — with a neutral disabled style:
   a `:disabled` override class (muted-grey bg + faint text + `opacity:1`), keeping `cursor-not-allowed`.
   Primitive-level, so it fixes every disabled button app-wide.
6. **Catalog add result** (`LlmModelCatalogCard.tsx:202–208, 438–445`): split the single `addSuccess`
   state into three outcomes — added+validated → `status.healthy` (green); added-but-preflight-failed →
   `status.degraded` (amber warning, NOT green); add failed → `status.down` (red). Drop the duplicated
   "preflight failed:" prefix (use the raw `result.message`).
7. **Surface the 409 model-id collision** (`lib/api/llm-models.ts:233–245`): `upsertLlmModel` parses
   401/403/422 but lets **409 fall through to a generic "PUT failed (409)"**, hiding the backend's
   structured `detail.code = "llm_model_id_taken"` (the cross-provider collision from the allow-list
   removal, `admin_routes.ts:2333`). Parse 409 exactly like 422 (extract `detail` →
   `LlmModelDetailError`) so the add-model form shows the real message.

## Implementation (TDD) + Verification

- **RED first:** update `LlmProviderConfigPage.test.tsx` to assert the section-rail structure with one
  heading per group (no duplicate "Job routing"); add a `Button` disabled-style test; add a catalog
  test that a failed preflight renders the *warning* variant, not success. Watch them fail.
- **GREEN:** build `SettingsSection`, rewire `page.tsx`, strip the card titles, fix the Button + banner.
- Update the moved-heading assertions in the affected card tests (`LlmProviderCard.test.tsx`, the
  catalog/routing card tests).
- `pnpm lint && pnpm typecheck && pnpm test` (the frontend uses **pnpm** — `packageManager: pnpm@9.12.0`;
  scripts: `lint` = `eslint .`, `test` = `vitest run`, `typecheck` = `tsc --noEmit`).
- **Manual:** three sections on one rhythm, no dead void, a single title per section; disabled buttons
  read as neutral grey; a failed add shows amber, a good add shows green; a cross-provider model_id
  collision shows the 409 detail message inline.

---

# Part 4 — Backend: make Job Routing drive execution (DB-backed purpose resolver) + DELETE/reset

- **Repo/branch:** `codemaster-backend` (this worktree) + a frontend touch in `codemaster-frontend`.
- **Files (backend):** new `apps/backend/src/llm/purpose_model_resolver.ts` (+ a trivial static-fallback
  variant for tests) and its read repo (a NEW validating JOIN query — **not** the `admin_read_repo.ts:545`
  read); a new `PurposeModelResolverLike` interface threaded to the 5 call sites (`review_activity.ts:111`,
  `walkthrough_activity.ts:292`, `curator.ts:262`, `llm_backed_rerank.ts:216`,
  `fix_prompt_theme_activity.ts:175`) — `LlmClientCacheLike` stays `{ forRole }`, untouched. Curator + rerank
  are built through **intermediate factories**, so the resolver must be threaded through each layer too:
  `activities/static_analysis.activity.ts` (`buildStaticAnalysisActivity` → `AnalysisCurator`),
  `activities/retrieve_knowledge.activity.ts` (`buildRerankOverride` + the `RetrieveKnowledgeActivity` field),
  and `wiring/retrievers.ts` (`buildRetrieveKnowledgeActivity`). Inject at **both** composition roots
  `worker/build_activities.ts:477` **and** `runner/in_process_ports.ts:133`. Plus `admin_routes.ts` +
  `api/admin/llm_catalog_write.ts` (new `deletePurposeModel`, modelled on `deleteModel:26`);
  `libs/contracts/src/admin.v1.ts` (GET `LlmPurposeModelV1` → 8-value `LlmPurposeV1`; PUT
  `LlmPurposeAssignmentUpdateV1` → a NEW 4-value executable subset) + the contract parity test(s).
- **Files (frontend):** `LlmJobRoutingCard.tsx` (4-purpose list + default→DELETE), `lib/api/llm-models.ts`
  (new `deletePurposeRouting`), and the regenerated `lib/api/generated/contracts.ts`.

## Goal

Wire `core.llm_purpose_model` (which the admin UI already writes) into runtime model selection, so
assigning "Code review → my-model" changes which model executes. This is ADR-0060 "step 1", deferred
in the TS port (`model_router.ts:13`, `review_activity.ts:109`).

## Design (revised twice — per the code audit, then the contract/DI review)

1. **DB-backed resolver — STANDALONE, with its OWN validating query.** `LlmClientCache`
   (`integrations/llm/client_cache.ts:267`) has **no DB handle** (its `repo` is a narrowed port:
   `readRotationFingerprint` + `readDecryptedSettings`) and **no TTL** (freshness is a fingerprint over
   `llm_provider_settings.last_rotated_at`, which the purpose-routing write doesn't bump). So the resolver
   is its **own** object — `PurposeModelResolver` — with its own read repo (built `fromDsn(dsn)`; DSN is in
   scope at both roots) and its own freshness: a **simple short TTL (~30 s)** — NOT a fingerprint over
   `core.llm_purpose_model`, since validity also depends on `core.llm_models.enabled` /
   `last_validation_status`, which change via `setValidation` (`llm_catalog_write.ts:131`) and
   enable/disable **without** touching the purpose table (a purpose-only fingerprint would serve a stale
   "valid" verdict); a plain TTL bounds staleness across both tables. **Its query MUST validate model
   state** — the existing `SELECT purpose,
   model_id` (`admin_read_repo.ts:545`) cannot — so add a resolver-only join:
   `SELECT pm.purpose, pm.model_id, m.enabled, m.last_validation_status FROM core.llm_purpose_model pm
   LEFT JOIN core.llm_models m ON m.model_id = pm.model_id`. `resolve(purpose)`:
   - pin exists **AND** `m.enabled` **AND** `m.last_validation_status = 'ok'` → use the pin;
   - else (no pin / missing / disabled / not-ok / any DB error) → `PURPOSE_MODEL_SEED.get(purpose) ??
     DEFAULT_MODEL` (**fail-open**; mirrors the UI's "(no longer valid)").
   Keep the static `modelForPurpose()` as the seed layer + the unit/cassette fallback.

2. **DI: a SEPARATE resolver dependency — do NOT touch the cache interface.** Keep `LlmClientCacheLike` as
   `{ forRole }` only (it's re-declared in 5 files; bolting routing onto it would force unrelated test
   shims to grow routing behaviour). Add a distinct `PurposeModelResolverLike = { resolve(purpose):
   Promise<string> }` to each of the 5 call sites alongside `cache`, with a trivial **static-fallback
   resolver** (wraps `modelForPurpose`) as the default for unit/cassette tests.
   `review_activity`/`walkthrough`/`fix_prompt` take it in their `deps` arg (built at/near the roots).
   `curator`/`rerank` are NOT built at the roots — thread the resolver through their **factory chains** or it
   never arrives: `buildStaticAnalysisActivity` → `new AnalysisCurator({...})` (`static_analysis.activity.ts:307`);
   and `buildRetrieveKnowledgeActivity` (`wiring/retrievers.ts:213`) → the `RetrieveKnowledgeActivity` field →
   `buildRerankOverride` → `new LlmBackedRerankPort({...})` (`retrieve_knowledge.activity.ts:89/300`). The dead
   `modelOverride` param can go. All 5 enclosing functions are already `async` (verified), so
   `await resolver.resolve(...)` drops in.

3. **Wire BOTH composition roots.** The 5 consumers are wired in **two** independent roots: the Temporal
   worker `build_activities.ts:477/725` **and** — critically, since this is the de-Temporal worktree — the
   live runner `runner/in_process_ports.ts:133`. Construct the resolver (with its `fromDsn` repo) and inject
   it in **both**, or the runner path silently stays seed-only.

4. **Purpose vocabulary — DECIDED: option (a), and it fixes a latent 500.** The runtime consumes exactly
   four purposes — `review_finding`, `walkthrough`, `analysis_curator` (shared by the curator AND the
   reranker), `fix_prompt`:
   - **Frontend** `LlmJobRoutingCard` `PURPOSES`: reduce 7 → those **4** (add `fix_prompt`; drop
     `review_summary`/`chat_reply`/`redaction_check`/`cost_estimate`, which have no runtime consumer).
   - **Contract bug + fix (READ).** `admin.v1.ts:493` `LlmPurposeModelV1.purpose` is a 7-value enum that
     **omits `fix_prompt`**, but the DB CHECK (`baseline:1702`) and `llm_routing.v1.ts:18`
     (`LLM_PURPOSE_LITERALS`, 8 values) include it. A `fix_prompt` pin therefore makes the admin **GET throw
     500** at `LlmPurposeModelListV1.parse` (`admin_routes.ts:2453`). Widen `LlmPurposeModelV1` (GET) to the
     single-source 8-value `LlmPurposeV1` and delete the stale "7-value parity" comment (488-489) — so GET
     never throws on any DB-valid row (incl. legacy rows from the old 7-purpose UI).
   - **Constrain the WRITE.** Restrict `LlmPurposeAssignmentUpdateV1` (PUT) to a NEW **4-value executable
     subset** (`review_finding`, `walkthrough`, `analysis_curator`, `fix_prompt`) so the API cannot persist
     no-op pins for purposes no runtime consumer reads (`review_summary`/`chat_reply`/`redaction_check`/
     `cost_estimate`). The DELETE `:purpose` param keeps the full 8-value `LlmPurposeV1` so any legacy/no-op
     row can still be cleared. (Asymmetry by design: read + delete accept all DB-valid; write accepts only
     executable.)
   - **Parity note:** widening the admin enum to 8 deliberately diverges from the documented Python parity
     ("faithful drift"). Update the Python contract + the parity test together, or consciously record the
     TS divergence (check `test/contracts/*` for the admin/llm_routing parity snapshots and
     `admin_llm_provider_config_contract.test.ts`).

5. **DELETE/reset route** so "default" persists: `DELETE /api/admin/llm-purpose-routing/:purpose`
   (super_admin; mirror the delete shape at `admin_routes.ts:2380`) → a new `deletePurposeModel(db, purpose)`
   (modelled on `deleteModel`, `llm_catalog_write.ts:26`; does not exist yet). 204 on success, 404 if no
   row. No FK risk (FK is `purpose_model → llm_models`). With the enum widened in (4), validate `:purpose`
   against the 8-value `LlmPurposeV1` (now includes `fix_prompt`).

6. **Frontend default-clear**: `LlmJobRoutingCard.handleAssign`'s "default" branch (`:102`) only mutates
   local state today → call the new DELETE then refresh so it truly clears. Add `deletePurposeRouting(purpose)`
   to `lib/api/llm-models.ts` (none exists), and **regenerate** `src/lib/api/generated/contracts.ts` for the
   DELETE op + the purpose-enum change (regenerate from the backend contract — do not hand-edit).

## Implementation (TDD) + Verification

- **RED — resolver:** unit tests — pin+valid → the pin; pin+disabled / +not-ok / +missing → seed; no pin
  → seed; DB error → seed (fail-open).
- **RED — WIRING, per call site (the part that actually matters):** for EACH of the 5 sites, inject a
  FAKE resolver returning `"custom-model"` + a fake LLM client, and assert `invokeModel` is called with
  `model: "custom-model"`. A resolver-only test passes even if a site is never rewired — only this proves
  each site moved off the static `modelForPurpose()`. For curator + rerank, drive the test through their
  **factory builders** (`buildStaticAnalysisActivity`, `buildRetrieveKnowledgeActivity` / `buildRerankOverride`),
  not the bare class constructor, so a dropped intermediate layer is caught.
- **RED — contract:** a `fix_prompt` pin round-trips through GET **without a 500** (regression for the enum
  bug); a GET over a legacy non-executable row (e.g. `cost_estimate`) also parses; PUT **422s a
  non-executable purpose** (e.g. `cost_estimate`) and a non-validated model; DELETE 204s then 404s and can
  clear a legacy non-executable row.
- **RED — frontend:** the routing card renders exactly the 4 executable purposes; "default" issues the
  DELETE and the row stays cleared after refresh.
- **GREEN:** resolver + its validating repo + the separate resolver DI in **both** roots + DELETE
  route/repo + the contract enum fix + frontend (4-purpose list, default→DELETE, regenerated types).
- Backend battery: `npm run typecheck && npm run lint && npm run gates && vitest` + the integration suite
  on the disposable PG (+ the contract parity test). Frontend: `pnpm lint && pnpm typecheck && pnpm test`.
- **Manual:** assign Code review → a model, run a review, confirm the invocation ledger shows that model;
  pick "default", refresh, confirm it stays default.

## Ordering note

Independent of Part 1, but they compose: Part 1 leaves a fresh deploy with no pins, so the resolver
falls back to the seed (unchanged behavior) until a customer assigns. Sensible build order:
**Part 1 → Part 4 backend → Part 2 + Part 3 frontend** (the frontend "default → DELETE" wiring in Part 4
rides with the Part 2/3 frontend work).

---

# Out of scope (all parts)

- The **code** defaults in `model_router.ts` (`DEFAULT_MODEL`, `PURPOSE_MODEL_SEED`) still name
  specific Claude models; after a customer adds their own models, an unpinned purpose falls back to
  those code strings. Making the fallback data-driven is a separate change (ties into the
  data-driven-pricing follow-up).
- The embedder seed (`qwen3-embed-0.6b`) is kept as a functional default; if the shipped platform
  embedder differs, that is a separate seed review.
