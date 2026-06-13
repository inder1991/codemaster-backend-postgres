// Where the two BOOTSTRAP secrets (DB credentials + the field-encryption key) are read from. One
// switch, no fallback: `CODEMASTER_SECRET_SOURCE = openshift | vault` (default openshift), with
// optional per-secret overrides (CODEMASTER_PG_SECRET_SOURCE / CODEMASTER_FIELD_KEY_SOURCE). The app
// reads ONLY the resolved source so a "not found" error names exactly where to seed it. (This
// no-fallback rule is for bootstrap secrets ONLY — UI-managed feature config layers DB > env > Vault.)

/** A bootstrap-secret source: a Secret-injected env (`openshift`) or a Vault path (`vault`). */
export type SecretSource = "openshift" | "vault";

const SECRET_SOURCES: ReadonlyArray<SecretSource> = ["openshift", "vault"];
const GLOBAL_KEY = "CODEMASTER_SECRET_SOURCE";

/**
 * Resolve the source for a bootstrap secret: the per-secret override env (if `overrideKey` is given
 * AND set) wins, else the global `CODEMASTER_SECRET_SOURCE`, else `openshift`. Throws on an
 * unrecognized value, naming the allowed set.
 */
export function resolveSecretSource(
  env: Record<string, string | undefined>,
  overrideKey?: string,
): SecretSource {
  const override = overrideKey === undefined ? undefined : env[overrideKey];
  const raw = (override ?? env[GLOBAL_KEY] ?? "openshift").trim();
  if (!isSecretSource(raw)) {
    const from = override !== undefined ? overrideKey : GLOBAL_KEY;
    throw new Error(
      `invalid ${from}="${raw}": must be one of ${SECRET_SOURCES.join(" | ")}`,
    );
  }
  return raw;
}

function isSecretSource(value: string): value is SecretSource {
  return (SECRET_SOURCES as ReadonlyArray<string>).includes(value);
}
