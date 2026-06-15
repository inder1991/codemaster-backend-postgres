// UI-editable embedder credentials + model (Phase 3). The platform-scope singleton in
// core.embedder_provider_settings; the api key is encrypted with the LOCAL field codec (KeyRegistry +
// per-column AAD) — NOT Vault Transit — so UI-config works with or without Vault. base_url + model_name
// are non-secret. Mirrors PostgresConfluenceSettingsRepo / PostgresLlmProviderSettingsRepo.
//
// LIFECYCLE: a PUT only STAGES the row (writeSecret resets validation; the new config is unvalidated
// until /test). The runtime only adopts a config once /test promotes it (validation='ok') — that
// promotion lives in the admin route's transaction (Phase 6), not here. The api key is TRI-STATE:
//   set   → encrypt + store + fingerprint (last 4 chars; the eps_fingerprint_4 CHECK), bump last_rotated_at;
//   clear → keyless (ciphertext + fingerprint NULL), bump last_rotated_at;
//   keep  → leave the key columns + last_rotated_at untouched (edit base_url/model without re-pasting).
// updated_at is bumped on EVERY field write — it is the compare-and-swap token the /test promotion guards.

import { type Kysely, sql } from "kysely";

import { decryptField, encryptField } from "#platform/crypto/aes_gcm_aad.js";
import { type KeyRegistry } from "#platform/crypto/key_registry.js";
import { tenantKysely } from "#platform/db/database.js";

/** Per-column AAD binding the api-key ciphertext to this table+column (local keyset, NOT Vault Transit). */
const EMBEDDER_API_KEY_AAD: Uint8Array = new TextEncoder().encode(
  "core.embedder_provider_settings.api_key_ciphertext",
);

export type EmbedderValidationStatus = "ok" | "failed";

/** Decrypted runtime config for the resolver (transient — never log the key). apiKey null = keyless.
 *  Returned regardless of enabled/validation — the RESOLVER applies the enabled + validation='ok' policy
 *  (D2-val), so the disabled/invalid distinction stays in one place. */
export type EmbedderEffectiveDbConfig = {
  readonly baseUrl: string;
  readonly modelName: string;
  readonly apiKey: string | null;
  readonly enabled: boolean;
  readonly validationStatus: EmbedderValidationStatus | null;
  /** The exact-comparison CAS token (bumped on every config write). The /test route captures this from
   *  the SAME read that yields the probed config, so a concurrent PUT can't make the probe validate config
   *  A while the promotion CAS guards config B's revision. */
  readonly configRevision: number;
};

/** The non-secret view for the GET route + config-status (never decrypts — one undecryptable row must not
 *  500 the whole setup checklist). */
export type EmbedderSettingsNonSecret = {
  readonly provider: "openai_compat";
  readonly baseUrl: string;
  readonly modelName: string;
  readonly keyPresent: boolean;
  readonly enabled: boolean;
  readonly lastValidationStatus: EmbedderValidationStatus | null;
  readonly lastValidationError: string | null;
  readonly lastValidatedAt: Date | null;
  readonly lastRotatedAt: Date | null;
  readonly lastRotatedBy: string | null;
  readonly updatedAt: Date;
};

/** The api-key write action (PUT tri-state). */
export type EmbedderKeyAction =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; plaintext: string };

type ResolveRow = {
  base_url: string;
  model_name: string;
  api_key_ciphertext: string | null;
  enabled: boolean;
  last_validation_status: string | null;
  config_revision: string; // bigint → string from pg
};

type NonSecretRow = {
  base_url: string;
  model_name: string;
  key_present: boolean;
  enabled: boolean;
  last_validation_status: string | null;
  last_validation_error: string | null;
  last_validated_at: Date | null;
  last_rotated_at: Date | null;
  last_rotated_by: string | null;
  updated_at: Date;
};

