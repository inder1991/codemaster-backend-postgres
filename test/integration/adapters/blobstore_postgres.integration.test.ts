import { randomUUID } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  BlobNotFoundError,
  BlobStorePostgresAdapter,
  BlobTooLargeError,
  MAX_BLOB_BYTES,
} from "#backend/adapters/blobstore_postgres.js";

import { FakeClock } from "#platform/clock.js";

import { BlobRef } from "#contracts/blob_ref.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test for the PRODUCTION (Kysely-seam) BlobStorePostgresAdapter against a
// DISPOSABLE Postgres (telemetry.llm_payloads already migrated). Runs ONLY when CODEMASTER_PG_CORE_DSN
// is set (via describeDb); SKIPS otherwise so validate-fast stays green without a DB. We NEVER touch
// any other DB. Each test owns a UNIQUE installation_id + key so its rows are isolated, and cleans them
// up in a finally.

const FIXED_CLOCK = new FakeClock({ now: new Date("2026-06-01T00:00:00.000Z") });

let pool: Pool;
let db: Kysely<unknown>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  // ADR-0062: ONE memoized pool for the whole file — never a pool per call.
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy(); // ends the pool it wraps
});

/** Delete every llm_payloads row for one installation_id (scope-keyed cleanup). */
async function cleanup(installationId: string): Promise<void> {
  await sql`DELETE FROM telemetry.llm_payloads WHERE installation_id = ${installationId}::uuid`.execute(
    db,
  );
}

