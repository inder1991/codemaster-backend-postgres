// UI-editable Confluence credentials (go-live Step 4c). The platform-scope singleton in
// core.confluence_settings; the token column is encrypted with the LOCAL field codec (KeyRegistry +
// per-column AAD) — NOT Vault Transit — so UI-config works with or without Vault. base_url + auth_email
// are non-secret. Read at use-time (the DB tier of the DB > env > Vault > disabled resolver). Mirrors
// PostgresGitHubAppSettingsRepo (Step 4b).

import { type Kysely, sql } from "kysely";

import { decryptField, encryptField } from "#platform/crypto/aes_gcm_aad.js";
import { type KeyRegistry } from "#platform/crypto/key_registry.js";
import { tenantKysely } from "#platform/db/database.js";

const TOKEN_AAD = new TextEncoder().encode("core.confluence_settings.token_ciphertext");

/** Decrypted Confluence credentials (transient — never log/store the token). */
export type ConfluenceSettings = {
  readonly baseUrl: string;
  /** Atlassian Cloud account email → HTTP-Basic; null for Bearer-PAT (Server/DC). */
  readonly authEmail: string | null;
  readonly token: string;
  readonly enabled: boolean;
};

type Row = {
  base_url: string;
  auth_email: string | null;
  token_ciphertext: string;
  enabled: boolean;
};

/** Postgres adapter for the platform-scope Confluence settings; field-codec encrypted at rest. */
export class PostgresConfluenceSettingsRepo {
  private readonly db: Kysely<unknown>;
  private readonly registry: KeyRegistry;

  public constructor(args: { db: Kysely<unknown>; registry: KeyRegistry }) {
    this.db = args.db;
    this.registry = args.registry;
  }

  public static fromDsn(args: { dsn: string; registry: KeyRegistry }): PostgresConfluenceSettingsRepo {
    return new PostgresConfluenceSettingsRepo({
      db: tenantKysely<unknown>(args.dsn),
      registry: args.registry,
    });
  }

  /** The platform-scope Confluence creds (decrypted), or null when unconfigured / disabled. */
  public async read(): Promise<ConfluenceSettings | null> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-confluence-settings
    const result = await sql<Row>`
      SELECT base_url, auth_email, token_ciphertext, enabled
        FROM core.confluence_settings
       WHERE scope = 'platform'
       LIMIT 1
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined || !row.enabled) {
      return null;
    }
    return {
      baseUrl: row.base_url,
      authEmail: row.auth_email,
      token: new TextDecoder("utf-8").decode(
        decryptField({ ciphertext: row.token_ciphertext, registry: this.registry, aad: TOKEN_AAD }),
      ),
      enabled: row.enabled,
    };
  }

  /** The non-secret view (base_url + auth_email + enabled), or null when no platform row exists. Does NOT
   *  decrypt — so it never throws on a rotated-out / corrupt key. Used by config-status + the GET route
   *  (presence + non-secret fields only), so one undecryptable row can't 500 the whole setup checklist. */
  public async readNonSecret(): Promise<{ baseUrl: string; authEmail: string | null; enabled: boolean } | null> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-confluence-settings
    const result = await sql<{ base_url: string; auth_email: string | null; enabled: boolean }>`
      SELECT base_url, auth_email, enabled
        FROM core.confluence_settings
       WHERE scope = 'platform'
       LIMIT 1
    `.execute(this.db);
    const row = result.rows[0];
    return row === undefined
      ? null
      : { baseUrl: row.base_url, authEmail: row.auth_email, enabled: row.enabled };
  }

  /** UPSERT the platform-scope Confluence creds (token encrypted via the field codec). */
  public async write(args: {
    baseUrl: string;
    authEmail: string | null;
    token: string;
    enabled: boolean;
    rotatedByUserId: string;
  }): Promise<void> {
    const tokenCipher = encryptField({
      plaintext: new TextEncoder().encode(args.token),
      registry: this.registry,
      aad: TOKEN_AAD,
    });
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-confluence-settings
    await sql`
      INSERT INTO core.confluence_settings
        (scope, installation_id, base_url, auth_email, token_ciphertext, enabled, last_rotated_by_user_id)
      VALUES ('platform', NULL, ${args.baseUrl}, ${args.authEmail}, ${tokenCipher}, ${args.enabled}, ${args.rotatedByUserId})
      ON CONFLICT (scope, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET
        base_url = EXCLUDED.base_url,
        auth_email = EXCLUDED.auth_email,
        token_ciphertext = EXCLUDED.token_ciphertext,
        enabled = EXCLUDED.enabled,
        last_rotated_at = now(),
        last_rotated_by_user_id = EXCLUDED.last_rotated_by_user_id
    `.execute(this.db);
  }
}
