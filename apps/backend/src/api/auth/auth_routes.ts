// Fastify auth router — port of codemaster/api/auth/routes.py (Sprint 14 / S14.A).
//
// Single-factor (username + password). Endpoints (prefix /api/auth):
//   POST /login   — verify credentials, set the HttpOnly session cookie
//   GET  /me      — return identity from the session cookie
//   GET  /csrf    — seed the double-submit CSRF token (cookie + body)
//   POST /logout  — clear the session cookie (idempotent)
//
// Registered onto an encapsulated Fastify scope (mirrors github_webhook_routes), so @fastify/cookie is
// scoped here and the app factory stays pure. The lockout + dispatch substance lives in authenticate()
// (login.ts); this layer is the HTTP edge: CSRF gate → rate-limit gate → dispatch → metrics → cookie →
// status mapping.
//
// W4.7 closed both deferred seams: CSRF *verification* (EC4 — csrf.ts; mounted whenever csrfSecret is
// wired, session cookie SameSite=Strict) and login.success/.failure audit emission (EH7 — audit.ts;
// active whenever auditDb is wired). The audit wiring is three-pronged, 1:1 with the Python router:
// the same-TX auditCallbackFactory threaded into authenticate() (the R8 contract — the audit INSERT
// commits/rolls back WITH recordLoginAttempt's user-state UPDATE), a fail-safe post-authenticate emit
// for outcomes that bypass recordLoginAttempt (locked / disabled / ldap_unreachable), and a fail-safe
// emit on the pre-dispatch rate-limited 429 (the credential-spray forensic trail — R5).

import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import type { Clock } from "#platform/clock.js";

import {
  CsrfTokenResponseV1,
  LoginRequestV1,
  LoginResponseV1,
  MeResponseV1,
} from "#contracts/auth.v1.js";

import { emitLoginEvent } from "#backend/api/auth/audit.js";
import type { CoreUserRepo } from "#backend/api/auth/core_user_repo.js";
import {
  CSRF_COOKIE_NAME,
  DEFAULT_CSRF_EXEMPT_PATHS,
  makeCsrfProtect,
} from "#backend/api/auth/csrf.js";
import { makeScopedErrorHandler } from "#backend/api/auth/error_envelope.js";
import type { LdapClientPort } from "#backend/api/auth/ldap_client.js";
import type { LocalUserRepo } from "#backend/api/auth/local_user_repo.js";
import { type AuditCallbackFactory, type LoginOutcome, authenticate } from "#backend/api/auth/login.js";
import { recordLoginAttempt } from "#backend/api/auth/metrics.js";
import { LoginRateLimiter } from "#backend/api/auth/rate_limit.js";
import type { RoleResolver } from "#backend/api/auth/role_resolver.js";
import {
  SESSION_LIFETIME_MS,
  SessionCookieInvalid,
  issueCookie,
  verifyCookie,
} from "#backend/api/auth/session.js";
import { PLATFORM_SCOPE_AUDIT_INSTALLATION_ID } from "#backend/infra/sentinels.js";

export const SESSION_COOKIE_NAME = "session";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AuthRoutesOptions = {
  localRepo: LocalUserRepo;
  ldap: LdapClientPort;
  clock: Clock;
  signingKey: Buffer | Uint8Array;
  /** Secure flag on emitted cookies (true in prod HTTPS; false in local-dev HTTP). */
  secureCookies?: boolean;
  /** CSRF double-submit secret; the /csrf endpoint returns its hex. 503 when absent. */
  csrfSecret?: Buffer | Uint8Array;
  rateLimiter?: LoginRateLimiter;
  /** core.users dispatch step (the ENABLE_CORE_USERS_LOCAL_AUTH flag); both required to activate it. */
  coreRepo?: CoreUserRepo;
  roleResolver?: RoleResolver;
  /** W4.7 / EH7 — the audit-emit executor (the core pool; audit.audit_events shares the core DSN).
   *  When wired, login.success/.failure rows are emitted (same-TX where possible, fail-safe
   *  elsewhere). Absent → audit emission is disabled (the Python's audit_session_factory=None). */
  auditDb?: Kysely<unknown>;
};

// LoginOutcome → (HTTP status, detail). 'ok' is handled separately (cookie + 200).
const OUTCOME_ERRORS = new Map<LoginOutcome, { status: number; detail: string }>([
  ["bad_credentials", { status: 401, detail: "bad credentials" }],
  ["locked", { status: 423, detail: "account locked" }],
  ["disabled", { status: 403, detail: "account disabled" }],
  ["no_role", { status: 403, detail: "no role assigned" }],
  ["ldap_unreachable", { status: 503, detail: "ldap unreachable" }],
]);