describeDb("BlobStorePostgresAdapter (production, Kysely seam, disposable PG)", () => {
  it("put → get round-trips through a real zstd-compressed llm_payloads row", async () => {
    const installationId = randomUUID();
    const adapter = new BlobStorePostgresAdapter({ db, clock: FIXED_CLOCK });
    // A compressible body so we can also assert the stored bytes are SMALLER than the input.
    const body = new TextEncoder().encode(JSON.stringify({ hello: "world".repeat(500) }));
    try {
      const ref = await adapter.put({
        installationId,
        key: "llm-payloads/req-1/request.json",
        body,
        contentType: "application/json",
      });

      // The returned BlobRef is a well-formed contract instance with the uncompressed byte size.
      expect(BlobRef.parse(ref)).toEqual(ref);
      expect(ref.installation_id).toBe(installationId);
      expect(ref.key).toBe("llm-payloads/req-1/request.json");
      expect(ref.byte_size).toBe(body.length);
      expect(ref.content_type).toBe("application/json");

      // The row persisted: installation_id, key, content_type, byte_size_uncompressed, compressed body.
      const rows = await sql<{
        key: string;
        content_type: string;
        byte_size_uncompressed: string;
        body_zstd: Buffer;
      }>`
        SELECT key, content_type, byte_size_uncompressed, body_zstd
          FROM telemetry.llm_payloads WHERE installation_id = ${installationId}::uuid
      `.execute(db);
      expect(rows.rows.length).toBe(1);
      const row = rows.rows[0]!;
      expect(row.key).toBe("llm-payloads/req-1/request.json");
      expect(row.content_type).toBe("application/json");
      expect(Number(row.byte_size_uncompressed)).toBe(body.length);
      // Stored bytes are zstd-compressed (smaller than the highly-repetitive input) and decompress back.
      expect(row.body_zstd.length).toBeLessThan(body.length);
      expect(Buffer.from(zstdDecompressSync(Buffer.from(row.body_zstd)))).toEqual(Buffer.from(body));

      // get(ref) decompresses to the exact original bytes.
      const fetched = await adapter.get(ref);
      expect(Buffer.from(fetched)).toEqual(Buffer.from(body));
    } finally {
      await cleanup(installationId);
    }
  });

  it("get returns the MOST-RECENT row for (installation_id, key) when the key is rewritten", async () => {
    const installationId = randomUUID();
    const clockV1 = new FakeClock({ now: new Date("2026-06-01T00:00:00.000Z") });
    const clockV2 = new FakeClock({ now: new Date("2026-06-01T01:00:00.000Z") });
    const adapterV1 = new BlobStorePostgresAdapter({ db, clock: clockV1 });
    const adapterV2 = new BlobStorePostgresAdapter({ db, clock: clockV2 });
    const key = "llm-payloads/shared/response.json";
    try {
      await adapterV1.put({
        installationId,
        key,
        body: new TextEncoder().encode("older"),
        contentType: "application/json",
      });
      const ref = await adapterV2.put({
        installationId,
        key,
        body: new TextEncoder().encode("newer"),
        contentType: "application/json",
      });
      // ORDER BY created_at DESC LIMIT 1 → the newer body.
      const fetched = await adapterV2.get(ref);
      expect(new TextDecoder().decode(fetched)).toBe("newer");
    } finally {
      await cleanup(installationId);
    }
  });

  it("delete removes every row for (installation_id, key); a subsequent get raises BlobNotFoundError", async () => {
    const installationId = randomUUID();
    const adapter = new BlobStorePostgresAdapter({ db, clock: FIXED_CLOCK });
    const key = "llm-payloads/to-delete/request.json";
    try {
      const ref = await adapter.put({
        installationId,
        key,
        body: new TextEncoder().encode("delete me"),
        contentType: "application/json",
      });
      await adapter.delete(ref);
      await expect(adapter.get(ref)).rejects.toBeInstanceOf(BlobNotFoundError);
    } finally {
      await cleanup(installationId);
    }
  });

  it("get for an absent (installation_id, key) raises BlobNotFoundError without leaking existence", async () => {
    const adapter = new BlobStorePostgresAdapter({ db, clock: FIXED_CLOCK });
    const ref = BlobRef.parse({
      schema_version: 1,
      installation_id: randomUUID(),
      key: "llm-payloads/never-written/request.json",
      byte_size: 0,
      content_type: "application/json",
      created_at: "2026-06-01T00:00:00.000Z",
    });
    await expect(adapter.get(ref)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("rejects a body over the 50 MiB cap with BlobTooLargeError BEFORE any DB write", async () => {
    const installationId = randomUUID();
    const adapter = new BlobStorePostgresAdapter({ db, clock: FIXED_CLOCK });
    // One byte over the cap. We don't actually allocate 50 MiB of meaningful content — a zero-filled
    // buffer of MAX_BLOB_BYTES + 1 is enough to trip the size guard (which runs before compression).
    const tooBig = new Uint8Array(MAX_BLOB_BYTES + 1);
    try {
      await expect(
        adapter.put({
          installationId,
          key: "llm-payloads/oversized/request.json",
          body: tooBig,
          contentType: "application/json",
        }),
      ).rejects.toBeInstanceOf(BlobTooLargeError);

      // No row was written — the cap is enforced before the INSERT.
      const rows = await sql<{ blob_id: string }>`
        SELECT blob_id FROM telemetry.llm_payloads WHERE installation_id = ${installationId}::uuid
      `.execute(db);
      expect(rows.rows.length).toBe(0);
    } finally {
      await cleanup(installationId);
    }
  });

  it("a body exactly AT the cap is accepted (boundary: == MAX is allowed, only > MAX rejected)", async () => {
    const installationId = randomUUID();
    const adapter = new BlobStorePostgresAdapter({ db, clock: FIXED_CLOCK });
    // Exactly the cap. Zero-filled → compresses to a tiny zstd payload, so the DB write is cheap.
    const atCap = new Uint8Array(MAX_BLOB_BYTES);
    try {
      const ref = await adapter.put({
        installationId,
        key: "llm-payloads/at-cap/request.json",
        body: atCap,
        contentType: "application/octet-stream",
      });
      expect(ref.byte_size).toBe(MAX_BLOB_BYTES);
      const back = await adapter.get(ref);
      expect(back.length).toBe(MAX_BLOB_BYTES);
    } finally {
      await cleanup(installationId);
    }
  });
});
