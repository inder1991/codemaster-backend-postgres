-- 0048_rerank_settings.sql — W1.3 [RH9] (master-hardening-plan): the OPTIONAL Bedrock re-ranker's
-- admin-facing config row. A platform-scope SINGLETON (scope PK + CHECK pins exactly one row, the
-- same platform-scope posture as core.llm_provider_settings' scope='platform' rows) holding the
-- NON-SECRET rerank knobs the admin UI writes via PUT /api/admin/rerank-config:
--
--   enabled  — DEFAULT OFF. With no row (or enabled=false) retrieval runs the IdentityRerankPort
--              pass-through, byte-identical to pre-RH9 behavior.
--   model_id — the Bedrock RERANK-API model (cohere.rerank-v3-5:0 | amazon.rerank-v1:0); membership
--              is enforced at the route (RERANK_MODELS) — the column stays free-text so a future
--              model rollout is a code change, not a migration.
--   region   — optional AWS region override; NULL → the platform Bedrock credential row's region.
--   top_n    — how many leading pre-rerank candidates are submitted for re-scoring (cost/latency
--              bound). CHECK mirrors the Zod range; defence-in-depth under the route validation.
--
-- NO credential columns: the rerank call reuses the platform Bedrock bearer token from
-- core.llm_provider_settings (read_decrypted_for_provider('bedrock')), so nothing here needs Vault.
--
-- Plain CREATE TABLE on a brand-new relation: no rewrite, no lock risk, no cold-only ceremony.
CREATE TABLE core.rerank_settings (
  scope               text        NOT NULL PRIMARY KEY DEFAULT 'platform' CHECK (scope = 'platform'),
  enabled             boolean     NOT NULL DEFAULT false,
  model_id            text        NOT NULL,
  region              text        NULL,
  top_n               integer     NOT NULL DEFAULT 25 CHECK (top_n BETWEEN 1 AND 100),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  uuid        NOT NULL
);
