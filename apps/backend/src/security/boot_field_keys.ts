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
//   vault       — VaultHttpPort.fromEnv() (VAULT_ADDR + VAULT_TOKEN / agent-token-file, OR SA-auth via
//                 CODEMASTER_VAULT_AUTH=kubernetes — review P0-B), the kvReadRaw path runServer uses.
//   vault-agent — the Agent-rendered keyset file `<CODEMASTER_VAULT_SECRETS_DIR|/vault/secrets>/
//                 codemaster_field_encryption_keys` (the FileKvReader sanitization rule applied to
//                 FIELD_ENCRYPTION_KEYS_VAULT_PATH; the flat-string FileKvReader itself cannot
//                 carry the NESTED keyset payload, so the file holds the raw keyset JSON).
//   file        — an explicit keyset JSON file at CODEMASTER_FIELD_KEYSET_FILE (dev/test).

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { cancellableSleep } from "#backend/runner/clock_async.js";
import type { RunnerDisposable } from "#backend/runner/disposables.js";

import type { Clock } from "#platform/clock.js";
import { decryptField } from "#platform/crypto/aes_gcm_aad.js";
import type { KeyRegistry } from "#platform/crypto/key_registry.js";
import { SystemRandom, type Random } from "#platform/randomness.js";

import {
  AUDIT_BEFORE_AAD,
  decryptAuditJsonBytea,
  encryptAuditJsonBytea,
  encryptJsonByteaWithRegistry,
  setAuditKeyRegistry,
} from "./audit_field_codec.js";
import {
  FIELD_ENCRYPTION_KEYS_VAULT_PATH,
  loadFieldEncryptionKeyRegistry,
  type VaultKvRawReadPort,
} from "./field_encryption_keys_loader.js";

const VALID_SOURCES = ["env", "vault", "vault-agent", "file"] as const;
export type FieldKeySource = (typeof VALID_SOURCES)[number];

