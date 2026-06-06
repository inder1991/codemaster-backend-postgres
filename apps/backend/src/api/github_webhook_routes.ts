// GitHub webhook ROUTE (F1·b) — the Fastify port of the FastAPI router in
// vendor/codemaster-py/codemaster/api/github_webhook.py::build_router (the receive_webhook endpoint).
//
// This is the "verification edge" slice: header validation → body-size cap → HMAC verification → status
// code. PERSISTENCE (audit.webhook_events + cache.cache_idempotency dedup + the SERIAL+SUPERSEDE run
// allocator + outbox emission) is a SUBSEQUENT slice — it threads a session_factory + clock through here.
//
// Raw body: GitHub signs the EXACT bytes it sends, so the route must HMAC over the raw request body, not a
// re-serialized JSON parse. We register the route inside an encapsulated Fastify scope that removes the
// inherited content-type parsers and captures every content-type as a raw Buffer — so the rest of the app
// keeps its normal JSON parsing.

import type { FastifyInstance } from "fastify";

import { verifyGithubSignature } from "./github_webhook.js";

/** Path constants — 1:1 with the frozen Python (GITHUB_WEBHOOK_PREFIX + GITHUB_WEBHOOK_ROUTE). */
export const GITHUB_WEBHOOK_PREFIX = "/v1/github";
export const GITHUB_WEBHOOK_ROUTE = "/webhook";
export const GITHUB_WEBHOOK_PATH = `${GITHUB_WEBHOOK_PREFIX}${GITHUB_WEBHOOK_ROUTE}`;
/** 10 MB — Python WEBHOOK_BODY_CAP_BYTES. */
export const WEBHOOK_BODY_CAP_BYTES = 10 * 1024 * 1024;

/**
 * The webhook-secret source (Python `WebhookSecretProvider` Protocol). `currentSecret()` reads the secret
 * fresh on every call (the Vault-backed impl does no in-process caching, so rotations take effect
 * immediately). Returns the raw secret bytes (Python `bytes`).
 */
export type WebhookSecretProvider = { currentSecret(): Promise<Uint8Array> };

export type GithubWebhookRoutesOptions = { secretProvider: WebhookSecretProvider };

/** Coerce a Fastify header value to a non-empty string, or null. */
function headerStr(value: string | Array<string> | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Register `POST /v1/github/webhook` onto `app`. Encapsulated in its own scope so the raw-body
 * content-type parser does not leak to other routes (auth/admin keep JSON parsing).
 */
export async function registerGithubWebhookRoutes(
  app: FastifyInstance,
  opts: GithubWebhookRoutesOptions,
): Promise<void> {
  await app.register(async (scope) => {
    // Capture the EXACT bytes for HMAC: drop the inherited parsers, treat every content-type as a Buffer.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });

    scope.post(
      GITHUB_WEBHOOK_PATH,
      // Allow slightly above the cap so the route itself enforces the exact 10 MB boundary + message
      // (matching the Python `len(body) > cap` check) before Fastify's hard ceiling rejects.
      { bodyLimit: WEBHOOK_BODY_CAP_BYTES + 1024 },
      async (request, reply) => {
        const signature = headerStr(request.headers["x-hub-signature-256"]);
        const event = headerStr(request.headers["x-github-event"]);
        const delivery = headerStr(request.headers["x-github-delivery"]);

        if (signature === null) {
          return reply.code(401).send({ detail: "missing X-Hub-Signature-256" });
        }
        if (event === null) {
          return reply.code(400).send({ detail: "missing X-GitHub-Event" });
        }
        if (delivery === null) {
          return reply.code(400).send({ detail: "missing X-GitHub-Delivery" });
        }

        const body = (request.body ?? Buffer.alloc(0)) as Buffer;
        if (body.length > WEBHOOK_BODY_CAP_BYTES) {
          return reply.code(413).send({ detail: `body exceeds ${WEBHOOK_BODY_CAP_BYTES}-byte cap` });
        }

        const secret = await opts.secretProvider.currentSecret();
        const valid = verifyGithubSignature({ body: new Uint8Array(body), header: signature, secret });
        if (!valid) {
          return reply.code(401).send({ detail: "invalid signature" });
        }

        // FOLLOW-UP-webhook-persistence: on a valid signature, the next slice persists to
        // audit.webhook_events + dedupes via cache.cache_idempotency + allocates the review run + emits the
        // outbox dispatch row. The verification edge returns 204 with no side effects.
        return reply.code(204).send();
      },
    );
  });
}
