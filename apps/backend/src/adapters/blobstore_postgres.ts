/**
 * Production Postgres-backed BlobStore adapter (Sprint 5 / S5.1.7).
 *
 * This is the REAL, ALWAYS-ON production blob store the worker wires into the `LlmClient` — NOT a
 * stub, mock, or no-op. The `InMemoryBlobStoreAdapter` test double (in
 * `test/support/llm/cassette_sdk.ts`) is the cassette-replay equivalent; the production
 * `LlmClientCache.defaultClientFactory` injects an instance of THIS class. (`LlmClient` no longer
 * carries an in-module blob-store default — the `blobStore` constructor arg is REQUIRED, so an
 * un-injected blob store is a wiring bug, not a silent fall-through to discarding bytes.)
 *
 * ## What it does
 *
 * `put` zstd-compresses the body, enforces the 50 MiB cap on the UNCOMPRESSED size, and `INSERT`s the
 * compressed bytes into `telemetry.llm_payloads` (RANGE-partitioned monthly on `created_at`, 30-day
 * retention) together with `installation_id`, `key`, `content_type`, the uncompressed byte size, and
 * the `created_at` instant. It returns a {@link BlobRef} — the opaque handle the application stores in
 * lieu of the bytes. `get(ref)` reads the most-recent row for `(installation_id, key)` and decompresses
 * it; `delete(ref)` removes every row for `(installation_id, key)`.
 *
 * ## Compression (node:zlib zstd — NO new dependency)
 *
 * Node 22+ ships zstd in the standard library (`node:zlib::zstdCompressSync` / `zstdDecompressSync`);
 * this repo runs Node 25, so we use `params: { [ZSTD_c_compressionLevel]: 3 }` (level 3).
 * No third-party compression dependency is added (spine-whitelist clean).
 *
 * ## Concurrency / connection contract (ADR-0062)
 *
 * Each call runs over the SHARED single-pool Kysely seam ({@link tenantKysely} / {@link getPool}); the
 * `INSERT` / `SELECT` / `DELETE` execute on a pool connection. The `pg.Pool` is NEVER created per call.
 *
 * ## Tenancy (telemetry.llm_payloads is per-installation but NOT in TENANT_SCOPED_TABLES)
 *
 * `telemetry.llm_payloads` carries an `installation_id` column and EVERY query below filters on it
 * (`WHERE installation_id = …` / `INTO … (installation_id, …)`), so the raw-SQL tenancy idiom is the
 * preferred "installation_id token in the SQL" escape hatch — no `tenant:exempt` marker is needed (the
 * table is also absent from `TENANT_SCOPED_TABLES`, so the runtime plugin does not police it; it is a
 * cold-tier telemetry payload archive, not a hot tenant table).
 *
 * ## Clock seam
 *
 * The injected {@link Clock} authors `created_at` on the write. The `blob_id` UUID is minted via the
 * platform {@link SystemRandom} seam. No raw `Date` / `Math.random` is used (the `check_clock_random`
 * gate is satisfied; the only `node:crypto` randomness is inside the sanctioned randomness seam).
 */

import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { type Kysely, sql } from "kysely";

import { type Clock, WallClock } from "#platform/clock.js";
import { tenantKysely } from "#platform/db/database.js";
import { SystemRandom } from "#platform/randomness.js";

import { BlobRef } from "#contracts/blob_ref.v1.js";

// ─── Constants ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Body-size cap (50 MiB). Enforced on the UNCOMPRESSED body, so a body whose compressed form would fit
 * is still rejected if its raw size exceeds the cap — the cap protects the Postgres TOAST from oversized
 * blobs regardless of compressibility.
 */
export const MAX_BLOB_BYTES = 50 * 1024 * 1024;

/** zstd compression level. */
const ZSTD_COMPRESSION_LEVEL = 3;

// ─── Typed errors ────────────────────────────────────────────────────────────────────────────────────

/** Base for all BlobStore failures. */
export class BlobStoreError extends Error {
  public constructor(message?: string) {
    super(message);
    this.name = "BlobStoreError";
  }
}

/**
 * Raised when `get` cannot find the referenced blob. A cross-tenant `get` (a different
 * `installation_id`) also raises this rather than a distinct access-denied error, so the existence of a
 * blob under another tenant does not leak.
 */
export class BlobNotFoundError extends BlobStoreError {
  public constructor(message?: string) {
    super(message);
    this.name = "BlobNotFoundError";
  }
}

/** Raised when `body` exceeds {@link MAX_BLOB_BYTES}. */
export class BlobTooLargeError extends BlobStoreError {
  public constructor(message?: string) {
    super(message);
    this.name = "BlobTooLargeError";
  }
}

/**
 * Raised when the underlying store is unreachable / refuses writes. The production Postgres adapter
 * raises this on pool exhaustion or a connectivity failure — every DB call below is wrapped so a driver
 * error surfaces as this typed error.
 */
export class BlobStoreUnavailableError extends BlobStoreError {
  public constructor(message?: string) {
    super(message);
    this.name = "BlobStoreUnavailableError";
  }
}

// ─── Row shape the raw `sql<T>` read materializes ────────────────────────────────────────────────────

/** `body_zstd` from a `telemetry.llm_payloads` read. pg returns `bytea` as a Node `Buffer`. */
type PayloadRow = {
  readonly body_zstd: Buffer;
};

// ─── Compression helpers (node:zlib zstd) ────────────────────────────────────────────────────────────

