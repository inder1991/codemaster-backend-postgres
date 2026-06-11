// Shared installations/repositories upsert helpers for the auto-registration journey. A FAITHFUL 1:1
// port of two frozen-Python pieces:
//
//   - `upsertInstallation`  ← codemaster/activities/reconcile_installation.py::_upsert_installation
//   - `upsertRepository`    ← codemaster/domain/repos/repositories_upsert.py::upsert_repository
//
// Both are raw `sql`...`.execute(tx)` ports mirroring `_pr_persistence.ts` — the queries key on the
// GitHub-side surrogate (`github_installation_id` / `github_repo_id`), NOT `installation_id`, so they
// run as raw tagged-template SQL which BYPASSES the Kysely `TenancyPlugin` AST walk by construction
// (the plugin only inspects ORM-built SELECT/UPDATE/DELETE nodes; raw `sql`...`` fragments are the
// `check_tenant_scoped_raw_sql.ts` gate's job — see `_webhook_resolvers.ts` for the same exemption on
// `core.installations`). `github_installation_id` / `github_repo_id` are globally UNIQUE, so the
// PK-lookup tenancy exemption applies.
//
// Both helpers return `{ id, before, after }`. The `before` / `after` dicts feed the (DEFERRED) audit
// emit — the callers emit `installation.{action}` / `repository.added` audit rows from them. The audit
// emit itself is deferred in this port (see the // FOLLOW-UP markers in the activity files); the dicts
// are assembled here exactly as the Python builds them so the audit wiring is a drop-in later.

import { type Kysely, sql } from "kysely";

import { type Clock } from "#platform/clock.js";

// ─── Installation upsert (port of reconcile_installation.py::_upsert_installation) ───────────────

/** The `before` / `after` audit shape for an installation upsert (1:1 with the Python dicts). */
export type InstallationAuditState = {
  github_installation_id: number;
  account_login: string;
  account_type: string;
  /** ISO-8601 string when suspended, else null (`.isoformat()` / None in the Python). */
  suspended_at: string | null;
};

/** Return of {@link upsertInstallation}: the internal UUID + audit before/after. */
export type UpsertInstallationResult = {
  id: string;
  /** `{}` when no prior row existed (INSERT path) — the caller passes `before || null` to audit. */
  before: InstallationAuditState | Record<string, never>;
  after: InstallationAuditState;
};

/**
 * Map GitHub's account type into our CHECK-constrained set
 * (`ck_installations_..._account_type_valid` allows only `User` / `Organization`).
 *
 * 1:1 with `_resolve_account_type` (reconcile_installation.py:49-51): `Organization` stays
 * `Organization`; EVERYTHING else (`User`, `Bot`, …) collapses to `User`.
 */
export function resolveAccountType(githubType: string): string {
  return githubType === "Organization" ? "Organization" : "User";
}

/**
 * Idempotent upsert into `core.installations`, keyed on `github_installation_id`
 * (`uq_installations_github_installation_id`). Verbatim port of the Python
 * `_upsert_installation` INSERT … ON CONFLICT … DO UPDATE.
 *
 * - `created_at` is INSERT-ONLY (absent from the DO UPDATE SET clause) — re-installs preserve it.
 * - `suspended_at` flips via `EXCLUDED.suspended_at`, so re-installing a previously deleted/suspended
 *   row (same `github_installation_id`) clears it back to NULL (the caller passes `newSuspendedAt`).
 *
 * The caller computes `newSuspendedAt` from the webhook action (deleted/suspended → now; unsuspended /
 * created → null), mirroring reconcile_installation.py:74-80.
 */
