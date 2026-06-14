# Plan — Allow operators to add / test / use any LLM model

**Date:** 2026-06-14 · **Branch:** feat/deploy-contract-preflight
**Owner decision:** Customer enters ANY model → **Test** (verify against the provider) → **use** it.
Don't block on cost now (data-driven pricing = tracked follow-up). The live preflight ping replaces the
ADR-0060 static allow-list as the gate.

> **Revision 4** — after three adversarial review rounds. R2 added gates 3-6 (provider-config regex, the
> `BedrockModel` type, the duplicate constant, stale docs). R3 added the **global `model_id` uniqueness**
> edge (a 500 risk), full-path **route tests** for the region-prefixed shape, **split the frontend** (it's a
> separate repo), justified the **dead `bedrock_settings` CHECK**, and switched the warn to key off
> **missing pricing** (so the constant is *deleted*, not renamed). R4 hardened the 409 against a TOCTOU race
> (pre-check **+** `23505` catch), widened the warn to **both** price maps, and folded the rerank comment into gate 6.

---

## Problem

Models are gated by a hardcoded set duplicated in two constants — `client.ts:116` (array; also under the
cost maps) and `llm_catalog_write.ts:7` (Set; used by the upsert route). Both are stale (no Opus 4.8) and
wrong for Bedrock (bare names; real IDs are region-prefixed inference profiles, `us.anthropic.…`). The
engine already verifies a model live (`preflight_validator_real.ts`), so the static list is redundant.

## Complete gate inventory (backend — all in this worktree)

| # | Gate | Location | Change |
|---|---|---|---|
| 1 | Upsert allow-list | `admin_routes.ts:2335` (`!BEDROCK_MODELS.has` → 422) | **Remove.** |
| 1b **(High)** | Cross-provider `model_id` collision | upsert route × `uq_llm_models_model_id UNIQUE(model_id)` (`migrations:5336`); `upsertModel` only does `ON CONFLICT (provider, model_id)` (`llm_catalog_write.ts:28`) | **Keep** global uniqueness (purpose-routing FKs `model_id`, `migrations:8436`). A pre-check alone **races** (two concurrent adds both pass it, one then hits the constraint → 500), so do **both**: pre-check for a clean message **and** catch SQLSTATE **`23505`** around `upsertModel` → re-read the existing provider → **409** "model_id already registered under provider X". Test the cross-provider case. |
| 2 | Invoke runtime throw | `client.ts:516` | Replace with `warnUnpricedModelOnce(model)` + proceed — key it off **missing pricing in either map** (`!USD_CENTS_PER_PROMPT_TOKEN.has(model) \|\| !USD_CENTS_PER_COMPLETION_TOKEN.has(model)`, so map drift stays visible), NOT list membership. Module-level `Set` dedup, unit-tested. |
| 3 | Invoke compile-time type | `client.ts:435` (`model: BedrockModel \| null`) | → `string \| null`; **delete** the `BedrockModel` type (`client.ts:121`); audit other `BedrockModel` sites. |
| 4 **(High)** | Provider-config body regex | `admin.v1.ts:575` (+ legacy shim `:677`); anthropic_direct `:582` | **Drop** the `model_id` name-prefix refinements (keep `min/max` + "region required for bedrock" `:572`). Region-prefixed Bedrock IDs now pass. |
| 5 | Allow-list constants | `client.ts:116` array + `llm_catalog_write.ts:7` Set (+ import `admin_routes.ts:178`) | **Delete both.** The cost maps (`USD_CENTS_PER_*`) remain as the de-facto priced set; no rename. |
| 6 | Stale docs/tests | `admin.v1.ts:468`, `llm_catalog_write.ts:5` **+ `:60`** (rerank "analogue of BEDROCK_MODELS" comment), test `admin_llm_models_write…:6` | Update to "any model; preflight is the gate". |
| — | Cost | `client.ts:137` | No change — `…?? 0` → 1-cent floor. `FOLLOW-UP` for metric + pricing. |

## Backend implementation (TDD)

1. **Contract (gate 4)** — RED: `LlmProviderConfigUpdateV1` + `LegacyBedrockConfigUpdateBodyV1` parse tests
   for `model_id:"us.anthropic.claude-…"` pass. GREEN: drop the prefix `superRefine`s / `.regex`.
2. **Route integration (gate 4, full path)** — RED→GREEN: in `admin_llm_config.integration.test.ts`
   (currently uses `anthropic.claude-sonnet-4-6` at `:133`,`:425`), add cases proving `us.anthropic.…`
   survives **parse → preflight → DB write (`llm_provider_settings`) → 200 response** for both
   `/api/admin/llm-provider-config` and legacy `/api/admin/bedrock-config`.
3. **Upsert (gates 1, 1b)** — RED: off-list `model_id` → 200 + persisted; **same `model_id`, different
   provider → 409** (not 500), **and a concurrent-add race** still yields 409 (not 500). GREEN: delete
   `:2335`; add the 409 pre-check **+ a `23505` catch around `upsertModel`** (re-read provider for the body);
   delete the `llm_catalog_write` Set + its import.
4. **Invoke (gates 2, 3, 5)** — RED: client unit test — off-list model invokes (no throw) and
   `warnUnpricedModelOnce` fires exactly once for an unpriced model. GREEN: `string | null`, the warn
   helper, delete both constants + the `BedrockModel` type.
5. **Docs (gate 6)** — update the three stale strings.
6. **Battery** — typecheck · lint · `npm run gates` · affected unit + integration tests · `grep -r
   "BEDROCK_MODELS\|BedrockModel"` returns nothing in gate paths.

**Files:** `libs/contracts/src/admin.v1.ts`, `api/admin/admin_routes.ts`, `api/admin/llm_catalog_write.ts`,
`integrations/llm/client.ts`, + the integration/client tests. **No migration** (see below).

## Frontend — SEPARATE repo (codemaster-frontend), EXTERNAL verification required

Not in this worktree; this plan's "done" does **not** include it. Separate task: check the model_id
client-side validation / generated contract (`src/lib/api/llm-models.ts`, `…/generated/contracts.ts`) — if
the prefix regex is mirrored, relax it so the UI accepts `us.anthropic.…`; verify add/test/use in the UI.

## Why no migration (legacy CHECK is intentionally ignored)

`core.bedrock_settings` has a `model_id` CHECK that rejects `us.anthropic.…` (`migrations:~853`), but it's a
**dead path** — active credential writes go to `core.llm_provider_settings`
(`llm_provider_settings_repo.ts:281`), which has **no `model_id` shape constraint**. So the region-prefixed
shape is already storable; the old CHECK never executes on this path. No schema change needed.

## Verification (live deploy)

1. Add `claude-opus-4-8` (Anthropic Direct) → 200, no "accepted set" error.
2. Add `us.anthropic.claude-…` (Bedrock + region) → 200 (provider-config save accepts it).
3. Add an existing `model_id` under a 2nd provider → **409** (clean), not 500.
4. **Test** each → preflight `{ok:true}`. Use in a review → invokes (one warn, 1-cent cost floor).

## Out of scope (tracked separately)

- **DELETE → 400 (issue 3):** backend returns clean `404/409/204`; the 400 is frontend/proxy-layer
  (`frontend/src/lib/api/llm-models.ts:305`). Own root-cause; not here.
- **Data-driven pricing:** capture $/token at add-time into `core.llm_models`; cost engine reads DB; delete
  the cost maps. Removes the under-count this plan accepts. Deferred per owner.
