// Phase 1 (migration 0008): core.embedder_provider_settings — the UI-writable singleton that holds the
// embedder base_url + model_name + field-codec api-key ciphertext (DB-backed embedder creds, parity with
// core.confluence_settings). This suite proves the SCHEMA invariants at the DB: raw INSERTs bypass the
// repo entirely (the "manual edit / future migration" threat, same posture as cost_journal_schema):
//   (a) a minimal valid keyless row ACCEPTS and the DB defaults land (singleton, provider='openai_compat',
//       enabled, last_rotated_at, updated_at);
//   (b) a keyed row (ciphertext + 4-char fingerprint) ACCEPTS;
//   (c) provider != 'openai_compat' is REJECTED (eps_provider_valid — provider is server-owned);
//   (d) an empty base_url is REJECTED (eps_base_url_len);
//   (e) a model_name longer than 256 is REJECTED (eps_model_name_len);
//   (f) a HALF key (ciphertext set, fingerprint NULL) is REJECTED (eps_key_pair — both or neither);
//   (g) a fingerprint whose length != 4 is REJECTED (eps_fingerprint_4);
//   (h) a validation status outside {ok,failed} is REJECTED (eps_validation_state);
//   (i) a SECOND row is REJECTED (eps_singleton_uq — the table is a platform singleton).
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (a disposable DB) — never a shared cluster.
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeEach, expect, it } from "vitest";
import { describeDb, INTEGRATION_DSN } from "../_db.js";

let db: Kysely<unknown>;
let pool: Pool;
if (INTEGRATION_DSN) {
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}

const BASE_URL = "http://embedder.local:8080/v1";
const MODEL = "qwen3-embed-0.6b";

beforeEach(async () => {
  // Singleton table: clear it so each test starts from an empty corpus of settings.
  if (db) {
    await sql`DELETE FROM core.embedder_provider_settings`.execute(db);
  }
});

afterAll(async () => {
  if (db) {
    await sql`DELETE FROM core.embedder_provider_settings`.execute(db);
    await db.destroy();
  }
});

describeDb("core.embedder_provider_settings schema (migration 0008)", () => {
  it("(a) ACCEPTS a minimal keyless row; the DB defaults land", async () => {
    await sql`
      INSERT INTO core.embedder_provider_settings (base_url, model_name)
      VALUES (${BASE_URL}, ${MODEL})
    `.execute(db);
    const r = await sql<{
      singleton: boolean;
      provider: string;
      enabled: boolean;
      api_key_ciphertext: string | null;
      api_key_fingerprint: string | null;
      last_rotated_at: Date;
      updated_at: Date;
      last_validation_status: string | null;
    }>`SELECT * FROM core.embedder_provider_settings`.execute(db);
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.singleton).toBe(true);
    expect(row.provider).toBe("openai_compat");
    expect(row.enabled).toBe(true);
    expect(row.api_key_ciphertext).toBeNull();
    expect(row.api_key_fingerprint).toBeNull();
    expect(row.last_rotated_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
    expect(row.last_validation_status).toBeNull();
  });

  it("(b) ACCEPTS a keyed row (ciphertext + 4-char fingerprint)", async () => {
    await sql`
      INSERT INTO core.embedder_provider_settings (base_url, model_name, api_key_ciphertext, api_key_fingerprint)
      VALUES (${BASE_URL}, ${MODEL}, ${"kms2:v1:abc123"}, ${"ab12"})
    `.execute(db);
    const r = await sql<{ api_key_fingerprint: string }>`
      SELECT api_key_fingerprint FROM core.embedder_provider_settings
    `.execute(db);
    expect(r.rows[0]!.api_key_fingerprint).toBe("ab12");
  });

  it("(c) REJECTS a provider other than 'openai_compat' (server-owned)", async () => {
    await expect(
      sql`
        INSERT INTO core.embedder_provider_settings (provider, base_url, model_name)
        VALUES (${"bedrock"}, ${BASE_URL}, ${MODEL})
      `.execute(db),
    ).rejects.toThrow(/eps_provider_valid/);
  });

  it("(d) REJECTS an empty base_url", async () => {
    await expect(
      sql`
        INSERT INTO core.embedder_provider_settings (base_url, model_name)
        VALUES (${""}, ${MODEL})
      `.execute(db),
    ).rejects.toThrow(/eps_base_url_len/);
  });

  it("(e) REJECTS a model_name longer than 256 chars", async () => {
    await expect(
      sql`
        INSERT INTO core.embedder_provider_settings (base_url, model_name)
        VALUES (${BASE_URL}, ${"m".repeat(257)})
      `.execute(db),
    ).rejects.toThrow(/eps_model_name_len/);
  });

  it("(f) REJECTS a half key (ciphertext set, fingerprint NULL)", async () => {
    await expect(
      sql`
        INSERT INTO core.embedder_provider_settings (base_url, model_name, api_key_ciphertext)
        VALUES (${BASE_URL}, ${MODEL}, ${"kms2:v1:abc"})
      `.execute(db),
    ).rejects.toThrow(/eps_key_pair/);
  });

  it("(g) REJECTS a fingerprint whose length != 4", async () => {
    await expect(
      sql`
        INSERT INTO core.embedder_provider_settings (base_url, model_name, api_key_ciphertext, api_key_fingerprint)
        VALUES (${BASE_URL}, ${MODEL}, ${"kms2:v1:abc"}, ${"abc"})
      `.execute(db),
    ).rejects.toThrow(/eps_fingerprint_4/);
  });

  it("(h) REJECTS a validation status outside {ok,failed}", async () => {
    await expect(
      sql`
        INSERT INTO core.embedder_provider_settings (base_url, model_name, last_validation_status)
        VALUES (${BASE_URL}, ${MODEL}, ${"pending"})
      `.execute(db),
    ).rejects.toThrow(/eps_validation_state/);
  });

  it("(i) REJECTS a SECOND row (platform singleton)", async () => {
    await sql`
      INSERT INTO core.embedder_provider_settings (base_url, model_name)
      VALUES (${BASE_URL}, ${MODEL})
    `.execute(db);
    await expect(
      sql`
        INSERT INTO core.embedder_provider_settings (base_url, model_name)
        VALUES (${BASE_URL}, ${"second-model"})
      `.execute(db),
    ).rejects.toThrow(/eps_singleton_uq/);
  });
});