export async function upsertInstallation(
  tx: Kysely<unknown>,
  args: {
    githubInstallationId: number;
    accountLogin: string;
    accountType: string;
    /** `now` when the action suspends/deletes; `null` when it (un)suspends-to-active / creates. */
    newSuspendedAt: Date | null;
    clock: Clock;
  },
): Promise<UpsertInstallationResult> {
  const now = args.clock.now();

  // Read prior state for the audit before/after (1:1 with the Python SELECT).
  // tenant:exempt reason=installation-identity-edge-keys-on-github-surrogate follow_up=PERMANENT-EXEMPTION-global-identity-tables
  const prior = await sql<{
    installation_id: string;
    account_login: string;
    account_type: string;
    suspended_at: Date | null;
  }>`
    SELECT installation_id, account_login, account_type, suspended_at
      FROM core.installations
     WHERE github_installation_id = ${args.githubInstallationId}
  `.execute(tx);
  const priorRow = prior.rows[0];

  const r = await sql<{ installation_id: string }>`
    INSERT INTO core.installations
      (installation_id, github_installation_id, account_login, account_type,
       created_at, updated_at, suspended_at)
    VALUES (gen_random_uuid(), ${args.githubInstallationId}, ${args.accountLogin}, ${args.accountType},
            ${now}, ${now}, ${args.newSuspendedAt})
    ON CONFLICT (github_installation_id) DO UPDATE SET
      account_login = EXCLUDED.account_login,
      account_type = EXCLUDED.account_type,
      updated_at = EXCLUDED.updated_at,
      suspended_at = EXCLUDED.suspended_at
    RETURNING installation_id
  `.execute(tx);
  const row = r.rows[0];
  if (row === undefined) {
    throw new Error(
      "upsertInstallation: INSERT … ON CONFLICT … RETURNING returned no row (Postgres invariant)",
    );
  }

  const after: InstallationAuditState = {
    github_installation_id: args.githubInstallationId,
    account_login: args.accountLogin,
    account_type: args.accountType,
    suspended_at: args.newSuspendedAt ? args.newSuspendedAt.toISOString() : null,
  };
  const before: InstallationAuditState | Record<string, never> =
    priorRow === undefined
      ? {}
      : {
          github_installation_id: args.githubInstallationId,
          account_login: priorRow.account_login,
          account_type: priorRow.account_type,
          suspended_at: priorRow.suspended_at ? new Date(priorRow.suspended_at).toISOString() : null,
        };

  return { id: row.installation_id, before, after };
}

// ─── Sender user/ad_user seed (port of reconcile_installation.py::_ensure_sender_user) ───────────

/**
 * Create / update the installation-event sender as a `core.users` row; seed a `core.ad_users` row when
 * AD-resolvable. Verbatim port of `_ensure_sender_user` (reconcile_installation.py:125-187).
 *
 * - Bot senders (`senderType === "Bot"`): `ad_user_id = null` (recorded as a User with no AD link; NO
 *   ad_users row created). A user row IS still created for bots.
 * - User/Org senders: best-effort AD resolution by `principal_name = "<login>@acme.com"`; INSERT a new
 *   `core.ad_users` row when absent.
 * - `email = "<login>@acme.com"` (the same convention). `ON CONFLICT (installation_id, email)` keeps
 *   `created_at` insert-only and refreshes display_name / ad_user_id / updated_at.
 *
 * PARITY NOTE (email encryption — frozen-Python open question): `core.users.email` is field-encrypted
 * at the Python ORM layer (EncryptedString TypeDecorator, ADR-0033), but THIS raw-SQL path binds the
 * PLAINTEXT `"<login>@acme.com"` string (the TypeDecorator does not fire on a raw `text()` bind — the
 * same plaintext-on-raw-SQL behavior the webhook audit path relies on per github_webhook_persistence.ts).
 * This port faithfully mirrors that: it binds plaintext. Field-encryption at this write path is the
 * SAME deferred concern as the deferred audit-event encryption (// FOLLOW-UP: ADR-0033 field encryption).
 *
 * Returns the `user_id`. (Returned for Bot senders too — a User row is always created.)
 */
