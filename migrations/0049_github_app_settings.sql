-- 0049_github_app_settings — UI-editable GitHub App credentials (go-live Step 4b). The platform-scope
-- singleton the admin sets via the UI; secret columns are field-codec ciphertext (encrypted by the
-- boot field key, NOT Vault Transit — works with or without Vault). Resolved at use-time DB > env >
-- Vault > disabled, so it never blocks boot. (Folds into the squashed 0001_baseline at Step 6.)

CREATE TABLE core.github_app_settings (
    github_app_settings_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id uuid,
    app_id text NOT NULL,
    private_key_pem_ciphertext text NOT NULL,
    webhook_secret_ciphertext text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_rotated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_rotated_by_user_id uuid NOT NULL,
    scope text NOT NULL,
    CONSTRAINT ck_github_app_settings_scope_installation_consistency CHECK (
        (((scope = 'platform'::text) AND (installation_id IS NULL))
         OR ((scope = 'installation'::text) AND (installation_id IS NOT NULL)))
    ),
    CONSTRAINT ck_github_app_settings_scope_valid CHECK ((scope = ANY (ARRAY['platform'::text, 'installation'::text])))
);

-- One settings row per (scope, installation) — the COALESCE sentinel makes platform (NULL install) a
-- singleton, matching the llm_provider_settings UPSERT idiom.
CREATE UNIQUE INDEX uq_github_app_settings_scope_install
    ON core.github_app_settings (scope, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid));
