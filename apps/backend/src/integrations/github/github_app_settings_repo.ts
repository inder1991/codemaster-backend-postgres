// UI-editable GitHub App credentials (go-live Step 4b). The platform-scope singleton in
// core.github_app_settings; the two secret columns (private_key_pem, webhook_secret) are encrypted
// with the LOCAL field codec (KeyRegistry + per-column AAD) — NOT Vault Transit — so UI-config works
// with or without Vault. Read at use-time (DB tier of the DB > env > Vault > disabled resolver).

import { type Kysely, sql } from "kysely";

import { decryptField, encryptField } from "#platform/crypto/aes_gcm_aad.js";
import { type KeyRegistry } from "#platform/crypto/key_registry.js";
import { tenantKysely } from "#platform/db/database.js";

const PRIVATE_KEY_AAD = new TextEncoder().encode("core.github_app_settings.private_key_pem_ciphertext");
const WEBHOOK_SECRET_AAD = new TextEncoder().encode("core.github_app_settings.webhook_secret_ciphertext");

/** Decrypted GitHub App credentials (transient — never log/store the secrets). */
export type GitHubAppSettings = {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly webhookSecret: string;
  readonly enabled: boolean;
};

type Row = {
  app_id: string;
  private_key_pem_ciphertext: string;
  webhook_secret_ciphertext: string;
  enabled: boolean;
};

/** Postgres adapter for the platform-scope GitHub App settings; field-codec encrypted at rest. */
export class PostgresGitHubAppSettingsRepo {
  private readonly db: Kysely<unknown>;
  private readonly registry: KeyRegistry;

  public constructor(args: { db: Kysely<unknown>; registry: KeyRegistry }) {
    this.db = args.db;
    this.registry = args.registry;
  }

  public static fromDsn(args: { dsn: string; registry: KeyRegistry }): PostgresGitHubAppSettingsRepo {
    return new PostgresGitHubAppSettingsRepo({ db: tenantKysely<unknown>(args.dsn), registry: args.registry });
  }

  /** The platform-scope GitHub App creds (decrypted), or null when unconfigured / disabled. */
  public async read(): Promise<GitHubAppSettings | null> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-github-app-settings
    const result = await sql<Row>`
      SELECT app_id, private_key_pem_ciphertext, webhook_secret_ciphertext, enabled
        FROM core.github_app_settings
       WHERE scope = 'platform'
       LIMIT 1
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined || !row.enabled) {
      return null;
    }
    return {
      appId: row.app_id,
      privateKeyPem: this.decrypt(row.private_key_pem_ciphertext, PRIVATE_KEY_AAD),
      webhookSecret: this.decrypt(row.webhook_secret_ciphertext, WEBHOOK_SECRET_AAD),
      enabled: row.enabled,
    };
  }

  /** The non-secret view (app_id + enabled), or null when no platform row exists. Does NOT decrypt — so
   *  it never throws on a rotated-out / corrupt key. Used by config-status + the GET route (which only need
   *  presence + the non-secret fields), so one undecryptable row can't 500 the whole setup checklist. */
  public async readNonSecret(): Promise<{ appId: string; enabled: boolean } | null> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-github-app-settings
    const result = await sql<{ app_id: string; enabled: boolean }>`
      SELECT app_id, enabled
        FROM core.github_app_settings
       WHERE scope = 'platform'
       LIMIT 1
    `.execute(this.db);
    const row = result.rows[0];
    return row === undefined ? null : { appId: row.app_id, enabled: row.enabled };
  }

  /** UPSERT the platform-scope GitHub App creds (secrets encrypted via the field codec). */
  public async write(args: {
    appId: string;
    privateKeyPem: string;
    webhookSecret: string;
    enabled: boolean;
    rotatedByUserId: string;
  }): Promise<void> {
    const pkCipher = encryptField({
      plaintext: new TextEncoder().encode(args.privateKeyPem),
      registry: this.registry,
      aad: PRIVATE_KEY_AAD,
    });
    const whCipher = encryptField({
      plaintext: new TextEncoder().encode(args.webhookSecret),
      registry: this.registry,
      aad: WEBHOOK_SECRET_AAD,
    });
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-github-app-settings
    await sql`
      INSERT INTO core.github_app_settings
        (scope, installation_id, app_id, private_key_pem_ciphertext, webhook_secret_ciphertext,
         enabled, last_rotated_by_user_id)
      VALUES ('platform', NULL, ${args.appId}, ${pkCipher}, ${whCipher}, ${args.enabled}, ${args.rotatedByUserId})
      ON CONFLICT (scope, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET
        app_id = EXCLUDED.app_id,
        private_key_pem_ciphertext = EXCLUDED.private_key_pem_ciphertext,
        webhook_secret_ciphertext = EXCLUDED.webhook_secret_ciphertext,
        enabled = EXCLUDED.enabled,
        last_rotated_at = now(),
        last_rotated_by_user_id = EXCLUDED.last_rotated_by_user_id
    `.execute(this.db);
  }

  private decrypt(ciphertext: string, aad: Uint8Array): string {
    return new TextDecoder("utf-8").decode(decryptField({ ciphertext, registry: this.registry, aad }));
  }
}
