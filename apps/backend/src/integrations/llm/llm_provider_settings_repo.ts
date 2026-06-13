/**
 * `core.llm_provider_settings` Postgres adapter — REAL Kysely + Vault-Transit (de-stub step 1).
 * No stub, no mock, no no-op on the shipped path. Runs three reads
 * against `core.llm_provider_settings` over the shared single-pool Kysely seam ({@link tenantKysely})
 * and decrypts `api_key_ciphertext` via the REAL Vault Transit key `"llm_provider_settings"` through
 * the injected {@link VaultPort}. The ported subset is the three reads named by the de-stub task:
 *
 *   1. {@link PostgresLlmProviderSettingsRepo.readDecryptedSettings} — worker-side decrypted read.
 *      Returns {@link LlmProviderSettings} (plaintext `apiKey` + provider + modelId + region +
 *      enabled) or `null` when the row is absent OR disabled (fail-closed, treated as absent).
 *   2. {@link PostgresLlmProviderSettingsRepo.readRotationFingerprint} — PK-scan of all platform
 *      rows returning `[(role, lastRotatedAt), …]` (at most 2: primary + secondary). Used by the
 *      `LlmClientCache` for sub-ms staleness detection — no decrypt.
 *   3. {@link PostgresLlmProviderSettingsRepo.readLastRotatedAt} — single-row `last_rotated_at` for
 *      one (scope, role) or `null`. Cheap rotation probe.
 *
 * The admin-side write surface (`write_settings_atomic`) and the UI-metadata / per-provider reads of
 * the Python module are OUT OF SCOPE for this de-stub step (worker-side read path only) and are NOT
 * ported here.
 *
 * ── Vault key + decrypt path ──
 * The Vault Transit key is `"llm_provider_settings"` (Python `_VAULT_KEY_NAME`). The decrypt goes
 * `vault.transitDecrypt({ keyName, ciphertext }) -> Uint8Array`, then `TextDecoder("utf-8")` to the
 * plaintext token — mirroring the Python `self._vault.decrypt(...).decode("utf-8")`. The plaintext
 * token is consumed transiently by the caller (the SDK adapter / cache); it must never be logged,
 * stored, or returned beyond the {@link LlmProviderSettings} value.
 *
 * ── Tenancy (platform-scope) ──
 * `core.llm_provider_settings` is scope-discriminated, NOT per-installation: tenancy is expressed via
 * the `scope = 'platform'` predicate, not an `installation_id` equality filter. The table is NOT in
 * `TENANT_SCOPED_TABLES` (it carries a nullable `installation_id` — NULL for every platform row), so
 * neither the runtime `TenancyPlugin` nor the PR-time raw-SQL gate hard-requires an `installation_id`
 * filter on it. Each raw-`sql` read below nonetheless carries the `// tenant:exempt reason=…
 * follow_up=PERMANENT-EXEMPTION-platform-llm-config` marker — verbatim from the Python source's
 * platform-config exemption idiom — so a human reviews any future query touching this table and the
 * platform-scope rationale travels with the code.
 *
 * ── Clock seam ──
 * No wall-clock read happens on the read path (the writes that default `last_rotated_at` to
 * `clock.now()` are out of scope). The {@link Clock} is injected anyway (defaulting to
 * {@link WallClock}) to match the Python constructor and so a later write port has the seam ready —
 * the check_clock_random gate is satisfied because no raw `Date`/`Math.random` is used.
 */

import { type Kysely, sql } from "kysely";

import { type Clock, WallClock } from "#platform/clock.js";
import { tenantKysely } from "#platform/db/database.js";

import { decryptField, encryptField } from "#platform/crypto/aes_gcm_aad.js";
import { type KeyRegistry } from "#platform/crypto/key_registry.js";

// ─── Constants ────────────────────────────────────────────────────────────────────────────────

/** Per-column AAD binding the api-key ciphertext to this table+column (field codec, local keyset).
 *  Replaces the former Vault Transit key — so UI-saved LLM creds encrypt with OR without Vault. */
const LLM_API_KEY_AAD: Uint8Array = new TextEncoder().encode(
  "core.llm_provider_settings.api_key_ciphertext",
);

/** Provider-slot role discriminator — the two values the `role` CHECK constraint permits. */
export type LlmProviderRole = "primary" | "secondary";

// ─── Decrypted-settings value ─────────────────────────────────────────────────────────────────────

/**
 * Decrypted credentials + metadata returned by {@link PostgresLlmProviderSettingsRepo.readDecryptedSettings}.
 *
 * In-process return type, NOT a cross-process wire contract (no `schema_version`) — it never leaves
 * the worker, so it is a plain typed object rather than a Zod-validated contract.
 *
 * The `apiKey` field holds the PLAINTEXT token — it is consumed immediately by the SDK adapter and
 * MUST NOT be logged, stored, or surfaced outside the call frame.
 */
export type LlmProviderSettings = {
  readonly provider: string;
  readonly modelId: string;
  readonly region: string | null;
  readonly apiKey: string;
  readonly enabled: boolean;
};