/** zstd-compress at level 3. Returns a `Buffer`. */
function compress(body: Uint8Array): Buffer {
  return zstdCompressSync(body, {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL },
  });
}

/** zstd-decompress. Returns a `Buffer`. */
function decompress(bodyZstd: Buffer): Buffer {
  return zstdDecompressSync(bodyZstd);
}

// ─── The adapter ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Production `BlobStorePort` writing zstd-compressed bytes into `telemetry.llm_payloads`.
 *
 * Structurally satisfies the `BlobStore` slice the {@link LlmClient} consumes (`put` only) AND the full
 * three-operation port (`put` / `get` / `delete`) the Python `BlobStorePort` Protocol defines.
 */
export class BlobStorePostgresAdapter {
  private readonly db: Kysely<unknown>;
  private readonly clock: Clock;
  private readonly random: SystemRandom;

  public constructor(args: { db: Kysely<unknown>; clock?: Clock }) {
    this.db = args.db;
    this.clock = args.clock ?? new WallClock();
    this.random = new SystemRandom();
  }

  /**
   * Build an adapter whose `Kysely` is the shared single-pool tenant Kysely for `dsn` (ADR-0062 seam).
   * The production `LlmClientCache` uses this to construct the always-on blob store from
   * `CODEMASTER_PG_CORE_DSN`.
   */
  public static fromDsn(args: { dsn: string; clock?: Clock }): BlobStorePostgresAdapter {
    return new BlobStorePostgresAdapter({
      db: tenantKysely<unknown>(args.dsn),
      // Spread only when present — `exactOptionalPropertyTypes` forbids an explicit `undefined`.
      ...(args.clock !== undefined ? { clock: args.clock } : {}),
    });
  }

  /**
   * Compress `body`, enforce the 50 MiB cap on the UNCOMPRESSED size, INSERT the compressed bytes into
   * `telemetry.llm_payloads`, and return the opaque {@link BlobRef}.
   *
   * @throws {@link BlobTooLargeError}         when `body` exceeds {@link MAX_BLOB_BYTES} (checked BEFORE
   *   compression, on the raw size).
   * @throws {@link BlobStoreUnavailableError} when the DB write fails (pool exhaustion / connectivity).
   */
  public async put(args: {
    installationId: string;
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<BlobRef> {
    const { installationId, key, body, contentType } = args;
    if (body.length > MAX_BLOB_BYTES) {
      throw new BlobTooLargeError(`body of ${body.length} bytes exceeds cap ${MAX_BLOB_BYTES}`);
    }
    const compressed = compress(body);
    const createdAt = this.clock.now();
    const blobId = this.uuid4();

    try {
      // tenancy: filtered on installation_id (the column is written explicitly in the INSERT target).
      await sql`
        INSERT INTO telemetry.llm_payloads
          (blob_id, installation_id, key, content_type, byte_size_uncompressed, body_zstd, created_at)
        VALUES (${blobId}::uuid, ${installationId}::uuid, ${key}, ${contentType},
                ${body.length}, ${compressed}, ${createdAt})
      `.execute(this.db);
    } catch (e) {
      throw new BlobStoreUnavailableError(errString(e));
    }

    return BlobRef.parse({
      schema_version: 1,
      installation_id: installationId,
      key,
      byte_size: body.length,
      content_type: contentType,
      created_at: createdAt.toISOString(),
    });
  }

  /**
   * Read the most-recent blob for `(installation_id, key)` and decompress it.
   *
   * @throws {@link BlobNotFoundError}         when no row exists for `(installation_id, key)`.
   * @throws {@link BlobStoreUnavailableError} when the DB read fails.
   */
  public async get(ref: BlobRef): Promise<Uint8Array> {
    let row: PayloadRow | undefined;
    try {
      const result = await sql<PayloadRow>`
        SELECT body_zstd FROM telemetry.llm_payloads
         WHERE installation_id = ${ref.installation_id}::uuid AND key = ${ref.key}
         ORDER BY created_at DESC LIMIT 1
      `.execute(this.db);
      row = result.rows[0];
    } catch (e) {
      throw new BlobStoreUnavailableError(errString(e));
    }

    if (row === undefined) {
      throw new BlobNotFoundError(
        `no blob at installation_id=${pyReprStr(ref.installation_id)} key=${pyReprStr(ref.key)}`,
      );
    }
    return new Uint8Array(decompress(Buffer.from(row.body_zstd)));
  }

  /**
   * Delete every row for `(installation_id, key)`.
   *
   * @throws {@link BlobStoreUnavailableError} when the DB write fails.
   */
  public async delete(ref: BlobRef): Promise<void> {
    try {
      await sql`
        DELETE FROM telemetry.llm_payloads
         WHERE installation_id = ${ref.installation_id}::uuid AND key = ${ref.key}
      `.execute(this.db);
    } catch (e) {
      throw new BlobStoreUnavailableError(errString(e));
    }
  }

  /** Mint a random RFC4122 v4 UUID via the platform randomness seam. */
  private uuid4(): string {
    const b = Buffer.from(this.random.tokenBytes(16));
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // RFC4122 variant
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }
}

// ─── small helpers ──────────────────────────────────────────────────────────────────────────────────

/** Stringify a thrown value for the `BlobStoreUnavailableError` message. */
function errString(e: unknown): string {
  if (e instanceof Error) {
    return e.message === "" ? e.name : e.message;
  }
  return String(e);
}

/** Single-quoted repr of a str: `\`→`\\`, `'`→`\'` (for the not-found message). */
function pyReprStr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
