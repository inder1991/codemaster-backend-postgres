// CSRF double-submit VERIFICATION (W4.7 / EC4).
//
// On unsafe methods (POST / PUT / PATCH / DELETE) the request must carry an `X-CSRF-Token` header
// whose value matches the `csrf_token` cookie (timing-safe compare). Missing either → 403
// "csrf token missing"; mismatch → 403 "csrf token mismatch". Safe methods and exempt paths pass through.
// Token seeded by GET /api/auth/csrf (hex of Vault csrf_secret — SPA reads the JS-readable cookie and
// echoes it as the header; a cross-origin attacker cannot).
//
// Design notes:
//   * Mounted as a Fastify `onRequest` hook on the ENCAPSULATED admin/auth scopes (not app-wide) —
//     the GitHub webhook lives on its own scope with HMAC auth.
//   * /api/auth/login is ENFORCED; /api/auth/logout stays exempt (anchor-navigation logout cannot carry
//     a custom header — worst-case CSRF is a self-inflictable logout, the documented posture).

import { createHash, timingSafeEqual } from "node:crypto";

import type { onRequestHookHandler } from "fastify";

export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
/** Paths exempt from verification on the AUTH scope (see the logout note above). */
export const DEFAULT_CSRF_EXEMPT_PATHS: ReadonlyArray<string> = ["/api/auth/logout"];

/** Constant-time string compare (Python hmac.compare_digest): SHA-256 both sides so length never
 *  short-circuits, then timingSafeEqual over the fixed-width digests. */
function timingSafeTokenEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf-8").digest();
  const db = createHash("sha256").update(b, "utf-8").digest();
  return timingSafeEqual(da, db);
}

/** Build the verification hook. Register on a scope where @fastify/cookie is active (the admin and
 *  auth routers both register it before this hook, so `request.cookies` is populated). */
export function makeCsrfProtect(
  opts: { exemptPaths?: ReadonlyArray<string> } = {},
): onRequestHookHandler {
  const exempt = new Set(opts.exemptPaths ?? []);
  return async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (exempt.has(path)) {
      return;
    }
    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      return;
    }
    // CSRF_COOKIE_NAME / CSRF_HEADER_NAME are hardcoded module constants, never attacker-controlled —
    // not injection sinks.
    // eslint-disable-next-line security/detect-object-injection
    const cookieToken = request.cookies[CSRF_COOKIE_NAME];
    // eslint-disable-next-line security/detect-object-injection
    const headerRaw = request.headers[CSRF_HEADER_NAME];
    const headerToken = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    if (cookieToken === undefined || cookieToken === "" || headerToken === undefined || headerToken === "") {
      await reply.code(403).send({ detail: "csrf token missing" });
      return reply;
    }
    if (!timingSafeTokenEqual(cookieToken, headerToken)) {
      await reply.code(403).send({ detail: "csrf token mismatch" });
      return reply;
    }
    return;
  };
}