/** One `(role, lastRotatedAt)` pair from {@link PostgresLlmProviderSettingsRepo.readRotationFingerprint}. */
export type RotationFingerprintEntry = {
  readonly role: string;
  readonly lastRotatedAt: Date;
};

// ─── Row shapes the raw `sql<T>` reads materialize ────────────────────────────────────────────────

/** Row shape of the `readDecryptedSettings` SELECT (pre-decrypt — carries the ciphertext). */
type DecryptedSettingsRow = {
  readonly provider: string;
  readonly model_id: string;
  readonly region: string | null;
  readonly api_key_ciphertext: string;
  readonly enabled: boolean;
};

/** Row shape of the `readRotationFingerprint` PK-scan. */
type RotationFingerprintRow = {
  readonly role: string;
  readonly last_rotated_at: Date;
};

/** Row shape of the `readLastRotatedAt` single-row probe. */
type LastRotatedAtRow = {
  readonly last_rotated_at: Date;
};

// ─── The adapter ──────────────────────────────────────────────────────────────────────────────────

/**
 * Real adapter for the `core.llm_provider_settings` table — worker-side decrypted read path.
 *
 * One instance per process; wired at bootstrap with an injected `Kysely` (over the shared ADR-0062
 * single pool), a {@link VaultPort}, and an optional {@link Clock}. Stateless beyond the injected
 * dependencies — safe to share across concurrent async tasks.
 */
export class PostgresLlmProviderSettingsRepo {
  private readonly db: Kysely<unknown>;
  private readonly registry: KeyRegistry;
  private readonly clock: Clock;

  public constructor(args: { db: Kysely<unknown>; registry: KeyRegistry; clock?: Clock }) {
    this.db = args.db;
    this.registry = args.registry;
    this.clock = args.clock ?? new WallClock();
  }

  /** Decrypt an api-key ciphertext (field codec, local keyset + per-column AAD). Transient plaintext. */
  private decryptApiKey(ciphertext: string): string {
    return new TextDecoder("utf-8").decode(
      decryptField({ ciphertext, registry: this.registry, aad: LLM_API_KEY_AAD }),
    );
  }

  /** Encrypt an api-key plaintext → the `kms2:vN:<base64>` envelope (field codec). */
  private encryptApiKey(plaintext: string): string {
    return encryptField({
      plaintext: new TextEncoder().encode(plaintext),
      registry: this.registry,
      aad: LLM_API_KEY_AAD,
    });
  }

  /**
   * Build a repo whose `Kysely` is the shared single-pool tenant Kysely for `dsn` (ADR-0062 seam).
   * Mirrors the `*.fromDsn(...)` convenience constructor the sibling spine repos expose for the
   * lazy-fallback wiring.
   */
  public static fromDsn(args: { dsn: string; registry: KeyRegistry; clock?: Clock }): PostgresLlmProviderSettingsRepo {
    return new PostgresLlmProviderSettingsRepo({
      db: tenantKysely<unknown>(args.dsn),
      registry: args.registry,
      // Spread only when present — `exactOptionalPropertyTypes` forbids passing an explicit
      // `undefined` for the optional `clock?` field.
      ...(args.clock !== undefined ? { clock: args.clock } : {}),
    });
  }

  // ─── Worker-side: read decrypted creds ─────────────────────────────────────────────────────────

