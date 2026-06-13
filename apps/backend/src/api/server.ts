// HTTP server entrypoint (F1·a) — the ingest/api pod. Builds the app factory, mounts routers, and
// listens. The analogue of worker/main.ts for the HTTP side. Routers (the GitHub webhook, auth, admin)
// register onto the app here as they land in subsequent slices.

import { VaultHttpPort } from "#backend/adapters/vault_http.js";
import { makePgAuditEmitter } from "#backend/api/admin/audit_emit_adapter.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { OutboxPageResyncDispatcher } from "#backend/api/admin/page_resync_dispatcher.js";
import { getPreflightValidator } from "#backend/integrations/llm/preflight_validator_real.js";
import { registerAuthRoutes } from "#backend/api/auth/auth_routes.js";
import { makeAuthSecretsProvider } from "#backend/api/auth/auth_secrets_provider.js";
import { PostgresLocalUserRepo } from "#backend/api/auth/local_user_repo.js";
import { NoOpLdapClient } from "#backend/api/auth/noop_ldap.js";
import { hashPassword, verifyPassword } from "#backend/api/auth/password_hasher.js";
import { PostgresLoginRateLimiter } from "#backend/api/auth/rate_limit.js";
import { persistWebhook } from "#backend/ingest/github_webhook_persistence.js";
import { makeWebhookSecretProvider } from "#backend/ingest/webhook_secret_provider.js";
import { getAuditKeyRegistry } from "#backend/security/audit_field_codec.js";
import { bootstrapSuperAdmin } from "#backend/security/superadmin_bootstrap.js";

import { tenantKysely } from "#platform/db/database.js";
import { WallClock } from "#platform/clock.js";
import { uuid4 } from "#platform/randomness.js";

import { buildApp, type BuildAppDeps } from "./app.js";
import { registerGithubWebhookRoutes } from "./github_webhook_routes.js";

/** The probe seams runServer forwards to buildApp (CS3.2): the readiness dependency checks
 *  (Postgres / Vault / the 'runtime-loops' loop-liveness check) + the liveness wedge signal.
 *  The combined pod (main.ts) composes these from env + the shared LoopHealthRegistry; the
 *  direct api-only entrypoint below passes none (process-up readiness — no runtime loops are
 *  that pod's job, and nothing is wired that it would gate on). */
export type RunServerDeps = Pick<
  BuildAppDeps,
  "postgresCheck" | "vaultCheck" | "dependencyChecks" | "wedgeCheck"
>;