/** Leftmost X-Forwarded-For entry (the original client) for rate-limit bucketing, else the socket IP. */
function clientIp(request: FastifyRequest): string {
  const xff = request.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (raw !== undefined && raw !== "") {
    const leftmost = raw.split(",")[0]?.trim();
    if (leftmost !== undefined && leftmost !== "") {
      return leftmost;
    }
  }
  return request.ip || "unknown";
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const secureCookies = opts.secureCookies ?? true;
  const rateLimiter =
    opts.rateLimiter ??
    new LoginRateLimiter({
      maxAttempts: 10,
      windowMs: 5 * 60 * 1000,
      lockoutMs: 5 * 60 * 1000,
      clock: opts.clock,
    });

  await app.register(async (scope) => {
    await scope.register(cookie);

    // W4.7 / EH6 — unmapped throws must never echo raw internal error text to the client.
    scope.setErrorHandler(makeScopedErrorHandler("auth"));

    // W4.7 / EC4 — CSRF verification on every unsafe method of this scope (login included; logout
    // exempt). Mounted iff the csrf secret is wired, mirroring the Python's conditional middleware
    // mount; production (server.ts) always wires it.
    if (opts.csrfSecret !== undefined) {
      scope.addHook("onRequest", makeCsrfProtect({ exemptPaths: DEFAULT_CSRF_EXEMPT_PATHS }));
    }

    function setSessionCookie(reply: FastifyReply, value: string, maxAgeSeconds: number): void {
      reply.setCookie(SESSION_COOKIE_NAME, value, {
        maxAge: maxAgeSeconds,
        httpOnly: true,
        secure: secureCookies,
        // W4.7 / EC4 — Strict (tightened from the Python's spec-locked Lax): the session cookie is
        // the sole credential for every admin mutation; Strict removes the top-level-navigation
        // CSRF carve-out entirely. The CSRF cookie below stays Lax (it must survive navigation for
        // the SPA to read it; it is not a credential).
        sameSite: "strict",
        path: "/",
      });
    }
    function clearSessionCookie(reply: FastifyReply): void {
      reply.setCookie(SESSION_COOKIE_NAME, "", {
        maxAge: 0,
        httpOnly: true,
        secure: secureCookies,
        sameSite: "strict",
        path: "/",
      });
    }

    scope.post("/api/auth/login", async (request, reply) => {
      const parsed = LoginRequestV1.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({ detail: "invalid login request" });
      }
      const now = opts.clock.now();
      const ip = clientIp(request);
      const tStart = opts.clock.monotonic();

      // Pre-auth per-IP rate-limit gate — defends against credential spraying (which per-account lockout
      // misses, since each username only sees one failure).
      if (!rateLimiter.checkAllowed(ip)) {
        recordLoginAttempt({
          authSource: null,
          outcome: "rate_limited",
          latencySeconds: opts.clock.monotonic() - tStart,
        });
        // EH7 / R5 — the rate-limited path leaves a login.failure row too; without it a credential
        // spray leaves an audit hole exactly where forensic evidence is needed. user_id=null (the
        // submitted username is untrusted pre-dispatch); fail-safe inside emitLoginEvent.
        if (opts.auditDb !== undefined) {
          await emitLoginEvent({
            executor: opts.auditDb,
            outcome: "rate_limited",
            authSource: null,
            userId: null,
            installationId: PLATFORM_SCOPE_AUDIT_INSTALLATION_ID,
            clientIp: ip,
            clock: opts.clock,
          });
        }
        return reply
          .code(429)
          .send({ detail: "rate limited — too many failed attempts; try again later" });
      }

      // EH7 / R8 — same-TX audit-callback factory bound to request context. authenticate() invokes it
      // at each recordLoginAttempt site and threads the callback into the repo's open transaction, so
      // the audit INSERT and the user-state UPDATE commit atomically (strict=true: an audit failure
      // rolls the UPDATE back). undefined → audit emission disabled.
      const auditDb = opts.auditDb;
      const auditCallbackFactory: AuditCallbackFactory | undefined =
        auditDb === undefined
          ? undefined
          : (outcome, authSource, userId) => async (executor) => {
              await emitLoginEvent({
                executor,
                outcome,
                authSource,
                userId,
                installationId: PLATFORM_SCOPE_AUDIT_INSTALLATION_ID,
                clientIp: ip,
                clock: opts.clock,
                strict: true,
              });
            };

      const result = await authenticate({
        username: parsed.data.username,
        password: parsed.data.password,
        localRepo: opts.localRepo,
        ldap: opts.ldap,
        now,
        ...(opts.coreRepo !== undefined ? { coreRepo: opts.coreRepo } : {}),
        ...(opts.roleResolver !== undefined ? { roleResolver: opts.roleResolver } : {}),
        ...(auditCallbackFactory !== undefined ? { auditCallbackFactory } : {}),
      });

      recordLoginAttempt({
        authSource: result.auth_source,
        outcome: result.outcome,
        latencySeconds: opts.clock.monotonic() - tStart,
      });

      // EH7 — fallback emit for the outcomes that never reach recordLoginAttempt (locked, disabled,
      // ldap_unreachable; plus InMemory repos, which accept the callback but never invoke it).
      // result.audit_emitted is the authoritative "the same-TX path already handled this" flag.
      // Fail-safe: emitLoginEvent swallows its own errors here.
      if (auditDb !== undefined && !result.audit_emitted) {
        await emitLoginEvent({
          executor: auditDb,
          outcome: result.outcome,
          authSource: result.auth_source,
          userId: result.user_id !== null && UUID_RE.test(result.user_id) ? result.user_id : null,
          installationId: PLATFORM_SCOPE_AUDIT_INSTALLATION_ID,
          clientIp: ip,
          clock: opts.clock,
        });
      }

      // Success clears the IP's history; any non-ok outcome (incl. ldap_unreachable) records a failure.
      if (result.outcome === "ok") {
        rateLimiter.recordSuccess(ip);
      } else {
        rateLimiter.recordFailure(ip);
      }

      if (result.outcome === "ok") {
        // Invariant: these are set when outcome === "ok".
        const cookieValue = issueCookie({
          user_id: result.user_id!,
          email: result.email!,
          role: result.role!,
          auth_source: result.auth_source!,
          ldap_groups: result.ldap_groups,
          now,
          signing_key: opts.signingKey,
          installation_id: result.installation_id,
        });
        setSessionCookie(reply, cookieValue, Math.floor(SESSION_LIFETIME_MS / 1000));
        return reply.code(200).send(
          LoginResponseV1.parse({
            user_id: result.user_id,
            role: result.role,
            expires_at: new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString(),
          }),
        );
      }

      const mapped = OUTCOME_ERRORS.get(result.outcome);
      if (mapped === undefined) {
        return reply.code(500).send({ detail: "unexpected login outcome" });
      }
      return reply.code(mapped.status).send({ detail: mapped.detail });
    });

    scope.get("/api/auth/me", async (request, reply) => {
      // SESSION_COOKIE_NAME is a hardcoded module constant, never attacker-controlled — not an injection sink.
      // eslint-disable-next-line security/detect-object-injection
      const cookieValue = request.cookies[SESSION_COOKIE_NAME];
      if (cookieValue === undefined || cookieValue === "") {
        return reply.code(401).send({ detail: "no session" });
      }
      try {
        const session = verifyCookie(cookieValue, {
          signing_key: opts.signingKey,
          now: opts.clock.now(),
        });
        const me = MeResponseV1.parse({
          user_id: session.user_id,
          role: session.role,
          email: session.email,
          installation_id: session.installation_id,
        });
        return reply.code(200).send(me);
      } catch (e) {
        // Tampered/expired cookie, or a malformed installation_id in the payload. Clear the stale cookie.
        clearSessionCookie(reply);
        const detail = e instanceof SessionCookieInvalid ? e.message : "session invalid";
        return reply.code(401).send({ detail });
      }
    });

    scope.get("/api/auth/csrf", async (_request, reply) => {
      if (opts.csrfSecret === undefined) {
        return reply.code(503).send({ detail: "csrf secret not configured" });
      }
      const token = Buffer.from(opts.csrfSecret).toString("hex");
      // Seed the double-submit cookie (readable by the SPA; NOT HttpOnly). The body carries the same token.
      reply.setCookie(CSRF_COOKIE_NAME, token, {
        httpOnly: false,
        secure: secureCookies,
        sameSite: "lax",
        path: "/",
      });
      return reply.code(200).send(CsrfTokenResponseV1.parse({ token }));
    });

    scope.post("/api/auth/logout", async (_request, reply) => {
      clearSessionCookie(reply);
      return reply.code(204).send();
    });
  });
}
