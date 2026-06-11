// CS6 (EC5 — cutover-safety): field-encryption key registry installed AT BOOT, decoupled from
// CODEMASTER_AUTH_ROUTES_ENABLED.
//
// Before CS6 the ONLY loader call was runServer's auth-gated block (api/server.ts), so every
// worker/runner pod booted with a NULL registry and the first audit-emitting path (reapStuckRuns
// on the idle review cycle, the mutex janitor, the retention crons, start_review_for_webhook)
// threw LocalKeyEncryptionError — re-wedging the ADR-0064 stuck-review class the self-healing
// emits exist to close. installFieldKeyRegistryAtBoot is the boot seam BOTH live runtimes call
// (worker/main.ts runWorker + runner/background_runner_main.ts runBackgroundRunner) before any
// connection/loop starts:
//
//   * production (NODE_ENV=production): the registry MUST load — the source defaults to "vault";
//     ANY failure (unreachable Vault, malformed keyset, failed self-check) throws
//     {@link FieldKeyBootError}, which each entrypoint's fail-loud `.catch` turns into
//     process.exit(1). No silent degradation.
//   * dev/test: an EXPLICIT CODEMASTER_FIELD_KEY_SOURCE (vault | vault-agent | file) loads
//     fail-loud — a configured source that fails must never silently degrade. NO source → skip:
//     the registry stays null and the audit codec stays FAIL-CLOSED (an exercised encrypt path
//     throws loudly; never an unencrypted write).
//   * startup self-check: after the load, an encrypt→decrypt probe round-trips through the codec
//     under the installed registry; on any mismatch the registry is uninstalled and boot refuses.
//
// Sources:
//   vault       — VaultHttpPort.fromEnv() (VAULT_ADDR + VAULT_TOKEN/VAULT_AGENT_TOKEN_PATH), the
//                 existing kvReadRaw path runServer uses.
//   vault-agent — the Agent-rendered keyset file `<CODEMASTER_VAULT_SECRETS_DIR|/vault/secrets>/
//                 codemaster_field_encryption_keys` (the FileKvReader sanitization rule applied to
//                 FIELD_ENCRYPTION_KEYS_VAULT_PATH; the flat-string FileKvReader itself cannot
//                 carry the NESTED keyset payload, so the file holds the raw keyset JSON).
//   file        — an explicit keyset JSON file at CODEMASTER_FIELD_KEYSET_FILE (dev/test).

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AUDIT_BEFORE_AAD,
  decryptAuditJsonBytea,
  encryptAuditJsonBytea,
  setAuditKeyRegistry,
} from "./audit_field_codec.js";
import {
  FIELD_ENCRYPTION_KEYS_VAULT_PATH,
  loadFieldEncryptionKeyRegistry,
  type VaultKvRawReadPort,
} from "./field_encryption_keys_loader.js";

const VALID_SOURCES = ["vault", "vault-agent", "file"] as const;
type FieldKeySource = (typeof VALID_SOURCES)[number];

/** The boot-time key install failed — the pod MUST NOT run audit-emitting paths without keys in
 *  production; each entrypoint's fail-loud `.catch` exits 1 on this. */
export class FieldKeyBootError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FieldKeyBootError";
  }
}

export type BootFieldKeyDeps = {
  /** Test seam: overrides the source-resolved keyset reader (unit tests inject scripted payloads). */
  reader?: VaultKvRawReadPort;
};

/**
 * Resolve the keyset source from env, load + self-check the registry, and install it on the
 * module-global audit-codec seam. Returns "installed", or "skipped" for the dev/test no-source
 * posture. Throws {@link FieldKeyBootError} on every failure path (see module doc).
 */
