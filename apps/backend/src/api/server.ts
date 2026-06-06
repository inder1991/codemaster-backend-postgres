// HTTP server entrypoint (F1·a) — the ingest/api pod. Builds the app factory, mounts routers, and
// listens. The analogue of worker/main.ts for the HTTP side. Routers (the GitHub webhook, auth, admin)
// register onto the app here as they land in subsequent slices.

import { persistWebhook } from "#backend/ingest/github_webhook_persistence.js";
import { makeWebhookSecretProvider } from "#backend/ingest/webhook_secret_provider.js";

import { tenantKysely } from "#platform/db/database.js";
import { WallClock } from "#platform/clock.js";

import { buildApp } from "./app.js";
import { registerGithubWebhookRoutes } from "./github_webhook_routes.js";

/** Build the app, register routers, and listen. Resolves when the server is listening. */
export async function runServer(): Promise<void> {
  const app = buildApp();

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

  // ── More routers register here as they land ──
  // D1: auth routes · D2: admin routes · F-b: feedback

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