export async function ensureSenderUser(
  tx: Kysely<unknown>,
  args: {
    installationId: string;
    senderLogin: string;
    senderType: string;
    clock: Clock;
  },
): Promise<string> {
  let adUserId: string | null;
  if (args.senderType === "Bot") {
    // Record the bot as a User with no AD link.
    adUserId = null;
  } else {
    const principal = `${args.senderLogin}@acme.com`;
    // tenant:exempt reason=ad-user-principal-lookup-not-tenant-scoped follow_up=PERMANENT-EXEMPTION-global-identity-tables
    const found = await sql<{ ad_user_id: string }>`
      SELECT ad_user_id FROM core.ad_users WHERE principal_name = ${principal}
    `.execute(tx);
    const existing = found.rows[0]?.ad_user_id;
    if (existing === undefined) {
      // tenant:exempt reason=ad_users-principal-directory-no-installation_id-column follow_up=PERMANENT-EXEMPTION-global-identity-tables
      const ins = await sql<{ ad_user_id: string }>`
        INSERT INTO core.ad_users
          (ad_user_id, principal_name, display_name, last_synced_at)
        VALUES (gen_random_uuid(), ${principal}, ${args.senderLogin}, ${args.clock.now()})
        RETURNING ad_user_id
      `.execute(tx);
      const insRow = ins.rows[0];
      if (insRow === undefined) {
        throw new Error("ensureSenderUser: ad_users INSERT … RETURNING returned no row");
      }
      adUserId = insRow.ad_user_id;
    } else {
      adUserId = existing;
    }
  }

  // FOLLOW-UP: ADR-0033 field encryption — `email` is bound as plaintext here (1:1 with the frozen
  // Python raw-SQL path); the EncryptedString TypeDecorator is a deferred concern alongside the audit emit.
  const email = `${args.senderLogin}@acme.com`;
  const now = args.clock.now();
  const upsert = await sql<{ user_id: string }>`
    INSERT INTO core.users
      (user_id, installation_id, email, display_name, ad_user_id, created_at, updated_at)
    VALUES (gen_random_uuid(), ${args.installationId}, ${email}, ${args.senderLogin}, ${adUserId},
            ${now}, ${now})
    ON CONFLICT (installation_id, email) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      ad_user_id   = EXCLUDED.ad_user_id,
      updated_at   = EXCLUDED.updated_at
    RETURNING user_id
  `.execute(tx);
  const row = upsert.rows[0];
  if (row === undefined) {
    throw new Error("ensureSenderUser: core.users INSERT … ON CONFLICT … RETURNING returned no row");
  }
  return row.user_id;
}

// ─── Repository upsert (port of repositories_upsert.py::upsert_repository) ────────────────────────

/** The `before` / `after` audit shape for a repository upsert (1:1 with the Python dicts). */
export type RepositoryAuditState = {
  github_repo_id: number;
  full_name: string;
  default_branch: string;
  archived: boolean;
  enabled: boolean;
};

/** Return of {@link upsertRepository}: the internal UUID + audit before/after. */
export type UpsertRepositoryResult = {
  id: string;
  /** `{}` when no prior row existed (INSERT path) — callers gate "added" audit on `not before`. */
  before: RepositoryAuditState | Record<string, never>;
  after: RepositoryAuditState;
};

/**
 * The single canonical mutation point for `core.repositories` (ADR-0054 / CLAUDE.md invariant 16).
 * Verbatim port of `repositories_upsert.py::upsert_repository`. Keyed on `github_repo_id`
 * (`uq_repositories_github_repo_id`).
 *
 * CRITICAL default-deny interplay (invariant 10): `enabled` is set ONLY on INSERT (from
 * `enabledOnInsert`); the DO UPDATE SET clause DELIBERATELY OMITS `enabled` so the admin's prior
 * enable/disable choice is PRESERVED across a re-add cycle. `created_at` + `installation_id` are
 * likewise INSERT-only; `updated_at = EXCLUDED.updated_at` refreshes.
 *
 * The Python emits `enabled` as a SQL LITERAL (`true`/`false`) chosen from a Python bool (never
 * user-controlled). Here it is bound as a real boolean param — equivalent and correct since the value
 * is never user-supplied (the Python comment only documents WHY it used a literal there).
 */
