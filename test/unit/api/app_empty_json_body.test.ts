// A body-less request that still carries Content-Type: application/json (the admin "Test" POST and the
// "Delete" DELETE send it via _mutationHeaders) must NOT 400. Fastify's DEFAULT JSON parser rejects an
// empty body ("Body cannot be empty when content-type is set to 'application/json'"). buildApp installs a
// tolerant parser: empty body -> undefined (the handler runs); a body-REQUIRED route still rejects
// undefined via its own schema; a MALFORMED non-empty body still 400s.

import { describe, expect, it } from "vitest";

import { buildApp } from "#backend/api/app.js";

describe("buildApp — empty application/json body is tolerated, not 400", () => {
  it("a POST with Content-Type: application/json and no body reaches the handler (body undefined)", async () => {
    const app = buildApp({});
    app.post("/_t/echo", async (req) => ({ body: req.body ?? null }));
    const res = await app.inject({
      method: "POST",
      url: "/_t/echo",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: null });
    await app.close();
  });

  it("a malformed (non-empty) application/json body still 400s", async () => {
    const app = buildApp({});
    app.post("/_t/echo", async () => ({ ok: true }));
    const res = await app.inject({
      method: "POST",
      url: "/_t/echo",
      headers: { "content-type": "application/json" },
      payload: "{not valid json",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
