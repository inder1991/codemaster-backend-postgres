-- 0002_confluence_settings — UI-editable Confluence credentials (go-live Step 4c). The platform-scope
-- singleton the admin sets via the UI; the token column is field-codec ciphertext (encrypted by the boot
-- field key, NOT Vault Transit — works with or without Vault). base_url + auth_email are non-secret. The
-- token provider resolves DB > env > Vault > disabled at use-time, so it never blocks boot. Mirrors
-- core.github_app_settings (go-live Step 4b). FIRST incremental migration after the fused 0001_baseline.

CREATE TABLE core.confluence_settings (
    confluence_settings_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id uuid,
    base_url text NOT NULL,
    -- Atlassian Cloud account email → selects HTTP-Basic auth downstream; NULL for Bearer-PAT (Server/DC).
    auth_email text,
    token_ciphertext text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_rotated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_rotated_by_user_id uuid NOT NULL,
    scope text NOT NULL,
    CONSTRAINT ck_confluence_settings_scope_installation_consistency CHECK (
        (((scope = 'platform'::text) AND (installation_id IS NULL))
         OR ((scope = 'installation'::text) AND (installation_id IS NOT NULL)))
    ),
    CONSTRAINT ck_confluence_settings_scope_valid CHECK ((scope = ANY (ARRAY['platform'::text, 'installation'::text])))
);

-- One settings row per (scope, installation) — the COALESCE sentinel makes platform (NULL install) a
-- singleton, matching the github_app_settings / llm_provider_settings UPSERT idiom.
CREATE UNIQUE INDEX uq_confluence_settings_scope_install
    ON core.confluence_settings (scope, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid));
