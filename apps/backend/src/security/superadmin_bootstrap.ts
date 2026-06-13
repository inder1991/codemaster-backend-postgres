// Superadmin bootstrap (go-live Step 5). On first deploy the platform MUST have a usable admin login
// without any operator action: seed a CONSTANT super-admin (admin / admin) the operator changes via the
// UI afterward. WARN-only — a default password never BLOCKS boot (the owner's explicit choice). Idempotent:
// an existing super-admin is never clobbered; an empty active set (first deploy OR all super-admins removed)
// re-seeds admin/admin so the platform can't lock itself out of its own admin console.

import { type LocalUserRepo } from "#backend/api/auth/local_user_repo.js";

export const DEFAULT_SUPERADMIN_USERNAME = "admin";
export const DEFAULT_SUPERADMIN_PASSWORD = "admin";
const DEFAULT_SUPERADMIN_EMAIL = "admin@codemaster.local";

export type SuperAdminBootstrapDeps = {
  readonly repo: LocalUserRepo;
  readonly hashPassword: (password: string) => Promise<string>;
  readonly verifyPassword: (storedHash: string, password: string) => Promise<boolean>;
  readonly now: () => Date;
  readonly newUserId: () => string;
  /** Loud, structured warning sink (no forced password change — warn only). */
  readonly warn: (message: string) => void;
};

/** Ensure a super-admin exists (constant admin/admin on first deploy, UI-changeable after) and warn —
 *  never block — while the default password is still in use. */
export async function bootstrapSuperAdmin(deps: SuperAdminBootstrapDeps): Promise<void> {
  const active = await deps.repo.listActiveSuperAdmins();
  if (active.length === 0) {
    await seedDefault(deps);
    return;
  }
  // A super-admin already exists — NEVER clobber it. Warn iff 'admin' still uses the default password.
  const admin = await deps.repo.getByUsername({ username: DEFAULT_SUPERADMIN_USERNAME });
  if (
    admin !== null &&
    admin.state === "active" &&
    (await deps.verifyPassword(admin.password_hash, DEFAULT_SUPERADMIN_PASSWORD))
  ) {
    deps.warn(
      `superadmin bootstrap: the '${DEFAULT_SUPERADMIN_USERNAME}' account STILL uses the default ` +
        `password — change it via the UI to secure the platform.`,
    );
  }
}

async function seedDefault(deps: SuperAdminBootstrapDeps): Promise<void> {
  const now = deps.now();
  try {
    await deps.repo.insert({
      user_id: deps.newUserId(),
      username: DEFAULT_SUPERADMIN_USERNAME,
      email: DEFAULT_SUPERADMIN_EMAIL,
      full_name: "Super Admin",
      password_hash: await deps.hashPassword(DEFAULT_SUPERADMIN_PASSWORD),
      role: "super_admin",
      state: "active",
      last_password_change: now,
      last_login_at: null,
      failed_attempts: 0,
      locked_until: null,
      created_at: now,
      created_by_user_id: null,
    });
  } catch (e) {
    // Concurrent boot: another replica won the insert race. Idempotent — if 'admin' now exists, swallow;
    // otherwise the failure is real (rethrow).
    if ((await deps.repo.getByUsername({ username: DEFAULT_SUPERADMIN_USERNAME })) === null) {
      throw e;
    }
    return;
  }
  deps.warn(
    `superadmin bootstrap: created the default account '${DEFAULT_SUPERADMIN_USERNAME}' with password ` +
      `'${DEFAULT_SUPERADMIN_PASSWORD}' — log in and CHANGE THE PASSWORD via the UI immediately.`,
  );
}
