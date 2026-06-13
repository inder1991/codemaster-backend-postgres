-- 0003_auth_secrets — auto-generated session signing key + CSRF secret (go-live review P0).
-- These two HMAC secrets are resolved env > Vault > DB at boot; when neither env nor Vault provides them
-- the app auto-generates them on first boot and persists them HERE (field-codec ciphertext, like every
-- other UI/runtime secret), so the pod boots on only the DB + the field-encryption key — they are NOT
-- operator-provided bootstrap secrets. Platform singleton (scope='platform'); race-safe INSERT across
-- replicas (ON CONFLICT DO NOTHING). Mirrors core.confluence_settings / core.github_app_settings.

CREATE TABLE core.auth_secrets (
    auth_secrets_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope text NOT NULL DEFAULT 'platform',
    session_signing_key_ciphertext text NOT NULL,
    csrf_secret_ciphertext text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_auth_secrets_scope_valid CHECK ((scope = 'platform'::text))
);

-- Singleton: exactly one platform row. The ON CONFLICT target the repo's race-safe ensure() infers.
CREATE UNIQUE INDEX uq_auth_secrets_scope ON core.auth_secrets (scope);
