// Persisted auth secrets — the session HMAC signing key + CSRF double-submit secret (go-live review P0).
// These are NOT operator-provided bootstrap secrets: when neither env nor Vault supplies them, the app
// auto-generates them on first boot and persists them HERE (field-codec ciphertext, KeyRegistry + per-column
// AAD), stable across replicas + restarts. Platform singleton; ensure() is race-safe across replicas
// (INSERT ON CONFLICT DO NOTHING + re-read, so all replicas converge on the one winning row). Mirrors
// PostgresConfluenceSettingsRepo.

import { type Kysely, sql } from "kysely";

import { decryptField, encryptField } from "#platform/crypto/aes_gcm_aad.js";
import { type KeyRegistry } from "#platform/crypto/key_registry.js";
import { tenantKysely } from "#platform/db/database.js";

const SIGNING_AAD = new TextEncoder().encode("core.auth_secrets.session_signing_key_ciphertext");
const CSRF_AAD = new TextEncoder().encode("core.auth_secrets.csrf_secret_ciphertext");

/** Decrypted auth secrets (transient — never log). Both are >= 32-char secrets. */
export type AuthSecrets = {
  readonly sessionSigningKey: string;
  readonly csrfSecret: string;
};

type Row = {
  session_signing_key_ciphertext: string;
  csrf_secret_ciphertext: string;
};

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

export class PostgresAuthSecretsRepo {
  private readonly db: Kysely<unknown>;
  private readonly registry: KeyRegistry;

  public constructor(args: { db: Kysely<unknown>; registry: KeyRegistry }) {
    this.db = args.db;
    this.registry = args.registry;
  }

  public static fromDsn(args: { dsn: string; registry: KeyRegistry }): PostgresAuthSecretsRepo {
    return new PostgresAuthSecretsRepo({ db: tenantKysely<unknown>(args.dsn), registry: args.registry });
  }

  /** The platform-scope auth secrets (decrypted), or null when none have been persisted yet. */
  public async read(): Promise<AuthSecrets | null> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-auth-secrets
    const result = await sql<Row>`
      SELECT session_signing_key_ciphertext, csrf_secret_ciphertext
        FROM core.auth_secrets
       WHERE scope = 'platform'
       LIMIT 1
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      sessionSigningKey: dec.decode(
        decryptField({ ciphertext: row.session_signing_key_ciphertext, registry: this.registry, aad: SIGNING_AAD }),
      ),
      csrfSecret: dec.decode(
        decryptField({ ciphertext: row.csrf_secret_ciphertext, registry: this.registry, aad: CSRF_AAD }),
      ),
    };
  }

  /**
   * Return the persisted auth secrets, generating + persisting them on first call. Race-safe across
   * replicas: a concurrent winner's row is kept (INSERT ON CONFLICT DO NOTHING), and we re-read to return
   * the actually-persisted secrets — so every replica converges on ONE keypair (else sessions signed by
   * one replica wouldn't verify on another).
   */
  public async ensure(generate: () => AuthSecrets): Promise<AuthSecrets> {
    const existing = await this.read();
    if (existing !== null) {
      return existing;
    }
    const fresh = generate();
    const signingCipher = encryptField({ plaintext: enc.encode(fresh.sessionSigningKey), registry: this.registry, aad: SIGNING_AAD });
    const csrfCipher = encryptField({ plaintext: enc.encode(fresh.csrfSecret), registry: this.registry, aad: CSRF_AAD });
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-auth-secrets
    await sql`
      INSERT INTO core.auth_secrets (scope, session_signing_key_ciphertext, csrf_secret_ciphertext)
      VALUES ('platform', ${signingCipher}, ${csrfCipher})
      ON CONFLICT (scope) DO NOTHING
    `.execute(this.db);
    // Re-read: returns OUR row, or the race-winner's if a concurrent replica inserted first.
    const persisted = await this.read();
    if (persisted === null) {
      throw new Error("auth_secrets ensure: row vanished after INSERT — concurrent delete?");
    }
    return persisted;
  }
}
