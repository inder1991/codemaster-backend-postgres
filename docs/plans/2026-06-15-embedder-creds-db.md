# Plan: Embedder credentials + model → DB + field-codec (parity with LLM / GitHub / Confluence)

- **Status:** REVISED **r7** (2026-06-15) — folds in review rounds 1–7. r6's organizing principle stands: **one `EffectiveEmbedderConfig` value** ({baseUrl, apiKey, modelName, provider, source}) drives the HTTP request, provenance, generation metadata, and config-status; **promoted only after `/test` succeeds, atomically (one transaction)**. **r7 adds the concurrency model the earlier rounds lacked:** an `updated_at` revision token + compare-and-swap + row lock so a concurrent PUT can't make `/test` validate one config and promote another; greenfield gating only when the embedding *contract* actually changes; and the exact promotion/generation-update repo methods (not just "one transaction"). Migration **0008**; `EMBEDDING_DIM` configurable. **P-1 prerequisite; P-2 follow-up.** Decisions need sign-off (§8).
- **Date:** 2026-06-15
- **Branch (proposed):** `feat/embedder-creds-db` off `feat/deploy-contract-preflight` (§8.7)
- **Author:** indersingh + Claude

---

## 0. Review resolutions

**R1–5** (settled): DB+field-codec creds (github/confluence template); sync lazy factory + 5-consumer rewire; key tri-state + keyless; `validateExternalUrl`+`allowPrivateResolvedIps` (http/private universal); real `/test` probe (P-1); `model_name` column; resolver fail-closed-on-error + cold-start; non-secret digest; schema CHECKs (half-key/length); migration 0008; `/test` asserts `EMBEDDING_DIM`.

**Round 6 — model-consistency + atomicity (the core remaining gap):**

| # | Finding (verified) | Resolution |
|---|---|---|
| **6-1** | r5 synced provenance on the model *write*, before `/test` — an **unvalidated** model could become runtime provenance. | **Promote only on `/test` success.** A `model_name`/creds write just stages the row + nulls validation. The runtime model/provenance is updated only when `/test`='ok'. |
| **6-2** | "one model name" still had 4 sources (DB `model_name`, `active_model_name`, generation `model_name`, env). Activities used `getActiveModelName()`; the request used the resolver. | **One `EffectiveEmbedderConfig` = `{baseUrl, apiKey, modelName, provider, source}`** from the resolver. The **same `modelName`** drives the HTTP adapter AND all activity/provenance metadata (via an injected `EffectiveEmbedderConfigReader`, 6-6). |
| **6-3** | `embedding_generations.provider_name` defaults to **`"qwen"`** (`embedding_generations_repo.ts:162`); r5 synced only model names. | On `/test` success, also set the active generation's `provider_name='openai_compat'` (within the promotion transaction). |
| **6-4** | "Reject if corpus non-empty" didn't say which tables. | Explicit **`assertEmbedderGreenfield()`**: empty `core.knowledge_chunks`, `core.confluence_chunks`, `core.chunk_embeddings`, `cache.cache_embeddings` AND no pending/backfilling generation (reuses the `set-embedding-dimension` baseline guard). Per-table tests. |
| **6-5** | Settings/runtime-state/generation/validation/config-version were updated across phases → half-updated config observable. | **One transaction** on `/test` success: persist validation='ok' + the provider settings + runtime-state model + active generation metadata (model/provider) + `config_version` bump, coherently. |
| 6-6 | `getActiveModelName()` lives on `PostgresEmbedderCache` (async-started); some activity sites have no cache. | Inject an **`EffectiveEmbedderConfigReader`** (or have the resolving adapter expose the effective model) — not `getActiveModelName()` directly. |
| 6-7 | P-1 probe is Phase 0 but keyless header-omit is Phase 5 — a Phase-0 probe on the current adapter can't do keyless. | **Move the nullable-apiKey adapter change into Phase 0** (with P-1), so the probe supports keyless from the start. |
| 6-8 | Resolver returns `null`, but consumers expect an `EmbeddingsPort.embed()`. | On `null`, the `ResolvingEmbeddingsAdapter.embed()` throws a **new typed `EmbedderDisabledError`** (sibling of `EmbeddingsConnectivityError`); test each caller's handling. |
| 6-9 | config-status is an **unversioned raw** shape (`admin_routes.ts:474`); type at `deploy_preflight.ts:629`. | Introduce/extend a **Zod `ConfigStatusV1`** response contract; update backend type + frontend + tests. |
| 6-10 | `invalid` state has no detail (operator sees "invalid", not why). | Add optional `detail` (from `last_validation_error`) to the item, or link to `GET /embedder-config`. |
| 6-11 | `provider` server-owned but schema has no default while PUT omits it. | Schema `provider ... DEFAULT 'openai_compat'`; test a direct repo insert. |
| 6-12 | Digest uses `api_key_ciphertext` (nonce-based → changes on re-save). | **Document rebuild-on-resave as intentional;** include `enabled` + validation in the resolver cache key / invalidation. |
| 6-13 | `last_rotated_by` format unresolved. | **Decision: store the resolved actor EMAIL** (P-2), or the shim email when unresolved; contract/docs say so. |
| 6-14 | Phase 6c cleanup too broad. | **Enumerate:** `platform_credentials_write.ts`, `platform_credentials_probe.ts`, the admin-route `PLATFORM_CRED_ROUTES` loop, `admin.v1.ts` platform-cred contracts (if any), the `embedder.qwen` integration tests, the frontend API client + cassettes. |