export async function installFieldKeyRegistryAtBoot(
  env: NodeJS.ProcessEnv,
  deps: BootFieldKeyDeps = {},
): Promise<"installed" | "skipped"> {
  const isProduction = env["NODE_ENV"] === "production";
  const rawSource = env["CODEMASTER_FIELD_KEY_SOURCE"];

  let source: FieldKeySource;
  if (rawSource === undefined || rawSource === "") {
    if (!isProduction && deps.reader === undefined) {
      return "skipped"; // dev/test with no explicit source: registry stays null, codec fail-closed
    }
    source = "vault"; // the production default — the registry MUST load
  } else if ((VALID_SOURCES as ReadonlyArray<string>).includes(rawSource)) {
    source = rawSource as FieldKeySource;
  } else {
    throw new FieldKeyBootError(
      `field-encryption key source '${rawSource}' is not valid: CODEMASTER_FIELD_KEY_SOURCE must be ` +
        `one of ${VALID_SOURCES.join(" | ")}`,
    );
  }

  try {
    const reader = deps.reader ?? (await resolveReader(source, env));
    const registry = await loadFieldEncryptionKeyRegistry(reader);
    setAuditKeyRegistry(registry);
    try {
      selfCheck();
    } catch (e) {
      setAuditKeyRegistry(null); // never leave a registry installed that failed its probe
      throw e;
    }
    return "installed";
  } catch (e) {
    if (e instanceof FieldKeyBootError) {
      throw e;
    }
    throw new FieldKeyBootError(
      `field-encryption key registry failed to load from source '${source}': ` +
        `${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
}

/** Build the keyset reader for the resolved source. Every reader satisfies the loader's
 *  {@link VaultKvRawReadPort} shape so loadFieldEncryptionKeyRegistry stays the single parser. */
async function resolveReader(source: FieldKeySource, env: NodeJS.ProcessEnv): Promise<VaultKvRawReadPort> {
  switch (source) {
    case "vault": {
      // Dynamic import keeps the Vault adapter graph off this module's static imports (the same
      // deferred-Vault posture as the event handlers' lazy ports).
      const { VaultHttpPort } = await import("#backend/adapters/vault_http.js");
      return VaultHttpPort.fromEnv();
    }
    case "vault-agent": {
      const dir = env["CODEMASTER_VAULT_SECRETS_DIR"] ?? "/vault/secrets";
      const file = join(dir, sanitizeAgentFileName(FIELD_ENCRYPTION_KEYS_VAULT_PATH));
      return fileKeysetReader(file);
    }
    case "file": {
      const file = env["CODEMASTER_FIELD_KEYSET_FILE"];
      if (file === undefined || file === "") {
        throw new FieldKeyBootError(
          "field-encryption key source 'file' requires CODEMASTER_FIELD_KEYSET_FILE to name the keyset JSON file",
        );
      }
      return fileKeysetReader(file);
    }
  }
}

/** A keyset file holding the raw `{current_version, keys}` JSON, adapted to the loader port. */
function fileKeysetReader(path: string): VaultKvRawReadPort {
  return {
    kvReadRaw: async (): Promise<Record<string, unknown>> => {
      const raw = await readFile(path, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new FieldKeyBootError(`keyset file ${path} must contain a JSON object`);
      }
      return parsed as Record<string, unknown>;
    },
  };
}

/** The FileKvReader filename rule (ADR-0071): every non-alphanumeric path char → '_'. */
function sanitizeAgentFileName(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "_");
}

/** Startup self-check: one encrypt→decrypt probe through the GLOBAL codec under the just-installed
 *  registry — proves key material + AAD wiring end-to-end before any real audit row depends on it. */
function selfCheck(): void {
  const probe = { field_key_boot_self_check: true };
  const ct = encryptAuditJsonBytea(probe, AUDIT_BEFORE_AAD);
  const back = decryptAuditJsonBytea(ct, AUDIT_BEFORE_AAD);
  if (JSON.stringify(back) !== JSON.stringify(probe)) {
    throw new FieldKeyBootError("field-encryption startup self-check failed: probe did not round-trip");
  }
}
