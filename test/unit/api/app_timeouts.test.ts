// F16 / P2-12 — the Fastify instance must set request/connection/keep-alive timeouts (defaults are 0 =
// disabled), bounding slow/idle clients (slowloris). These cap request RECEIPT + idle, not handler time.

import { describe, expect, it } from "vitest";

import {
  buildApp,
  CONNECTION_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
} from "#backend/api/app.js";

describe("buildApp — slowloris timeouts (F16 / P2-12)", () => {
  it("configures requestTimeout / connectionTimeout / keepAliveTimeout (not the 0 defaults)", () => {
    const app = buildApp({});
    const cfg = app.initialConfig;
    expect(cfg.connectionTimeout).toBe(CONNECTION_TIMEOUT_MS);
    expect(cfg.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    // requestTimeout is set on the factory but not surfaced in Fastify's typed initialConfig → read it untyped.
    expect((cfg as { requestTimeout?: number }).requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    // all positive (a 0 would be the disabled default the fix replaces).
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
