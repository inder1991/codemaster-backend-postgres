-- 0003_llm_invocation_ledger
--
-- NARROW LLM-invocation idempotency ledger (TS hardening divergence — ADR-0068).
--
-- TS hardening divergence (ADR-0068) — the frozen Python has NO invocation ledger: a post-call
-- persistence failure + a Temporal activity retry buys a SECOND paid Bedrock completion (the SDK call
-- is the only non-repeatable, paid edge and Python repeats it on every retry). This table is the
-- smallest durable record that makes the paid provider call idempotent: a stable idempotency_key
-- (sha256 of review_id + chunk_id + role + model + prompt hash + tool-schema version) maps to the raw
-- provider response, so a retry REPLAYS the stored response instead of re-invoking Bedrock.
--
-- This is INTENTIONALLY NOT a generic outbox — it is the smallest LLM-invocation ledger that prevents
-- duplicate paid calls (owner decision: "Do NOT build a broad generic outbox yet").
--
-- Tenancy: installation_id is NOT NULL and the table is registered in TENANT_SCOPED_TABLES
-- (libs/platform/src/db/tenant_scoped_tables.ts). The lookup filters on BOTH idempotency_key (the PK)
-- AND installation_id (defense-in-depth tenant isolation), so every query carries the installation_id
-- token the raw-SQL tenancy gate requires.
--
-- node-pg-migrate runs this whole .sql file as the "up" migration (the project's migrations are up-only
-- by design; the squashed baseline is irreversible — see package.json migrate:down). Run ONLY against a
-- disposable Postgres, NEVER an in-cluster DB.

CREATE TABLE IF NOT EXISTS core.llm_invocation_ledger (
    -- Stable content-addressable idempotency key (sha256 hex of the deterministic activity inputs).
    idempotency_key     text        PRIMARY KEY,
    -- Tenant scope — NOT NULL so spend / replay are always attributable to an installation.
    installation_id     uuid        NOT NULL,
    -- The deterministic-input projection the key was derived from (recorded for forensics / audit).
    review_id           uuid,
    chunk_id            uuid,
    role                text,
    model               text,
    prompt_sha256       text,
    tool_schema_version text,
    -- The raw provider response, replayed verbatim on a retry (the paid completion, stored once).
    provider_response   jsonb       NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- Tenant-scoped lookups by installation (operator inspection / per-tenant cleanup).
CREATE INDEX IF NOT EXISTS llm_invocation_ledger_installation_id_idx
    ON core.llm_invocation_ledger (installation_id);
