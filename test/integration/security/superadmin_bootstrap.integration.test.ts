// Step 5 integration: the superadmin bootstrap against the real core.local_users — REAL argon2 hash +
// field-codec-encrypted email. Runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb gate).
// Owns the local_users table for the run (delete-all in beforeEach/afterAll) so listActiveSuperAdmins
// starts empty — vitest runs each file's lifecycle bracketed, so no other suite's rows are live here.

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PostgresLocalUserRepo } from "#backend/api/auth/local_user_repo.js";
import { hashPassword, verifyPassword } from "#backend/api/auth/password_hasher.js";
import {
  bootstrapSuperAdmin,
  DEFAULT_SUPERADMIN_PASSWORD,
  DEFAULT_SUPERADMIN_USERNAME,
} from "#backend/security/superadmin_bootstrap.js";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { uuid4 } from "#platform/randomness.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-13T00:00:00.000Z");
const reg = new KeyRegistry();
reg.set(makeKeySet({ currentVersion: "v1", keys: new Map([["v1", new Uint8Array(32).fill(8)]]) }));

let pool: Pool;
let db: Kysely<unknown>;
let repo: PostgresLocalUserRepo;

const run = (warnings: Array<string>): Promise<void> =>
  bootstrapSuperAdmin({
    repo,
    hashPassword,
    verifyPassword,
    now: () => NOW,
    newUserId: () => uuid4(),
    warn: (m) => warnings.push(m),
  });

describeDb("superadmin bootstrap (integration)", () => {
  beforeAll(() => {
    if (!INTEGRATION_DSN) return;
    pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    repo = new PostgresLocalUserRepo({ db, registry: reg });
  });
  beforeEach(async () => {
    await sql`DELETE FROM core.local_users`.execute(db);
  });
  afterAll(async () => {
    await sql`DELETE FROM core.local_users`.execute(db);
    await db?.destroy();
  });

  it("first deploy: creates admin/admin (super_admin; argon2 hash verifies; email encrypted at rest)", async () => {
    const warnings: Array<string> = [];
    await run(warnings);

    const admin = await repo.getByUsername({ username: DEFAULT_SUPERADMIN_USERNAME });
    expect(admin?.role).toBe("super_admin");
    expect(admin?.state).toBe("active");
    expect(admin?.email).toBe("admin@codemaster.local"); // decrypts via the registry
    expect(await verifyPassword(admin!.password_hash, DEFAULT_SUPERADMIN_PASSWORD)).toBe(true);
    expect(admin!.password_hash.startsWith("$argon2")).toBe(true);

    const row = await sql<{ email_ciphertext: string }>`
      SELECT email_ciphertext FROM core.local_users WHERE username = ${DEFAULT_SUPERADMIN_USERNAME}
    `.execute(db);
    expect(row.rows[0]?.email_ciphertext).not.toContain("admin@codemaster.local"); // ciphertext at rest
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/default/i);
  });

  it("idempotent: a second boot does not create a second row", async () => {
    await run([]);
    await run([]);
    const r = await sql<{ n: string }>`
      SELECT count(*) AS n FROM core.local_users WHERE username = ${DEFAULT_SUPERADMIN_USERNAME}
    `.execute(db);
    expect(Number(r.rows[0]?.n ?? "0")).toBe(1);
  });

  it("recovers a DISABLED 'admin' (real reactivateWithPassword UPDATE) — no lockout, no duplicate", async () => {
    // Seed admin, then disable it directly → zero active super-admins (the real lockout state). A blind
    // re-insert would hit uq_local_users_username; bootstrap must reactivate the existing row in place.
    await run([]);
    await sql`UPDATE core.local_users SET state = 'disabled', failed_attempts = 5, password_hash = 'x'
              WHERE username = ${DEFAULT_SUPERADMIN_USERNAME}`.execute(db);
    expect(await repo.listActiveSuperAdmins()).toHaveLength(0);

    const warnings: Array<string> = [];
    await run(warnings); // must NOT throw, must recover

    const admin = await repo.getByUsername({ username: DEFAULT_SUPERADMIN_USERNAME });
    expect(admin?.state).toBe("active");
    expect(admin?.failed_attempts).toBe(0);
    expect(await verifyPassword(admin!.password_hash, DEFAULT_SUPERADMIN_PASSWORD)).toBe(true);
    const count = await sql<{ n: string }>`
      SELECT count(*) AS n FROM core.local_users WHERE username = ${DEFAULT_SUPERADMIN_USERNAME}
    `.execute(db);
    expect(Number(count.rows[0]?.n ?? "0")).toBe(1); // reactivated in place, not duplicated
    expect(await repo.listActiveSuperAdmins()).toHaveLength(1);
  });
});
