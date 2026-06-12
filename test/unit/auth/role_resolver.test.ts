import { describe, expect, it } from "vitest";

import { InMemoryRoleResolver, type RoleGrant } from "#backend/api/auth/role_resolver.js";

const USER = "11111111-1111-1111-1111-111111111111";
const INSTALL_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const INSTALL_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("InMemoryRoleResolver (parity with role_resolver.py)", () => {
  it("honors a platform-scope grant regardless of installation", async () => {
    const grants: Array<RoleGrant> = [
      { userId: USER, installationId: null, scope: "platform", role: "platform_owner" },
    ];
    const r = new InMemoryRoleResolver(grants);
    expect(await r.resolve({ userId: USER, installationId: INSTALL_A })).toBe("platform_owner");
    expect(await r.resolve({ userId: USER, installationId: INSTALL_B })).toBe("platform_owner");
  });

  it("honors an installation-scope grant ONLY for the matching installation", async () => {
    const grants: Array<RoleGrant> = [
      { userId: USER, installationId: INSTALL_A, scope: "installation", role: "reader" },
    ];
    const r = new InMemoryRoleResolver(grants);
    expect(await r.resolve({ userId: USER, installationId: INSTALL_A })).toBe("reader");
    expect(await r.resolve({ userId: USER, installationId: INSTALL_B })).toBeNull();
  });

  it("returns the HIGHEST-precedence role among multiple grants", async () => {
    const grants: Array<RoleGrant> = [
      { userId: USER, installationId: INSTALL_A, scope: "installation", role: "reader" },
      { userId: USER, installationId: null, scope: "platform", role: "platform_operator" },
      { userId: USER, installationId: null, scope: "platform", role: "platform_owner" },
    ];
    const r = new InMemoryRoleResolver(grants);
    expect(await r.resolve({ userId: USER, installationId: INSTALL_A })).toBe("platform_owner");
  });

  // W4.7 / EM4 — revocation honored at resolve time (deliberate parity-break from the frozen Python).
  it("EM4: ignores revoked grants (sole grant revoked → null; revoked higher falls back to active lower)", async () => {
    const revoked = new Date("2026-06-01T00:00:00.000Z");
    const r1 = new InMemoryRoleResolver([
      { userId: USER, installationId: null, scope: "platform", role: "platform_owner", revokedAt: revoked },
    ]);
    expect(await r1.resolve({ userId: USER, installationId: INSTALL_A })).toBeNull();
    const r2 = new InMemoryRoleResolver([
      { userId: USER, installationId: null, scope: "platform", role: "platform_owner", revokedAt: revoked },
      { userId: USER, installationId: INSTALL_A, scope: "installation", role: "reader" },
    ]);
    expect(await r2.resolve({ userId: USER, installationId: INSTALL_A })).toBe("reader");
  });

  it("ignores grants for other users and returns null when none match", async () => {
    const grants: Array<RoleGrant> = [
      { userId: "ffffffff-ffff-ffff-ffff-ffffffffffff", installationId: null, scope: "platform", role: "reader" },
    ];
    const r = new InMemoryRoleResolver(grants);
    expect(await r.resolve({ userId: USER, installationId: INSTALL_A })).toBeNull();
    expect(await new InMemoryRoleResolver([]).resolve({ userId: USER, installationId: INSTALL_A })).toBeNull();
  });
});
