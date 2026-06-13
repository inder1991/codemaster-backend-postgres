/**
 * ADR-0033 — in-memory key version registry.
 *
 * Holds the field-encryption key versions populated at pod startup (by the key loader, ported
 * separately) and consumed by the AES-256-GCM crypto layer in `./aes_gcm_aad.ts`. The registry is
 * the seam between key-source-of-truth (Vault KV) and crypto-operations (AES-GCM).
 *
 * Reads return immutable snapshots so callers can't mutate registry state by accident.
 *
 * DIVERGENCE (threading): Python guards reads/writes with a `threading.Lock` because CPython runs
 * the crypto layer across worker threads. Node is single-threaded for JS execution (no shared-memory
 * data races on a plain class field), so no lock is needed and none is ported. The
 * immutable-snapshot semantics — frozen key map, current()/get() returning copies of scalar state —
 * are preserved.
 */

const AES_256_KEY_BYTES = 32;

/** Raised when a ciphertext refers to a key version not currently loaded (e.g. a row encrypted
 *  under v1 but the pod only has v2 loaded). Mirrors Python's `KeyNotFoundError(LookupError)`. */
export class KeyNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "KeyNotFoundError";
  }
}

/** Raised when `current()` is called before the registry has been populated (loader not run at
 *  startup, or boot failed). Mirrors Python's `NoCurrentKeyError(LookupError)`. */
export class NoCurrentKeyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NoCurrentKeyError";
  }
}

/**
 * Immutable snapshot of all currently-loaded key versions. Construct via {@link makeKeySet}, which
 * enforces the invariants and freezes a private copy of the key map. Mirrors the Python
 * `@dataclass(frozen=True)` + `__post_init__` validation.
 */
export type KeySet = {
  readonly currentVersion: string;
  readonly keys: ReadonlyMap<string, Uint8Array>;
};

/**
 * Validate + freeze a {@link KeySet}. Invariants (mirror Python `KeySet.__post_init__`):
 *   * `keys` must be non-empty.
 *   * `currentVersion` must be a key in `keys`.
 *   * Every key must be exactly 32 bytes (AES-256).
 *
 * Freezes a private copy of the input map (mirroring `MappingProxyType(dict(self.keys))`) so a
 * caller mutating the original map after construction cannot leak through.
 */
export function makeKeySet({
  currentVersion,
  keys,
}: {
  currentVersion: string;
  keys: ReadonlyMap<string, Uint8Array>;
}): KeySet {
  if (keys.size === 0) {
    throw new Error("KeySet must contain at least one key version");
  }
  if (!keys.has(currentVersion)) {
    const available = [...keys.keys()].sort();
    throw new Error(
      `current_version='${currentVersion}' not in keys (available: ${JSON.stringify(available)})`,
    );
  }
  for (const [version, key] of keys) {
    if (key.length !== AES_256_KEY_BYTES) {
      throw new Error(
        `key version '${version}' is ${key.length} bytes; AES-256-GCM requires ${AES_256_KEY_BYTES}`,
      );
    }
  }
  // Freeze a private copy so post-construction mutation of the caller's map can't leak in.
  const frozen = new Map(keys);
  return { currentVersion, keys: frozen };
}

/**
 * Holder for the current {@link KeySet}. Populated by the key loader at startup + on periodic
 * refresh; read by the AES-256-GCM encrypt/decrypt in `./aes_gcm_aad.ts`.
 */
export class KeyRegistry {
  private keyset: KeySet | null = null;

  /** Atomically replace the loaded key set. */
  public set(keyset: KeySet): void {
    this.keyset = keyset;
  }

  /** Return `{ version, key }` for the current write key. Throws {@link NoCurrentKeyError} when
   *  the registry has not been populated. */
  public current(): { version: string; key: Uint8Array } {
    const ks = this.keyset;
    if (ks === null) {
      throw new NoCurrentKeyError(
        "field-encryption keys not loaded; " +
          "call load_field_encryption_keys_at_startup() before use",
      );
    }
    return { version: ks.currentVersion, key: ks.keys.get(ks.currentVersion)! };
  }

  /** Return the set of currently-loaded key versions, or an empty set if unpopulated. Returns a
   *  fresh set so callers cannot mutate registry state. */
  public versions(): ReadonlySet<string> {
    const ks = this.keyset;
    if (ks === null) {
      return new Set<string>();
    }
    return new Set(ks.keys.keys());
  }

  /**
   * Return the key bytes for a specific version (for decrypting ciphertexts under that version).
   *
   * Throws {@link KeyNotFoundError} whenever the requested version is unavailable — whether the
   * registry is unpopulated or the version simply isn't loaded. Decrypt callers only care that the
   * key isn't there; they don't distinguish "empty registry" from "missing version". `current()`
   * keeps the {@link NoCurrentKeyError} surface because *write* callers benefit from that
   * distinction. Mirrors the Python `get()` vs `current()` error split exactly.
   */
  public get(version: string): Uint8Array {
    const ks = this.keyset;
    if (ks === null || !ks.keys.has(version)) {
      const available = ks !== null ? [...ks.keys.keys()].sort() : [];
      throw new KeyNotFoundError(
        `key version '${version}' not loaded (available: ${JSON.stringify(available)})`,
      );
    }
    return ks.keys.get(version)!;
  }
}
