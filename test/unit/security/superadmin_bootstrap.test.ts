import { describe, expect, it } from "vitest";

import { InMemoryLocalUserRepo, type LocalUser } from "#backend/api/auth/local_user_repo.js";
import {
  bootstrapSuperAdmin,
  DEFAULT_SUPERADMIN_PASSWORD,
  DEFAULT_SUPERADMIN_USERNAME,
} from "#backend/security/superadmin_bootstrap.js";

// Fast, deterministic stand-ins for argon2 (the bootstrap LOGIC is under test, not the hasher).
const fakeHash = (pw: string): Promise<string> => Promise.resolve(`hashed:${pw}`);
const fakeVerify = (h: string, pw: string): Promise<boolean> => Promise.resolve(h === `hashed:${pw}`);
const NOW = new Date("2026-06-13T00:00:00.000Z");

function deps(repo: InMemoryLocalUserRepo, warnings: Array<string>) {
  let n = 0;
  return {
    repo,
    hashPassword: fakeHash,
    verifyPassword: fakeVerify,
    now: () => NOW,
    newUserId: () => `00000000-0000-0000-0000-00000000000${(n += 1)}`,
    warn: (m: string) => warnings.push(m),
  };
}

const ROTATED: LocalUser = {
  user_id: "11111111-1111-1111-1111-111111111111",
  username: "admin",
  email: "admin@codemaster.local",
  full_name: "Super Admin",
  password_hash: "hashed:not-the-default",
  role: "super_admin",
  state: "active",
  last_password_change: NOW,
  last_login_at: null,
  failed_attempts: 0,
  locked_until: null,
  created_at: NOW,
  created_by_user_id: null,
};

describe("bootstrapSuperAdmin", () => {
  it("first deploy (empty): creates admin/admin (super_admin, active) and WARNS", async () => {
    const repo = new InMemoryLocalUserRepo();
    const warnings: Array<string> = [];

    await bootstrapSuperAdmin(deps(repo, warnings));

    const admin = await repo.getByUsername({ username: DEFAULT_SUPERADMIN_USERNAME });
    expect(admin).not.toBeNull();
    expect(admin?.role).toBe("super_admin");
    expect(admin?.state).toBe("active");
    expect(await fakeVerify(admin!.password_hash, DEFAULT_SUPERADMIN_PASSWORD)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/default/i);
  });

  it("idempotent: an existing super-admin is never clobbered (no second insert)", async () => {
    const repo = new InMemoryLocalUserRepo();
    await repo.insert(ROTATED); // operator already rotated the password
    const warnings: Array<string> = [];

    await bootstrapSuperAdmin(deps(repo, warnings));

    expect(repo.allRows()).toHaveLength(1);
    expect(repo.allRows()[0]?.password_hash).toBe("hashed:not-the-default"); // unchanged
    expect(warnings).toHaveLength(0); // not the default → no warning
  });

  it("warns (does NOT block) when the existing 'admin' still uses the default password", async () => {
    const repo = new InMemoryLocalUserRepo();
    await repo.insert({ ...ROTATED, password_hash: "hashed:admin" }); // still default
    const warnings: Array<string> = [];

    await bootstrapSuperAdmin(deps(repo, warnings));

    expect(repo.allRows()).toHaveLength(1); // no new insert
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/default password/i);
  });

  it("re-seeds admin/admin when ALL super-admins were removed (lockout recovery)", async () => {
    const repo = new InMemoryLocalUserRepo();
    await repo.insert({ ...ROTATED, username: "ops", state: "disabled" }); // none active
    const warnings: Array<string> = [];

    await bootstrapSuperAdmin(deps(repo, warnings));

    expect(await repo.getByUsername({ username: DEFAULT_SUPERADMIN_USERNAME })).not.toBeNull();
  });

  it("RECOVERS from a DISABLED 'admin' row (no active super-admins) — reactivates + resets, no lockout", async () => {
    // The lockout the prior re-seed test missed: the disabled row IS 'admin' itself. A blind INSERT would
    // hit the unique-username constraint, the catch would see getByUsername('admin') != null (the disabled
    // row) and SWALLOW → platform left with ZERO active super-admins, reported as success.
    const repo = new InMemoryLocalUserRepo();
    await repo.insert({ ...ROTATED, state: "disabled", password_hash: "hashed:not-the-default" });
    const warnings: Array<string> = [];

    await bootstrapSuperAdmin(deps(repo, warnings));

    const active = await repo.listActiveSuperAdmins();
    expect(active).toHaveLength(1); // NOT zero — the platform can log in
    const admin = await repo.getByUsername({ username: DEFAULT_SUPERADMIN_USERNAME });
    expect(admin?.state).toBe("active");
    expect(await fakeVerify(admin!.password_hash, DEFAULT_SUPERADMIN_PASSWORD)).toBe(true); // reset to default
    expect(repo.allRows()).toHaveLength(1); // reactivated in place, not a duplicate row
    expect(warnings).toHaveLength(1);
  });

  it("recovers a LOCKED-OUT default 'admin' (failed_attempts maxed, locked_until set) → clears lockout", async () => {
    const repo = new InMemoryLocalUserRepo();
    await repo.insert({
      ...ROTATED,
      state: "disabled",
      failed_attempts: 99,
      locked_until: new Date("2099-01-01T00:00:00.000Z"),
    });
    const warnings: Array<string> = [];

    await bootstrapSuperAdmin(deps(repo, warnings));

    const admin = await repo.getByUsername({ username: DEFAULT_SUPERADMIN_USERNAME });
    expect(admin?.state).toBe("active");
    expect(admin?.failed_attempts).toBe(0);
    expect(admin?.locked_until).toBeNull();
  });
});
