// Platform-credentials metadata repo — core.platform_credentials_meta + core.embedder_runtime_state are
// platform SINGLETON tables (no installation_id), so reads carry the tenant:exempt marker. Secrets live
// in Vault KV; these tables hold only rotation/validation metadata.

import { type Kysely, sql } from "kysely";

export type PlatformCredentialsMetaRow = {
  readonly credentialKey: string;
  readonly lastRotatedAt: Date;
  readonly lastRotatedBy: string | null;
  readonly lastValidatedAt: Date | null;
  readonly lastValidationError: string | null;
};

export class PostgresPlatformCredentialsMetaRepo {
  public constructor(private readonly db: Kysely<unknown>) {}

  /** Fetch the meta row for a credential_key, or null. */
  public async get(credentialKey: string): Promise<PlatformCredentialsMetaRow | null> {
    // tenant:exempt reason=platform-singleton-no-installation-id follow_up=PERMANENT-EXEMPTION-platform-credentials-meta
    const r = await sql<{
      credential_key: string;
      last_rotated_at: Date;
      last_rotated_by: string | null;
      last_validated_at: Date | null;
      last_validation_error: string | null;
    }>`
      SELECT credential_key, last_rotated_at, last_rotated_by, last_validated_at, last_validation_error
      FROM core.platform_credentials_meta
      WHERE credential_key = ${credentialKey}
    `.execute(this.db);
    const row = r.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      credentialKey: row.credential_key,
      lastRotatedAt: row.last_rotated_at,
      lastRotatedBy: row.last_rotated_by,
      lastValidatedAt: row.last_validated_at,
      lastValidationError: row.last_validation_error,
    };
  }

  /** Upsert the rotation metadata. last_rotated_at = DB now() (authoritative); validation cols untouched.
   *  1:1 with `upsert_rotation`. */
  public async upsertRotation(args: { credentialKey: string; lastRotatedBy: string }): Promise<void> {
    // tenant:exempt reason=platform-singleton-no-installation-id follow_up=PERMANENT-EXEMPTION-platform-credentials-meta
    await sql`
      INSERT INTO core.platform_credentials_meta (credential_key, last_rotated_at, last_rotated_by)
      VALUES (${args.credentialKey}, now(), ${args.lastRotatedBy})
      ON CONFLICT (credential_key) DO UPDATE
        SET last_rotated_at = now(), last_rotated_by = ${args.lastRotatedBy}
    `.execute(this.db);
  }

  /** Upsert the validation outcome. INSERTs if absent (last_rotated_at defaults to now()). 1:1 with
   *  `update_validation`. */
  public async updateValidation(args: {
    credentialKey: string;
    lastValidatedAt: Date;
    lastValidationError: string | null;
  }): Promise<void> {
    // tenant:exempt reason=platform-singleton-no-installation-id follow_up=PERMANENT-EXEMPTION-platform-credentials-meta
    await sql`
      INSERT INTO core.platform_credentials_meta (credential_key, last_validated_at, last_validation_error)
      VALUES (${args.credentialKey}, ${args.lastValidatedAt}, ${args.lastValidationError})
      ON CONFLICT (credential_key) DO UPDATE
        SET last_validated_at = ${args.lastValidatedAt}, last_validation_error = ${args.lastValidationError}
    `.execute(this.db);
  }
}

/** Bump the embedder runtime-state config_version so review/embedder workers refresh their Qwen credential
 *  cache within the SLA. 1:1 with EmbedderRuntimeStateRepo.bump_config_version. Singleton table. */
export async function bumpEmbedderConfigVersion(db: Kysely<unknown>, updatedByEmail: string): Promise<void> {
  // tenant:exempt reason=platform-singleton-embedder-runtime-state follow_up=PERMANENT-EXEMPTION-embedder-runtime-state
  await sql`
    UPDATE core.embedder_runtime_state
    SET config_version = config_version + 1, updated_at = now(), updated_by_email = ${updatedByEmail}
    WHERE singleton = true
  `.execute(db);
}