  /**
   * Return current platform-scope credentials (decrypted) or `null`.
   *
   * `null` means either no row exists for `role` with `scope='platform'` (the admin hasn't
   * configured this slot yet) OR the row exists but `enabled=false` (the admin disabled this slot) —
   * the disabled case is treated as absent so callers fail-closed.
   *
   * Scope: queries `scope='platform'` only — per-installation override reads are deferred.
   * The plaintext token is decoded transiently and must not be logged or stored.
   */
  public async readDecryptedSettings(role: LlmProviderRole): Promise<LlmProviderSettings | null> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-platform-llm-config
    const result = await sql<DecryptedSettingsRow>`
      SELECT provider, model_id, region, api_key_ciphertext, enabled
        FROM core.llm_provider_settings
       WHERE role = ${role} AND scope = 'platform'
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }

    if (!row.enabled) {
      // Disabled slot → treat as absent. Admin can flip enabled=false to halt a slot without
      // rotating the token. Mirrors the Python `if not row.enabled: return None`.
      return null;
    }

    const apiKey = this.decryptApiKey(row.api_key_ciphertext);

    return {
      provider: row.provider,
      modelId: row.model_id,
      region: row.region,
      apiKey,
      enabled: row.enabled,
    };
  }

  // ─── Freshness probe for LlmClientCache ─────────────────────────────────────────────────────────

  /**
   * Scan `core.llm_provider_settings` for all platform-scope rows.
   *
   * Returns `[(role, lastRotatedAt), …]`; at most 2 rows (primary + secondary). Called by the
   * `LlmClientCache` on every invocation to detect stale cached credentials without a full decrypt
   * round-trip. Returns `[]` when no platform-scope rows exist.
   */
  public async readRotationFingerprint(): Promise<Array<RotationFingerprintEntry>> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-platform-llm-config
    const result = await sql<RotationFingerprintRow>`
      SELECT role, last_rotated_at
        FROM core.llm_provider_settings
       WHERE scope = 'platform'
       ORDER BY role
    `.execute(this.db);

    return result.rows.map((row) => ({ role: row.role, lastRotatedAt: row.last_rotated_at }));
  }

  // ─── Freshness probe for LlmCredentialsProvider ─────────────────────────────────────────────────

  /**
   * Return `last_rotated_at` for one `(scope, role)` row or `null`.
   *
   * Cheap single-row PK-scan. Called on every `current()` to detect operator-initiated rotations
   * within sub-ms latency instead of waiting for the TTL cache to expire. `null` means no row exists
   * for `(scope, role)` — first-time install before the admin saves credentials; the caller treats
   * `null` as `no rotation seen`.
   */
  public async readLastRotatedAt(args: {
    scope: "platform";
    role: LlmProviderRole;
  }): Promise<Date | null> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-platform-llm-config
    const result = await sql<LastRotatedAtRow>`
      SELECT last_rotated_at
        FROM core.llm_provider_settings
       WHERE scope = ${args.scope} AND role = ${args.role}
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return row.last_rotated_at;
  }

  /**
   * Admin-side credential write — single self-atomic UPSERT. The admin route emits dual rotation-audit
   * rows post-write through the dormant `AdminRoutesOptions.audit` no-op seam (consistent with every
   * other admin write).
   *
   * Encrypts the plaintext token via the REAL Vault Transit key `"llm_provider_settings"` and UPSERTs the
   * platform-scope row (scope='platform', installation_id=NULL) on the
   * `(scope, role, COALESCE(installation_id, zero-uuid))` expression-index conflict target. Returns the
   * 4-char fingerprint (last 4 plaintext chars; the length-4 CHECK) the route surfaces in its response.
   */
  public async writeSettings(args: {
    role: LlmProviderRole;
    provider: string;
    apiKeyPlaintext: string;
    modelId: string;
    region: string | null;
    enabled: boolean;
    validatedAt: Date | null;
    validationStatus: "ok" | "failed" | null;
    rotatedAt: Date;
    rotatedByUserId: string;
  }): Promise<{ fingerprint: string }> {
    const ciphertext = this.encryptApiKey(args.apiKeyPlaintext);
    const fingerprint = args.apiKeyPlaintext.slice(-4);
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-platform-llm-config
    await sql`
      INSERT INTO core.llm_provider_settings
        (scope, role, installation_id, provider, model_id, region,
         api_key_ciphertext, api_key_fingerprint, enabled,
         last_validated_at, last_validation_status,
         last_rotated_at, last_rotated_by_user_id)
      VALUES
        ('platform', ${args.role}, NULL, ${args.provider}, ${args.modelId}, ${args.region},
         ${ciphertext}, ${fingerprint}, ${args.enabled},
         ${args.validatedAt}, ${args.validationStatus},
         ${args.rotatedAt}, ${args.rotatedByUserId})
      ON CONFLICT (scope, role, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET
         provider = EXCLUDED.provider,
         model_id = EXCLUDED.model_id,
         region = EXCLUDED.region,
         api_key_ciphertext = EXCLUDED.api_key_ciphertext,
         api_key_fingerprint = EXCLUDED.api_key_fingerprint,
         enabled = EXCLUDED.enabled,
         last_validated_at = EXCLUDED.last_validated_at,
         last_validation_status = EXCLUDED.last_validation_status,
         last_rotated_at = EXCLUDED.last_rotated_at,
         last_rotated_by_user_id = EXCLUDED.last_rotated_by_user_id
    `.execute(this.db);
    return { fingerprint };
  }

  /**
   * Return decrypted credentials for `provider` or `null`. Scans for an ENABLED platform-scope row
   * whose `provider` matches, preferring `role='primary'` (`ORDER BY (role = 'primary') DESC` makes
   * primary win the `LIMIT 1`). Used by the llm-models `/test` per-model credential ping. The
   * plaintext key is consumed transiently by the caller — never logged or returned.
   */
  public async readDecryptedForProvider(provider: string): Promise<LlmProviderSettings | null> {
    // tenant:exempt reason=platform-config follow_up=PERMANENT-EXEMPTION-platform-llm-config
    const result = await sql<ProviderCredsRow>`
      SELECT provider, model_id, region, api_key_ciphertext, enabled
        FROM core.llm_provider_settings
       WHERE provider = ${provider} AND scope = 'platform' AND enabled = true
       ORDER BY (role = 'primary') DESC
       LIMIT 1
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }

    const apiKey = this.decryptApiKey(row.api_key_ciphertext);

    return { provider: row.provider, modelId: row.model_id, region: row.region, apiKey, enabled: row.enabled };
  }
}

/** Row shape of the readDecryptedForProvider SELECT (pre-decrypt — carries the ciphertext). */
type ProviderCredsRow = {
  readonly provider: string;
  readonly model_id: string;
  readonly region: string | null;
  readonly api_key_ciphertext: string;
  readonly enabled: boolean;
};