**Round 7 — concurrency, exact promotion mechanics, contract completeness (all 12 verified against code):**

| # | Sev | Finding (verified anchor) | Resolution |
|---|-----|---------------------------|------------|
| **7-1** | High | `/test` validates a row, then promotes — a concurrent PUT could change `base_url`/`model_name`/`key` between probe and promote, validating old + promoting new. | **CAS on a revision token.** Capture `updated_at` BEFORE the probe; promote in a tx whose singleton `UPDATE … WHERE singleton AND updated_at = <captured>` must affect exactly 1 row, else **409 `embedder_config_changed_during_validation`** (re-test). See D9. |
| **7-9** | Med | No row lock during `/test` → two admins racing two `/test`s can promote the wrong final config. | Same tx does `SELECT … FOR UPDATE` on the singleton before the CAS check, serializing concurrent promotes. (Belt-and-suspenders with 7-1's WHERE guard.) |
| **7-10** | Med | Schema has only `last_rotated_at` (key-rotation semantics); base_url/model/provider/enabled/validation change independently. | Add **`updated_at timestamptz DEFAULT now() NOT NULL`**, bumped on EVERY field write/enable-toggle; it is the 7-1 revision token. `last_rotated_at` reserved for **key** changes only. |
| **7-2** | High | r6 ran `assertEmbedderGreenfield()` on every `/test` success — would block a harmless **re-test of the already-active config** on a live corpus. | Gate it on **contract change only**: compute whether staged `{model_name, provider, dimension}` differs from the active generation's `{model_name, provider_name, embedding_dimension}`. Unchanged → skip the guard (re-validation always allowed). Changed → require greenfield, else 409. |
| **7-3** | High | "one transaction" didn't match `bumpEmbedderConfigVersion` (standalone helper, `platform_credentials_repo.ts:76`). | Name the method: **`promoteValidatedEmbedderConfig(db, {...})`** runs ONE `db.transaction()`; thread the `trx` into `bumpEmbedderConfigVersion(trx, email)` (it already accepts a `db`); **assert every singleton UPDATE affected exactly 1 row.** |
| **7-4** | High | Generation update underspecified; `insertNew` defaults `provider_name='qwen'` (`embedding_generations_repo.ts:162`) and **no UPDATE-provenance method exists**. | Add **`updateActiveProvenance(tx, {generationId, modelName, provider, expectedDimension})`**: `UPDATE core.embedding_generations SET model_name, provider_name WHERE generation_id = <runtime active_generation> AND embedding_dimension = <dim>`; assert rowCount=1 (dimension mismatch refuses to update). |
| **7-5** | High | Reader could re-resolve config separately from the adapter → TTL refresh / version bump mid-activity = recorded model ≠ requested model. | **Resolve once per unit of work; pass the SAME `EffectiveEmbedderConfig` object to both the adapter call and the provenance write.** The adapter `embed()` returns the effective `{modelName, provider}` it used; provenance reads THAT, never a second resolve. |
| **7-6** | Med | `source: 'db'\|'env'` but promotion/generation-sync are DB-only — env provenance ambiguous. | **Decision: env is bootstrap/cold-start ONLY.** Env config drives requests but **never** triggers promotion or generation-provenance sync. To record provenance you must save + `/test` via DB. Config-status shows `source:'env'`; provenance stays whatever a prior DB promotion set. |
| **7-7** | Med | r6 `ConfigStatusV1` dropped the existing **`disabled`** state (`deploy_preflight.ts:634`). | `ConfigStatusV1.state = 'configured' \| 'disabled' \| 'pending' \| 'invalid'`. `disabled` = saved but `enabled=false`. Keep it. |
| **7-8** | Med | `EmbedderDisabledError` had no caller policy; `EmbeddingsConnectivityError` DOES (lexical-only / skip semantic merge, `embeddings_port.ts:111`). | **Per-caller policy:** retrieval/query path → **fail-soft** (catch → lexical-only, same as connectivity); the 5 ingest sites → **fail-closed** (do NOT write zero/garbage vectors; the activity reports degraded/blocked, no silent empty embeddings). `/test` is the config path, unaffected. |
| **7-11** | Low | Private-IP opt-in (`allowPrivateResolvedIps`) must not weaken the global default (`url_validator.ts:269` denies private by default). | Phase-test requirement: `validateExternalUrl` with NO opt-in still throws `PrivateCidrError` on a private resolve; ONLY the embedder-admin path passes `allowPrivateResolvedIps:true`. Regression test both. |
| **7-12** | Low | `last_rotated_by` stores plaintext email; codebase handles user email carefully elsewhere. | **Callout (§9):** it's an admin-action **audit actor** (not a secret), super_admin-visible only, intentionally un-encrypted; documented so it isn't mistaken for PII-in-the-clear. |

---

## 1. Problem (verified)

The Embedding UI is broken: the Vault write route is `503` (`admin_routes.ts:2106`, Vault read-only via SA), the read path is env-only (`resolve_embeddings.ts:45-86`), and there's no UI model write path. The writable home is Postgres + the field codec.

## 2. Goal

UI: **select model**, set `base_url` + token (keyless ok) → encrypted in `core.embedder_provider_settings`; run `/test`; on success the embedder embeds with that model, recorded as provenance. Zero Vault/env. Model + dimension are set **before ingest**; changing either on a live corpus = re-embed.

## 3. The `EffectiveEmbedderConfig` (the spine — 6-2/6-6)

```
type EffectiveEmbedderConfig = { baseUrl: string; apiKey: string | null; modelName: string;
                                 provider: 'openai_compat'; source: 'db' | 'env' };
```
- The **resolver** produces it (DB-validated > env > none). `null`/disabled → no config.
- The **`ResolvingEmbeddingsAdapter`** builds `OpenAICompatibleEmbeddingsAdapter({ baseUrl, apiKey, modelName })` from it (rebuild on the non-secret digest, 6-12).
- An **`EffectiveEmbedderConfigReader`** exposes the same `{ modelName, provider }` to the embed activities + the dual-write — replacing the **5 hardcoded `"qwen3-embed-0.6b"`** (`build_activities.ts:723/842/888`, `event_handlers.ts:214`, `_confluence_page_sync.ts:36`) and `getActiveModelName()` use. **Request, provenance, and generation metadata all read this one value.**
- **Resolve ONCE per unit of work (7-5):** within a single embed activity the config is resolved exactly once; the SAME object feeds the adapter call and the provenance write. The adapter's `embed()` **returns** the effective `{modelName, provider}` it actually used, and provenance is recorded from THAT return — never a second independent resolve (a mid-activity TTL refresh / `config_version` bump must not desync requested model vs recorded model).

## 3.5 PREREQUISITES
- **P-1 (REQUIRED):** the `/test` embed-probe (built on the **keyless-capable** adapter, 6-7) wired at `registerAdminRoutes` as `getEmbedderProbe`; asserts result length == `EMBEDDING_DIM`.
- **P-2 (follow-up/shim):** the actor-email resolver, else shim email.

## 4. Design decisions

| # | Decision | Recommendation | Status |
|---|---|---|---|
| D1 | Singleton `core.embedder_provider_settings`. | | PROPOSED |
| D2 | **Effective model + promote-on-validate + greenfield (6-1/2/3/4, 7-2)** | `model_name` is staged on write (nulls validation); on `/test` success the EFFECTIVE config (model+provider) is promoted to `active_model_name` + the active generation (`model_name`,`provider_name='openai_compat'`). `assertEmbedderGreenfield()` is required **only when the embedding contract changes** (staged `{model,provider,dim}` ≠ active generation's) — a re-test of the unchanged active config is always allowed (7-2). **Env source never promotes (7-6).** | **SIGN-OFF** |
| D9 | **Concurrency: revision token + CAS + row lock (7-1/9/10)** | `updated_at` bumped on every field write is the token. `/test` captures it pre-probe; `promoteValidatedEmbedderConfig` (7-3) does `SELECT … FOR UPDATE` then `UPDATE … WHERE singleton AND updated_at=<token>` (rowCount must be 1, else **409 `embedder_config_changed_during_validation`**). | **SIGN-OFF** |
| D2-val | Validation-gating + fail-closed (error + **cold start**) + reset-scope | DB creds only when `enabled`+`validation='ok'`; base_url/model/key change → reset validation; enabled toggle keeps it. DB error / cold start with no cached safe state → **fail-closed (`null`)**. | **SIGN-OFF** |
| D3 | DB row `openai_compat` only; `provider` server-owned + `DEFAULT 'openai_compat'` (6-11). | | PROPOSED |
| D4 | Build `ResolvingEmbeddingsAdapter`; rebuild on a **non-secret digest** of `{base_url,model_name,api_key_ciphertext,last_rotated_at,enabled,validation}` (6-12); `embed()` on no-config throws **`EmbedderDisabledError`** (6-8). **Caller policy (7-8):** retrieval/query → fail-soft (catch → lexical-only, like connectivity); the 5 ingest sites → fail-closed (no zero/garbage vectors; report degraded). | | **SIGN-OFF (core)** |
| D5 | Remove embedder from the Vault route + **enumerated cleanup** (6-14). | | PROPOSED |
| D6 | `/test` guards `EMBEDDING_DIM`. | | PROPOSED |
| D7 | Tri-state key; keyless → no `Authorization` header (adapter, Phase 0). | | PROPOSED |
| D8 | `validateExternalUrl` + http/private universal (operator infra). | | OWNER-DECIDED |
| D2-prov | `last_rotated_by` = resolved EMAIL or shim (6-13). | | PROPOSED |

## 5. Schema (Phase 1) — `migrations/0008_embedder_provider_settings.sql`

```sql
CREATE TABLE core.embedder_provider_settings (
  singleton              boolean      DEFAULT true NOT NULL,
  provider               text         DEFAULT 'openai_compat' NOT NULL,   -- server-owned (6-11)
  base_url               text         NOT NULL,
  model_name             text         NOT NULL,
  api_key_ciphertext     text,
  api_key_fingerprint    text,
  enabled                boolean      DEFAULT true NOT NULL,
  last_validated_at      timestamptz,
  last_validation_status text,
  last_validation_error  text,
  last_rotated_at        timestamptz  DEFAULT now() NOT NULL,             -- KEY rotation only (7-10)
  last_rotated_by        text,                                            -- audit actor email/shim (6-13, callout §9)
  updated_at             timestamptz  DEFAULT now() NOT NULL,             -- bumped on ANY field write; CAS token (7-1/10)
  CONSTRAINT eps_only_one_row     CHECK (singleton = true),
  CONSTRAINT eps_provider_valid   CHECK (provider = 'openai_compat'::text),
  CONSTRAINT eps_base_url_len     CHECK (length(base_url) BETWEEN 1 AND 2048),
  CONSTRAINT eps_model_name_len   CHECK (length(model_name) BETWEEN 1 AND 256),
  CONSTRAINT eps_key_pair         CHECK ((api_key_ciphertext IS NULL) = (api_key_fingerprint IS NULL)),
  CONSTRAINT eps_fingerprint_4    CHECK (api_key_fingerprint IS NULL OR length(api_key_fingerprint) = 4),
  CONSTRAINT eps_validation_state CHECK (last_validation_status IS NULL OR last_validation_status IN ('ok','failed'))
);
CREATE UNIQUE INDEX eps_singleton_uq ON core.embedder_provider_settings (singleton);
```
No seed row. **Append `"0008_embedder_provider_settings"` to `EXPECTED_MIGRATIONS`.**

## 6. Work — TDD phases

### Phase 0 — Prerequisites + keyless adapter (6-7)
- Adapter: nullable `apiKey`, omit `Authorization` when keyless. P-1 probe (on that adapter) + wiring. P-2 resolver/shim. **Test:** keyless → no header; probe ok / wrong-dim failed / unwired 503.
### Phase 1 — Migration `0008` + `EXPECTED_MIGRATIONS`. Test: all CHECKs; default provider; default `updated_at`; singleton.
### Phase 2 — Contract. GET (no key) incl. `model_name`, `provider`(const), validation+`detail`(6-10), `updated_at`; PUT `{base_url, model_name, api_key?, enabled}` (no provider). Zod **`ConfigStatusV1`** with `state ∈ {configured, disabled, pending, invalid}` (6-9/**7-7** — keep `disabled`).
### Phase 3 — Repo (github/confluence). 3-state read (NULL-guarded keyless); `writeSecret()` (base_url/model/key → null validation + bump `updated_at`, STAGES only); `updateEnabled()` (bumps `updated_at`). URL via `validateExternalUrl` with the embedder-admin opt-in `allowPrivateResolvedIps:true`. Test: staging never promotes; keyless round-trips; **private-IP regression (7-11): default `validateExternalUrl` (no opt-in) still throws `PrivateCidrError`; only the embedder path opts in.**
### Phase 4 — Resolver → `EffectiveEmbedderConfig` (6-2) + cache. Cold-start/DB-error fail-closed; cache invalidation on the digest (6-12). Test: failed/cold→null; cached-absent→env; effective config shape.
### Phase 5 — `ResolvingEmbeddingsAdapter` + 5-consumer rewire. Rebuild on digest; **resolve once + `embed()` returns the effective `{modelName, provider}` used (7-5)**; on no-config → `EmbedderDisabledError` (6-8). `resolveEmbeddingsConsumer(deps?)` threaded at the 4 sites + boot singleton. **Caller policy (7-8):** retrieval/query catches it → lexical-only (mirror `EmbeddingsConnectivityError`); the ingest sites fail-closed (report degraded, never write zero/garbage vectors). Test: model change rebuilds request; provenance reads the adapter's returned model (not a re-resolve); retrieval path degrades to lexical; an ingest path fails-closed (no embeddings written).
### Phase 5b — `EffectiveEmbedderConfigReader` (6-2/6-6). Replace the 5 hardcoded model constants + the dual-write source with the reader. **Provenance is recorded from the value the adapter `embed()` returned for that same call (7-5), not an independent re-read.** Test: after promotion, activities + `chunk_embeddings.embedding_model_name` carry the NEW model; a `config_version` bump mid-batch does not split requested vs recorded model within a unit of work.
### Phase 6 — Admin. `GET/PUT /api/admin/embedder-config`; **`POST /api/admin/embedder-config/test`** (6-9 name). PUT stages fields + bumps `updated_at` + nulls validation. **`/test` flow (6-5/7-1/2/3/4/9):**
1. Read the row; **capture `updated_at` as the CAS token**; run the keyless-capable probe (P-1) against that row's config; assert result length == `EMBEDDING_DIM`.
2. Compute **contract-change** = staged `{model_name, provider, dim}` ≠ active generation's `{model_name, provider_name, embedding_dimension}`. If changed, require **`assertEmbedderGreenfield()`** (6-4) else **409**; if unchanged, skip the guard (re-test allowed, 7-2).
3. **`promoteValidatedEmbedderConfig(db, {token, model, provider, validatedAt, actorEmail})`** — ONE `db.transaction()`: `SELECT … FOR UPDATE` singleton (7-9) → `UPDATE settings SET last_validation_status='ok', last_validated_at WHERE singleton AND updated_at=<token>` (rowCount=1 else **409 `embedder_config_changed_during_validation`**, 7-1) → set `active_model_name` → **`updateActiveProvenance(trx, {generationId: active_generation, modelName, provider:'openai_compat', expectedDimension})`** (rowCount=1, 7-4) → `bumpEmbedderConfigVersion(trx, actorEmail)` (7-3). **Env source never reaches here (7-6).**

Remove Vault route (D5). Test: promote-only-on-test; **concurrent PUT during /test → 409, no promote**; re-test of unchanged config on a live corpus → OK (no greenfield); contract change on non-empty corpus → 409; generation provenance dim-mismatch → refuse; atomic (no half-state observable).
### Phase 6b — config-status (6-2/6-9/6-10/7-7). `ConfigStatusV1` PUSH `embedder.provider`: `configured`+`source:'db'|'env'` / `disabled` (enabled=false) / `invalid`+`detail` / `pending`. Extend the existing `{configured,disabled,pending}` with `invalid` (keep `disabled`).
### Phase 6c — Cleanup (6-14). The enumerated files.
### Phase 7 — Composition wiring. Repo + probe + email resolver + the `EffectiveEmbedderConfigReader`. Test: boot resolves DB creds, no env.
### Phase 8 — Frontend. `EmbedderConfigCard` (model dropdown writes `model_name`, base_url, keyless toggle, validation/`detail` display); remove `embedder.qwen` client+cassettes.
### Phase 9 — Verify on kind (greenfield, before ingest). Configure Ollama; `/test` → activates; confirm the selected model is sent AND recorded in `embedding_model_name`; ingest.

## 7. Out of scope
- Confluence-off-Vault. Changing model OR dimension on a live corpus (= day-2 re-embed).

## 8. Open decisions (sign-off before Phase 0)
1. **D2 (6-1/2/3/4)** — effective model; promote only on `/test`; reject model change on non-empty corpus.
2. **D2-val (cold-start/reset)** + **one promotion transaction (6-5)**.
3. **P-1** (required) + **P-2** (resolver or shim email, 6-13).
4. **D4 (6-8)** — `ResolvingEmbeddingsAdapter` + `EmbedderDisabledError` + digest cache.
5. **D5 (6-14) / D3 (6-11)** — Vault cleanup; `provider` server-owned+default.
6. **D7/D8** — keyless header omit; http/private universal.
7. **D9 (7-1/9/10)** — `updated_at` CAS token + row lock + 409-on-change concurrency model.
8. **Branch.**

## 9. Audit / privacy callout (7-12)
`last_rotated_by` stores the admin's plaintext **email as an audit actor**, not a secret: it records *who* changed embedder infra. It is intentionally un-encrypted (audit trails must be human-readable), super_admin-visible only, and never returned on the public GET. This is called out explicitly because the codebase otherwise handles user email carefully — this column is a deliberate, scoped exception, consistent with `core.platform_credentials_meta.last_rotated_by` (same pattern, `platform_credentials_repo.ts:9`).

No code written yet. On §8 sign-off, I start Phase 0.
