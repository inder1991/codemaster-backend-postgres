// Real-DB integration test for PostgresAuthSecretsRepo (go-live review P0). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set. Proves the field-codec round-trip, ciphertext-at-rest, and — critically —
// that ensure() is idempotent (a second ensure NEVER regenerates), the convergence property that keeps all
// replicas on one keypair.

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PostgresAuthSecretsRepo } from "#backend/api/auth/auth_secrets_repo.js";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

describeDb("PostgresAuthSecretsRepo (integration)", () => {
  const registry = new KeyRegistry();
  registry.set(makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(9)]]) }));
  const repo = new PostgresAuthSecretsRepo({
    db: tenantKysely<unknown>(INTEGRATION_DSN as string),
    registry,
  });
  const pool = getPool(INTEGRATION_DSN as string);
  const clean = (): Promise<unknown> => pool.query("DELETE FROM core.auth_secrets WHERE scope='platform'");

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM core.auth_secrets WHERE false");
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await disposeAllPools();
  });

  const SECRETS = { sessionSigningKey: "s".repeat(44), csrfSecret: "c".repeat(44) };

  it("read returns null when unconfigured", async () => {
    expect(await repo.read()).toBeNull();
  });

  it("ensure generates + persists when absent; secrets are ciphertext at rest", async () => {
    expect(await repo.ensure(() => SECRETS)).toEqual(SECRETS);
    expect(await repo.read()).toEqual(SECRETS);

    const row = await pool.query<{ s: string; c: string }>(
      "SELECT session_signing_key_ciphertext AS s, csrf_secret_ciphertext AS c FROM core.auth_secrets WHERE scope='platform'",
    );
    expect(row.rows[0]?.s.startsWith("kms2:")).toBe(true);
    expect(row.rows[0]?.c.startsWith("kms2:")).toBe(true);
    expect(row.rows[0]?.s).not.toContain(SECRETS.sessionSigningKey);
    expect(row.rows[0]?.c).not.toContain(SECRETS.csrfSecret);
  });

  it("ensure is idempotent — a second ensure NEVER regenerates (convergence across replicas)", async () => {
    const first = await repo.ensure(() => SECRETS);
    // A second ensure with a DIFFERENT generator must return the FIRST keypair, proving generate() is
    // only invoked when absent — so concurrent replicas all converge on the one persisted row.
    const second = await repo.ensure(() => ({ sessionSigningKey: "x".repeat(44), csrfSecret: "y".repeat(44) }));
    expect(second).toEqual(first);
  });
});
