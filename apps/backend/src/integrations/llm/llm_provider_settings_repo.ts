/**
 * `core.llm_provider_settings` Postgres adapter — REAL Kysely + Vault-Transit port (de-stub step 1).
 *
 * 1:1 TypeScript/Kysely port of the frozen Python spine repo
 * `vendor/codemaster-py/codemaster/api/admin/postgres_llm_provider_settings_repo.py`
 * (platform-scope rewrite; migration 0059 `scope` discriminator).
 *
 * This is the REAL adapter — no stub, no mock, no no-op on the shipped path. It runs three reads
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

import { type VaultPort } from "#backend/adapters/vault_port.js";

// ─── Constants (1:1 with the frozen Python module constants) ──────────────────────────────────

/** Vault Transit key name — Python `_VAULT_KEY_NAME`. */
const VAULT_KEY_NAME = "llm_provider_settings";

/** Provider-slot role discriminator — the two values the `role` CHECK constraint permits. */
export type LlmProviderRole = "primary" | "secondary";

// ─── Decrypted-settings value (port of the frozen Python `LlmProviderSettings` dataclass) ─────────

/**
 * Decrypted credentials + metadata returned by {@link PostgresLlmProviderSettingsRepo.readDecryptedSettings}.
 *
 * Port of the frozen Python `LlmProviderSettings` frozen dataclass. This is an in-process return
 * type, NOT a cross-process wire contract (no `schema_version`) — it never leaves the worker, so it
 * is a plain typed object rather than a Zod/Pydantic contract, faithful to the Python dataclass.
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
  private readonly vault: VaultPort;
  private readonly clock: Clock;

  public constructor(args: { db: Kysely<unknown>; vault: VaultPort; clock?: Clock }) {
    this.db = args.db;
    this.vault = args.vault;
    this.clock = args.clock ?? new WallClock();
  }

  /**
   * Build a repo whose `Kysely` is the shared single-pool tenant Kysely for `dsn` (ADR-0062 seam).
   * Mirrors the `*.fromDsn(...)` convenience constructor the sibling spine repos expose for the
   * lazy-fallback wiring.
   */
  public static fromDsn(args: { dsn: string; vault: VaultPort; clock?: Clock }): PostgresLlmProviderSettingsRepo {
    return new PostgresLlmProviderSettingsRepo({
      db: tenantKysely<unknown>(args.dsn),
      vault: args.vault,
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
   * Scope: queries `scope='platform'` only — per-installation override reads are deferred (matching
   * the frozen Python). The plaintext token is decoded transiently and must not be logged or stored.
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

    const plaintextBytes = await this.vault.transitDecrypt({
      keyName: VAULT_KEY_NAME,
      ciphertext: row.api_key_ciphertext,
    });
    const apiKey = new TextDecoder("utf-8").decode(plaintextBytes);

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
   * Admin-side credential write — 1:1 port of `write_settings_atomic` MINUS the in-transaction audit
   * callback. The Python emits the dual rotation-audit rows inside the same transaction; in the TS port the
   * admin route emits them post-write through the dormant `AdminRoutesOptions.audit` no-op seam (matching
   * every other ported admin write), so this method is a single self-atomic UPSERT.
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
    const ciphertext = await this.vault.transitEncrypt({
      keyName: VAULT_KEY_NAME,
      plaintext: new TextEncoder().encode(args.apiKeyPlaintext),
    });
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
   * Return decrypted credentials for `provider` or `null` — 1:1 port of `read_decrypted_for_provider`. Scans
   * for an ENABLED platform-scope row whose `provider` matches, preferring `role='primary'` (the
   * `ORDER BY (role = 'primary') DESC` makes primary win the `LIMIT 1`). Used by the llm-models `/test`
   * per-model credential ping. The plaintext key is consumed transiently by the caller — never logged or
   * returned. (No `enabled` post-filter: the `enabled = true` predicate is in the WHERE clause.)
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

    const plaintextBytes = await this.vault.transitDecrypt({
      keyName: VAULT_KEY_NAME,
      ciphertext: row.api_key_ciphertext,
    });
    const apiKey = new TextDecoder("utf-8").decode(plaintextBytes);

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