/** Postgres adapter for the platform-scope embedder settings singleton; field-codec encrypted at rest. */
export class PostgresEmbedderProviderSettingsRepo {
  private readonly db: Kysely<unknown>;
  private readonly registry: KeyRegistry;

  public constructor(args: { db: Kysely<unknown>; registry: KeyRegistry }) {
    this.db = args.db;
    this.registry = args.registry;
  }

  public static fromDsn(args: {
    dsn: string;
    registry: KeyRegistry;
  }): PostgresEmbedderProviderSettingsRepo {
    return new PostgresEmbedderProviderSettingsRepo({
      db: tenantKysely<unknown>(args.dsn),
      registry: args.registry,
    });
  }

  private encryptApiKey(plaintext: string): string {
    return encryptField({
      plaintext: new TextEncoder().encode(plaintext),
      registry: this.registry,
      aad: EMBEDDER_API_KEY_AAD,
    });
  }

  private decryptApiKey(ciphertext: string): string {
    return new TextDecoder("utf-8").decode(
      decryptField({ ciphertext, registry: this.registry, aad: EMBEDDER_API_KEY_AAD }),
    );
  }

  /**
   * Decrypted runtime read. `null` ONLY when no row exists; the resolver applies the enabled +
   * validation='ok' policy. `apiKey` is null for a keyless embedder (ciphertext NULL).
   */
  public async readForResolve(): Promise<EmbedderEffectiveDbConfig | null> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-embedder-provider-settings
    const r = await sql<ResolveRow>`
      SELECT base_url, model_name, api_key_ciphertext, enabled, last_validation_status, config_revision
        FROM core.embedder_provider_settings
       WHERE singleton = true
       LIMIT 1
    `.execute(this.db);
    const row = r.rows[0];
    if (row === undefined) {
      return null;
    }
    const apiKey = row.api_key_ciphertext === null ? null : this.decryptApiKey(row.api_key_ciphertext);
    return {
      baseUrl: row.base_url,
      modelName: row.model_name,
      apiKey,
      enabled: row.enabled,
      validationStatus: row.last_validation_status as EmbedderValidationStatus | null,
      configRevision: Number(row.config_revision),
    };
  }

  /** Non-secret view (never decrypts), or null when no row exists. */
  public async readNonSecret(): Promise<EmbedderSettingsNonSecret | null> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-embedder-provider-settings
    const r = await sql<NonSecretRow>`
      SELECT base_url, model_name, (api_key_ciphertext IS NOT NULL) AS key_present, enabled,
             last_validation_status, last_validation_error, last_validated_at,
             last_rotated_at, last_rotated_by, updated_at
        FROM core.embedder_provider_settings
       WHERE singleton = true
       LIMIT 1
    `.execute(this.db);
    const row = r.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      provider: "openai_compat",
      baseUrl: row.base_url,
      modelName: row.model_name,
      keyPresent: row.key_present,
      enabled: row.enabled,
      lastValidationStatus: row.last_validation_status as EmbedderValidationStatus | null,
      lastValidationError: row.last_validation_error,
      lastValidatedAt: row.last_validated_at,
      lastRotatedAt: row.last_rotated_at,
      lastRotatedBy: row.last_rotated_by,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Stage a PUT: set base_url + model_name + enabled + the key action; RESET validation (the new config is
   * unvalidated until /test); bump updated_at (the CAS token). last_rotated_at/by bump ONLY on a key
   * change. Provider is server-owned ('openai_compat'). Returns the 4-char fingerprint (null if keyless).
   */
  public async writeSecret(args: {
    baseUrl: string;
    modelName: string;
    enabled: boolean;
    key: EmbedderKeyAction;
    rotatedBy: string;
  }): Promise<{ fingerprint: string | null }> {
    const rotateKey = args.key.kind !== "keep";
    let ciphertext: string | null = null;
    let fingerprint: string | null = null;
    if (args.key.kind === "set") {
      ciphertext = this.encryptApiKey(args.key.plaintext);
      fingerprint = args.key.plaintext.slice(-4);
    }
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-embedder-provider-settings
    await sql`
      INSERT INTO core.embedder_provider_settings
        (singleton, provider, base_url, model_name, api_key_ciphertext, api_key_fingerprint, enabled,
         last_validated_at, last_validation_status, last_validation_error,
         last_rotated_at, last_rotated_by, updated_at)
      VALUES
        (true, 'openai_compat', ${args.baseUrl}, ${args.modelName}, ${ciphertext}, ${fingerprint},
         ${args.enabled}, NULL, NULL, NULL, now(), ${args.rotatedBy}, now())
      ON CONFLICT (singleton) DO UPDATE SET
        base_url = EXCLUDED.base_url,
        model_name = EXCLUDED.model_name,
        enabled = EXCLUDED.enabled,
        last_validated_at = NULL,
        last_validation_status = NULL,
        last_validation_error = NULL,
        api_key_ciphertext  = CASE WHEN ${rotateKey} THEN EXCLUDED.api_key_ciphertext
                                   ELSE core.embedder_provider_settings.api_key_ciphertext END,
        api_key_fingerprint = CASE WHEN ${rotateKey} THEN EXCLUDED.api_key_fingerprint
                                   ELSE core.embedder_provider_settings.api_key_fingerprint END,
        last_rotated_at     = CASE WHEN ${rotateKey} THEN now()
                                   ELSE core.embedder_provider_settings.last_rotated_at END,
        last_rotated_by     = CASE WHEN ${rotateKey} THEN EXCLUDED.last_rotated_by
                                   ELSE core.embedder_provider_settings.last_rotated_by END,
        updated_at = now(),
        config_revision = core.embedder_provider_settings.config_revision + 1
    `.execute(this.db);
    return { fingerprint };
  }

  /**
   * Record a /test outcome on the staged row WITHOUT changing config_revision (validation is not a config
   * change). The SUCCESS path goes through promoteValidatedEmbedderConfig (CAS under the lock); this is the
   * FAILED path, CAS-guarded the SAME way: `expectedRevision` must still match, so a concurrent PUT that
   * re-staged a NEW config between the probe and this write does NOT get its (just-reset) validation
   * stamped 'failed' with the OLD config's error (review finding). Returns true iff the CAS matched (the
   * row existed AND was unchanged); false → the config moved, the caller leaves the new config untouched.
   */
  public async writeValidationResult(args: {
    status: EmbedderValidationStatus;
    error: string | null;
    expectedRevision: number;
  }): Promise<boolean> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-embedder-provider-settings
    // CAS on config_revision: a concurrent successful /test promote BUMPS config_revision (review
    // promote-tx-1), so a late-finishing FAILED probe of the (now-stale) revision misses here → the route
    // 409s instead of clobbering the just-promoted validation='ok' back to 'failed'. A legitimate
    // sequential re-test that fails (no concurrent promote → revision unchanged) still records 'failed'.
    const r = await sql`
      UPDATE core.embedder_provider_settings
         SET last_validation_status = ${args.status}, last_validation_error = ${args.error},
             last_validated_at = now()
       WHERE singleton = true AND config_revision = ${args.expectedRevision}
    `.execute(this.db);
    return (r.numAffectedRows ?? 0n) > 0n;
  }

  /**
   * Toggle enabled WITHOUT touching validation / key / base_url / model — bumps updated_at only (D2-val:
   * an enable toggle KEEPS the prior validation, unlike a config write which resets it). Returns true iff
   * a row existed.
   */
  public async updateEnabled(args: { enabled: boolean }): Promise<boolean> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-embedder-provider-settings
    const r = await sql`
      UPDATE core.embedder_provider_settings
         SET enabled = ${args.enabled}, updated_at = now(),
             config_revision = config_revision + 1
       WHERE singleton = true
    `.execute(this.db);
    return (r.numAffectedRows ?? 0n) > 0n;
  }
}
