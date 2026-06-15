-- 0008_embedder_provider_settings — UI-editable embedder credentials + model (DB-backed, field-codec
-- ciphertext). The platform-scope SINGLETON the super-admin sets via the Embedding admin tab: base_url +
-- model_name are non-secret; api_key_ciphertext is encrypted by the boot field key (NOT Vault), so the
-- embedder works with or without Vault. Mirrors core.confluence_settings (the UI-creds template) but is a
-- platform singleton like core.embedder_runtime_state. The resolver reads DB-validated > env > none at
-- use-time, so it never blocks boot.
--
-- provider is SERVER-OWNED (the PUT never sends it) — only 'openai_compat' rows are representable today.
-- api_key is TRI-STATE: both ciphertext+fingerprint set (keyed) or both NULL (keyless, e.g. a sidecar
-- embedder that needs no Authorization header). updated_at is bumped on EVERY field write and is the
-- compare-and-swap revision token the /test promotion guards on (a concurrent PUT mid-/test → 409, so a
-- validated config can never be silently replaced by an unvalidated one). last_rotated_at is reserved for
-- KEY rotation only. last_rotated_by stores the admin's audit email (see plan §9) — an actor trail, not a
-- secret, consistent with core.platform_credentials_meta.last_rotated_by.

CREATE TABLE core.embedder_provider_settings (
    singleton              boolean                  DEFAULT true NOT NULL,
    provider               text                     DEFAULT 'openai_compat'::text NOT NULL,
    base_url               text                     NOT NULL,
    model_name             text                     NOT NULL,
    api_key_ciphertext     text,
    api_key_fingerprint    text,
    enabled                boolean                  DEFAULT true NOT NULL,
    last_validated_at      timestamp with time zone,
    last_validation_status text,
    last_validation_error  text,
    last_rotated_at        timestamp with time zone DEFAULT now() NOT NULL,
    last_rotated_by        text,
    updated_at             timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT eps_only_one_row     CHECK ((singleton = true)),
    CONSTRAINT eps_provider_valid   CHECK ((provider = 'openai_compat'::text)),
    CONSTRAINT eps_base_url_len     CHECK ((length(base_url) BETWEEN 1 AND 2048)),
    CONSTRAINT eps_model_name_len   CHECK ((length(model_name) BETWEEN 1 AND 256)),
    CONSTRAINT eps_key_pair         CHECK (((api_key_ciphertext IS NULL) = (api_key_fingerprint IS NULL))),
    CONSTRAINT eps_fingerprint_4    CHECK ((api_key_fingerprint IS NULL OR length(api_key_fingerprint) = 4)),
    CONSTRAINT eps_validation_state CHECK ((last_validation_status IS NULL OR last_validation_status = ANY (ARRAY['ok'::text, 'failed'::text])))
);

-- One row, ever — the boolean singleton makes the platform settings a singleton (matches the
-- embedder_runtime_state / confluence_settings idiom).
CREATE UNIQUE INDEX eps_singleton_uq ON core.embedder_provider_settings (singleton);