export async function upsertRepository(
  tx: Kysely<unknown>,
  args: {
    installationId: string;
    githubRepoId: number;
    fullName: string;
    defaultBranch?: string;
    archived?: boolean;
    enabledOnInsert?: boolean;
    clock: Clock;
  },
): Promise<UpsertRepositoryResult> {
  const defaultBranch = args.defaultBranch ?? "main";
  const archived = args.archived ?? false;
  const enabledOnInsert = args.enabledOnInsert ?? true;
  const now = args.clock.now();

  // Prior-state read (1:1 with the Python SELECT). Keys on github_repo_id (globally unique).
  // tenant:exempt reason=PK-lookup-on-globally-unique-github-repo-id follow_up=PERMANENT-EXEMPTION-global-github-keys
  const prior = await sql<{
    repository_id: string;
    full_name: string;
    default_branch: string;
    archived: boolean;
    enabled: boolean;
  }>`
    SELECT repository_id, full_name, default_branch, archived, enabled
      FROM core.repositories
     WHERE github_repo_id = ${args.githubRepoId}
  `.execute(tx);
  const priorRow = prior.rows[0];

  const r = await sql<{ repository_id: string }>`
    INSERT INTO core.repositories
      (repository_id, installation_id, github_repo_id, full_name,
       default_branch, archived, enabled, created_at, updated_at)
    VALUES (gen_random_uuid(), ${args.installationId}, ${args.githubRepoId}, ${args.fullName},
            ${defaultBranch}, ${archived}, ${enabledOnInsert}, ${now}, ${now})
    ON CONFLICT (github_repo_id) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      default_branch = EXCLUDED.default_branch,
      archived = EXCLUDED.archived,
      updated_at = EXCLUDED.updated_at
    RETURNING repository_id
  `.execute(tx);
  const row = r.rows[0];
  if (row === undefined) {
    throw new Error(
      "upsertRepository: INSERT … ON CONFLICT … RETURNING returned no row (Postgres invariant)",
    );
  }

  // after.enabled reflects the PRESERVED value on UPDATE (prior.enabled), the inserted literal on INSERT.
  const after: RepositoryAuditState = {
    github_repo_id: args.githubRepoId,
    full_name: args.fullName,
    default_branch: defaultBranch,
    archived,
    enabled: priorRow !== undefined ? priorRow.enabled : enabledOnInsert,
  };
  const before: RepositoryAuditState | Record<string, never> =
    priorRow === undefined
      ? {}
      : {
          github_repo_id: args.githubRepoId,
          full_name: priorRow.full_name,
          default_branch: priorRow.default_branch,
          archived: priorRow.archived,
          enabled: priorRow.enabled,
        };

  return { id: row.repository_id, before, after };
}

// ─── Repository soft-remove (port of reconcile_repositories.py::_remove_repo) ─────────────────────

/** Return of {@link removeRepository}: the internal UUID (or null) + audit before/after. */
export type RemoveRepositoryResult = {
  /** null when the repo was never recorded (best-effort no-op — caller `continue`s, does not count). */
  id: string | null;
  before: { archived: boolean; enabled: boolean } | Record<string, never>;
  after: { archived: boolean; enabled: boolean } | Record<string, never>;
};

/**
 * Soft-disable a repository on `installation_repositories.removed`: `archived = true`, `enabled = false`.
 * 1:1 with `reconcile_repositories.py::_remove_repo` — a soft-disable UPDATE, NOT a DELETE (preserves
 * audit history + FK references). Returns `(null, {}, {})` when the repo was never recorded.
 */
export async function removeRepository(
  tx: Kysely<unknown>,
  args: { githubRepoId: number; clock: Clock },
): Promise<RemoveRepositoryResult> {
  // tenant:exempt reason=PK-lookup-on-globally-unique-github-repo-id follow_up=PERMANENT-EXEMPTION-global-github-keys
  const prior = await sql<{
    repository_id: string;
    full_name: string;
    default_branch: string;
    archived: boolean;
    enabled: boolean;
  }>`
    SELECT repository_id, full_name, default_branch, archived, enabled
      FROM core.repositories
     WHERE github_repo_id = ${args.githubRepoId}
  `.execute(tx);
  const priorRow = prior.rows[0];
  if (priorRow === undefined) {
    // Removing a repo we never recorded — best-effort no-op (1:1 with the Python).
    return { id: null, before: {}, after: {} };
  }

  const now = args.clock.now();
  // tenant:exempt reason=PK-lookup-on-globally-unique-github-repo-id follow_up=PERMANENT-EXEMPTION-global-github-keys
  await sql`
    UPDATE core.repositories
       SET archived = true, enabled = false, updated_at = ${now}
     WHERE github_repo_id = ${args.githubRepoId}
  `.execute(tx);

  return {
    id: priorRow.repository_id,
    before: { archived: priorRow.archived, enabled: priorRow.enabled },
    after: { archived: true, enabled: false },
  };
}