/** Build the app, register routers, and listen. Resolves when the server is listening. */
export async function runServer(deps: RunServerDeps = {}): Promise<void> {
  const app = buildApp(deps);

  // F1·b — POST /v1/github/webhook (verification edge). The secret provider is source-selected per
  // ADR-0071 (CODEMASTER_VAULT_SECRET_SOURCE): the default lazy Vault provider OR the Vault Agent
  // file-rendered secret. Either way nothing is read until the first webhook, so the server boots clean.
  // The persist seam (W3) is wired lazily: the DSN is read per-webhook (tenantKysely caches the engine),
  // so the server still boots without CODEMASTER_PG_CORE_DSN — only the first webhook needs the core pool.
  await registerGithubWebhookRoutes(app, {
    secretProvider: makeWebhookSecretProvider(),
    persist: (args) => {
      const dsn = process.env["CODEMASTER_PG_CORE_DSN"];
      if (dsn === undefined || dsn === "") {
        throw new Error("CODEMASTER_PG_CORE_DSN is not set; the webhook persistence path requires the core pool.");
      }
      return persistWebhook({
        db: tenantKysely(dsn),
        body: args.body,
        headers: args.headers,
        signatureValid: args.signatureValid,
        clock: new WallClock(),
      });
    },
  });

  // D1 — auth routes (admin login surface). Opt-in via CODEMASTER_AUTH_ROUTES_ENABLED so webhook-only
  // deploys still boot without the auth secrets. When enabled, EAGERLY load the field-encryption key
  // registry + session signing key + CSRF secret from Vault at startup (ADR-0033: field keys fetched at
  // pod startup) and fail loud if Vault / the DSN is unavailable — the admin API can't run without them.
  // The field keyset loads via the Vault HTTP API (its nested payload can't be agent-file-rendered as flat
  // strings); the signing key + CSRF secret follow the agent-file-or-API selector (ADR-0071).
  if ((process.env["CODEMASTER_AUTH_ROUTES_ENABLED"] ?? "false") === "true") {
    const dsn = process.env["CODEMASTER_PG_CORE_DSN"];
    if (dsn === undefined || dsn === "") {
      throw new Error(
        "CODEMASTER_AUTH_ROUTES_ENABLED=true requires CODEMASTER_PG_CORE_DSN (the core.local_users pool).",
      );
    }
    // The field-encryption key registry is installed source-aware by the composition root (main.ts
    // installFieldKeyRegistryAtBoot) BEFORE this bind — openshift→env keyset, vault→Vault. Consume it
    // here (the local-user repo + the audit-events READ endpoint decrypt through it); fail loud if a
    // boot without a key source left it null.
    const registry = getAuditKeyRegistry();
    if (registry === null) {
      throw new Error(
        "CODEMASTER_AUTH_ROUTES_ENABLED=true requires the field-encryption key registry, which must be " +
          "installed at boot: set CODEMASTER_FIELD_ENCRYPTION_KEYSET (openshift) or a Vault key source " +
          "(see installFieldKeyRegistryAtBoot).",
      );
    }
    // Vault is OPTIONAL now: the LLM/GitHub admin routes encrypt via the field-key registry, so only the
    // platform-credentials routes still need it. openshift (no VAULT_ADDR) → undefined, and those routes
    // 503 (correct degradation) while the field-codec routes work.
    const vault = (process.env["VAULT_ADDR"] ?? "") === "" ? undefined : VaultHttpPort.fromEnv();
    const authSecrets = makeAuthSecretsProvider();
    const [signingKey, csrfSecret] = await Promise.all([
      authSecrets.sessionSigningKey(),
      authSecrets.csrfSecret(),
    ]);
    const coreDb = tenantKysely(dsn);
    const clock = new WallClock();
    // W4.7 / EM5 — trusted proxy depth for client-IP derivation (0 = socket peer; the OpenShift
    // router edge sets 1). Fail-loud on a malformed value: a silently-wrong hop count either
    // disables spray protection or buckets every client into the proxy's IP.
    const trustedProxyHops = Number(process.env["CODEMASTER_TRUSTED_PROXY_HOPS"] ?? "0");
    if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0) {
      throw new Error(
        `CODEMASTER_TRUSTED_PROXY_HOPS must be a non-negative integer, got ${JSON.stringify(process.env["CODEMASTER_TRUSTED_PROXY_HOPS"])}.`,
      );
    }
    const localRepo = new PostgresLocalUserRepo({ db: coreDb, registry });
    // Go-live Step 5: ensure a usable super-admin exists on first deploy (constant admin/admin, changed
    // via the UI after) and warn — never block — while the default password is in use. Idempotent +
    // race-safe across replicas; runs before the auth routes serve.
    await bootstrapSuperAdmin({
      repo: localRepo,
      hashPassword,
      verifyPassword,
      now: () => clock.now(),
      newUserId: () => uuid4(),
      warn: (m) => {
        app.log.warn(m);
      },
    });
    await registerAuthRoutes(app, {
      localRepo,
      ldap: new NoOpLdapClient(),
      clock,
      signingKey,
      csrfSecret,
      secureCookies: (process.env["CODEMASTER_SECURE_COOKIES"] ?? "true") !== "false",
      // W4.7 / EH7 — login.success/.failure audit emission (same-TX via authenticate; fail-safe
      // elsewhere). audit.audit_events shares the core DSN (the Python bootstrap's G7 note).
      auditDb: coreDb,
      // W4.7 / EM5 — cross-replica Postgres rate limiter keyed on the trusted client IP (the
      // in-process Map default is defeated by multi-replica deployments + spoofed XFF).
      rateLimiter: new PostgresLoginRateLimiter({
        db: coreDb,
        maxAttempts: 10,
        windowMs: 5 * 60 * 1000,
        lockoutMs: 5 * 60 * 1000,
        clock,
      }),
      trustedProxyHops,
    });
    // D2 — admin READ + WRITE endpoints, behind the same makeRequireRole gate + signing key. vault +
    // getPreflightValidator make the LLM credential-rotation routes (llm-provider-config / bedrock-config /
    // llm-models test) LIVE; the Confluence-validator + platform-credential-probe seams stay unwired (those
    // routes 503) pending their real, live-tested external adapters. pageResyncDispatcher (W4c.2 #5) makes
    // approval revocation enqueue the trigger_page_resync outbox row (revocation → outbox → (cutover) →
    // background job) instead of silently skipping the resync.
    await registerAdminRoutes(app, {
      db: coreDb,
      signingKey,
      clock,
      registry,
      vault,
      getPreflightValidator,
      pageResyncDispatcher: new OutboxPageResyncDispatcher({ db: coreDb }),
      // W4.7 / EC4 — mounts the CSRF double-submit verification hook on the admin scope.
      csrfSecret,
      // W4.7 / EH7 — the CONCRETE audit emitter: every admin write's `opts.audit?.(...)` now lands a
      // decryptable audit.audit_events row (credential rotation, repo enable, role changes, …).
      audit: makePgAuditEmitter({ db: coreDb }),
    });
  }

  // ── More routers register here as they land ──
  // D2: admin routes · F-b: feedback

  const port = Number(process.env.CODEMASTER_API_PORT ?? "8080");
  const host = process.env.CODEMASTER_API_HOST ?? "0.0.0.0";
  await app.listen({ port, host });
}

// Main-module entrypoint guard — the ESM analogue of `if __name__ == "__main__":` (same pattern as
// worker/main.ts). When executed directly, run the server and fail loudly on any startup error.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runServer().catch((err: unknown) => {
    process.stderr.write(
      `api server FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