/** The env var holding the keyset JSON when source=env (OpenShift Secret injected as env). */
export const FIELD_KEYSET_ENV = "CODEMASTER_FIELD_ENCRYPTION_KEYSET";

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
  const source = resolveFieldKeySource(env, deps.reader !== undefined);
  if (source === null) {
    return "skipped"; // dev/test with no explicit source: registry stays null, codec fail-closed
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

/**
 * Resolve the keyset source from env — the SHARED resolution {@link installFieldKeyRegistryAtBoot}
 * and {@link refreshFieldKeyRegistryOnce} both ride, so boot and refresh can never disagree about
 * where keys come from. Returns `null` for the dev/test no-source posture (skip), the production
 * default "vault" when unset, the validated explicit source otherwise; throws
 * {@link FieldKeyBootError} on a garbage value.
 */
export function resolveFieldKeySource(env: NodeJS.ProcessEnv, hasReaderOverride: boolean): FieldKeySource | null {
  const isProduction = env["NODE_ENV"] === "production";
  const rawSource = env["CODEMASTER_FIELD_KEY_SOURCE"];
  if (rawSource === undefined || rawSource === "") {
    // No explicit field-key source: follow the one bootstrap-secret switch when it is set —
    // openshift → the keyset env var, vault → Vault — so operators set CODEMASTER_SECRET_SOURCE once.
    const secretSource = env["CODEMASTER_SECRET_SOURCE"];
    if (secretSource === "openshift") {
      return "env";
    }
    if (secretSource === "vault") {
      return "vault";
    }
    if (!isProduction && !hasReaderOverride) {
      return null;
    }
    return "vault"; // the production default — the registry MUST load
  }
  if ((VALID_SOURCES as ReadonlyArray<string>).includes(rawSource)) {
    return rawSource as FieldKeySource;
  }
  throw new FieldKeyBootError(
    `field-encryption key source '${rawSource}' is not valid: CODEMASTER_FIELD_KEY_SOURCE must be ` +
      `one of ${VALID_SOURCES.join(" | ")}`,
  );
}

/** Build the keyset reader for the resolved source. Every reader satisfies the loader's
 *  {@link VaultKvRawReadPort} shape so loadFieldEncryptionKeyRegistry stays the single parser. */
async function resolveReader(source: FieldKeySource, env: NodeJS.ProcessEnv): Promise<VaultKvRawReadPort> {
  switch (source) {
    case "env": {
      const raw = env[FIELD_KEYSET_ENV];
      if (raw === undefined || raw === "") {
        throw new FieldKeyBootError(
          `field-encryption key source 'env' requires ${FIELD_KEYSET_ENV} to hold the keyset JSON`,
        );
      }
      return envKeysetReader(raw);
    }
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

/** The keyset JSON carried in an env var (OpenShift Secret → env), adapted to the loader port.
 *  Content-free parse errors: the value is AES key material and must never reach the boot logs. */
function envKeysetReader(raw: string): VaultKvRawReadPort {
  return {
    kvReadRaw: (): Promise<Record<string, unknown>> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new FieldKeyBootError(`${FIELD_KEYSET_ENV} is not valid JSON`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new FieldKeyBootError(`${FIELD_KEYSET_ENV} must contain a JSON object`);
      }
      return Promise.resolve(parsed as Record<string, unknown>);
    },
  };
}

/** A keyset file holding the raw `{current_version, keys}` JSON, adapted to the loader port. */
function fileKeysetReader(path: string): VaultKvRawReadPort {
  return {
    kvReadRaw: async (): Promise<Record<string, unknown>> => {
      const raw = await readFile(path, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // CONTENT-FREE on purpose (FileKvReader's sterile-message rule): a V8 SyntaxError embeds a
        // snippet of the parsed input in its message, and this file's content is AES key material —
        // the raw error must never reach the boot logs the entrypoints' fail-loud catches print to.
        throw new FieldKeyBootError(`keyset file ${path} is not valid JSON`);
      }
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

// ─── W3.7 (EH4): the periodic key-rotation refresh ───────────────────────────────────────────────
//
// ADR-0033 / CLAUDE.md require the field-encryption keyset "refreshed every 30 min" (the Python
// worker lifespan ran this loop; the Confluence token provider's TS port got its 30-min loop —
// token_provider.ts refreshLoop — but the field keys did not). Without it a rotated Vault keyset
// (vN+1 added, current_version advanced) is invisible to long-lived pods: they keep ENCRYPTING
// under the old current_version and cannot DECRYPT rows newer pods wrote under vN+1
// (KeyNotFoundError → LocalKeyEncryptionError) until restarted — rotation becomes a fleet-wide
// rolling-restart event instead of a hot operation.
//
// Posture (the inverse of boot): boot is FAIL-LOUD (no keys → no pod); refresh is FAIL-OPEN on the
// REGISTRY (a refresh failure logs ONE structured WARN and KEEPS the previous, working registry —
// a transient Vault blip must never degrade a pod that is encrypting fine). The swap is atomic: the
// candidate registry is fully loaded AND probe-verified BEFORE the single setAuditKeyRegistry
// reference assignment; no reader can observe a half-built keyset.

/** The EH4 / ADR-0033 hot-rotation cadence: 30 minutes. */
export const FIELD_KEY_REFRESH_INTERVAL_SECONDS = 1800;
/** Anti-storm jitter (±5min uniform, the ConfluenceTokenProvider idiom) so a fleet of pods does
 *  not stampede Vault on synchronized 30-minute boundaries. */
export const FIELD_KEY_REFRESH_JITTER_SECONDS = 300;
/** The interval sleep is taken in ticks of at most this many seconds: Clock.sleep hands out no
 *  timer handle, so an aborted cancellableSleep leaves its underlying WallClock setTimeout pending
 *  — a single 30-minute sleep would hold the SIGTERM'd process's event loop open for up to 30
 *  minutes after dispose. Ticking bounds that residue to ≤60s (the runner loops' residue order). */
const REFRESH_SLEEP_TICK_SECONDS = 60;

/**
 * ONE refresh pass: re-resolve the source (the SAME resolution boot used), re-load the keyset,
 * probe-verify the CANDIDATE registry (never the global), and atomically swap it in via
 * setAuditKeyRegistry. NEVER throws: every failure path returns "kept-previous" after one
 * structured WARN — the previous registry stays installed untouched.
 */
export async function refreshFieldKeyRegistryOnce(
  env: NodeJS.ProcessEnv,
  deps: BootFieldKeyDeps = {},
): Promise<"refreshed" | "kept-previous"> {
  try {
    const source = resolveFieldKeySource(env, deps.reader !== undefined);
    if (source === null) {
      // Boot only starts the loop after an "installed" result, so a null source here is env drift
      // mid-flight — keep the working registry and say so.
      throw new FieldKeyBootError(
        "no field-encryption key source resolves anymore (CODEMASTER_FIELD_KEY_SOURCE drifted since boot)",
      );
    }
    const reader = deps.reader ?? (await resolveReader(source, env));
    const candidate = await loadFieldEncryptionKeyRegistry(reader);
    probeRegistry(candidate); // verify BEFORE the swap — an unprobed keyset never gets installed
    setAuditKeyRegistry(candidate); // ATOMIC: one reference assignment
    return "refreshed";
  } catch (e) {
    // Fail-open ON THE REGISTRY, loud on the log: the keyset loader/boot errors carry sterile,
    // content-free messages (the FileKvReader rule), so the message is safe to emit.
    console.warn(
      JSON.stringify({
        event: "field_key_refresh.failed",
        posture: "kept-previous-registry (a working registry is never degraded by a failed refresh)",
        error: (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 512),
      }),
    );
    return "kept-previous";
  }
}

/** Probe a CANDIDATE registry (explicit-registry round-trip — the global codec is not touched):
 *  encrypt→decrypt one fixture under the audit AAD and require byte-faithful JSON. */
function probeRegistry(candidate: KeyRegistry): void {
  const probe = { field_key_refresh_self_check: true };
  const ct = encryptJsonByteaWithRegistry(probe, AUDIT_BEFORE_AAD, candidate);
  if (ct === null) {
    throw new FieldKeyBootError("field-encryption refresh self-check failed: probe encrypt returned null");
  }
  const plaintext = decryptField({
    ciphertext: ct.toString("ascii"),
    registry: candidate,
    aad: AUDIT_BEFORE_AAD,
  });
  if (Buffer.from(plaintext).toString("utf-8") !== JSON.stringify(probe)) {
    throw new FieldKeyBootError("field-encryption refresh self-check failed: probe did not round-trip");
  }
}

/**
 * Start the supervised 30-minute refresh loop (W3.7 / EH4) and return its dispose handle — the
 * {@link RunnerDisposable} shape the runner boot registers on its DisposableRegistry so SIGTERM
 * teardown stops the loop (runner/disposables.ts). The loop sleeps `interval ± jitter` on the
 * INJECTED Clock via cancellableSleep (the same seam every runner loop uses; dispose() interrupts
 * an in-flight sleep immediately), then runs {@link refreshFieldKeyRegistryOnce} — which never
 * throws, so one bad cycle can never kill the loop (supervision is built into the pass).
 *
 * Call ONLY after installFieldKeyRegistryAtBoot returned "installed": refreshing a never-installed
 * registry is meaningless (dev/test no-source pods skip both).
 */
export function startFieldKeyRefreshLoop(o: {
  env: NodeJS.ProcessEnv;
  clock: Clock;
  /** Default {@link FIELD_KEY_REFRESH_INTERVAL_SECONDS} (1800). Tests inject a tiny interval. */
  intervalSeconds?: number;
  /** Default {@link FIELD_KEY_REFRESH_JITTER_SECONDS} (300). Tests pass 0 for exact cadences. */
  jitterSeconds?: number;
  /** The jitter RNG — the platform {@link Random} seam (default {@link SystemRandom}). */
  random?: Random;
  /** Test seam, threaded into every refresh pass (see {@link BootFieldKeyDeps}). */
  deps?: BootFieldKeyDeps;
}): RunnerDisposable {
  const intervalS = o.intervalSeconds ?? FIELD_KEY_REFRESH_INTERVAL_SECONDS;
  const jitterS = o.jitterSeconds ?? FIELD_KEY_REFRESH_JITTER_SECONDS;
  const rng = o.random ?? new SystemRandom();
  const stop = new AbortController();
  const loop = (async (): Promise<void> => {
    while (!stop.signal.aborted) {
      // interval ± jitter, floored (a degenerate jitter config must never busy-loop), slept in
      // ≤REFRESH_SLEEP_TICK_SECONDS ticks on the monotonic axis (see the tick constant's doc).
      const sleepS = Math.max(1e-3, intervalS + (rng.random() * 2 - 1) * jitterS);
      const wakeAt = o.clock.monotonic() + sleepS;
      while (!stop.signal.aborted) {
        const remainingS = wakeAt - o.clock.monotonic();
        if (remainingS <= 0) {
          break;
        }
        await cancellableSleep(o.clock, Math.min(remainingS, REFRESH_SLEEP_TICK_SECONDS), stop.signal);
      }
      if (stop.signal.aborted) {
        break;
      }
      await refreshFieldKeyRegistryOnce(o.env, o.deps ?? {}); // never throws (WARN + kept-previous)
    }
  })();
  return {
    name: "field-key-refresh-loop",
    dispose: async (): Promise<void> => {
      stop.abort();
      await loop;
    },
  };
}
