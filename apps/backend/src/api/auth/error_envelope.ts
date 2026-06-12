// Scoped error envelope — W4.7 / EH6. Fastify's DEFAULT error handler echoes `err.message` in the
// 500 body; for an unmapped driver-level Postgres error that is raw schema text (column/table names,
// sometimes query fragments) served to the operator's browser. Both session-cookie scopes (admin +
// auth) register this handler instead: the full error is logged server-side (structured, one line —
// the api surface's console-JSON idiom; the pino StageLogger belongs to the runner lane) and the
// client gets the uniform `{detail:"internal error"}` envelope.
//
// Framework-CLASSIFIED client errors (FST_ERR_CTP_* body/content-type parse failures, payload-too-
// large …) carry `statusCode` 4xx and keep their status + message — that text is framework-generated
// and leaks nothing; swallowing it to a 500 would misclassify caller bugs as server faults.
//
// Lives on the auth side so the admin router (which already imports auth seams: session, csrf,
// SESSION_COOKIE_NAME) can reuse it without an import cycle.

import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/** Build a `setErrorHandler` callback for an encapsulated scope. `scope` names the surface in logs. */
export function makeScopedErrorHandler(
  scope: "admin" | "auth",
): (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (error, request, reply) => {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : undefined;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      await reply.code(statusCode).send({ detail: error.message });
      return;
    }
    console.error(
      JSON.stringify({
        event: "api_unhandled_error",
        scope,
        method: request.method,
        path: request.url.split("?")[0] ?? "",
        error_class: error instanceof Error ? error.constructor.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    await reply.code(500).send({ detail: "internal error" });
  };
}
