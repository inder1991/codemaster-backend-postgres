// F2 (P0-3): runServer must return a close handle that actually STOPS the listener — the lever main.ts
// uses to stop accepting HTTP on SIGTERM before disposing the shared pool. Binds an ephemeral port (0)
// and needs no DB (no readiness deps wired → /healthz is wedge-only).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runServer, type RunServerHandle } from "#backend/api/server.js";

describe("runServer close handle (F2 / P0-3)", () => {
  const savedPort = process.env.CODEMASTER_API_PORT;
  const savedHost = process.env.CODEMASTER_API_HOST;
  let handle: RunServerHandle | undefined;

  beforeEach(() => {
    process.env.CODEMASTER_API_PORT = "0"; // ephemeral — the OS assigns a free port
    process.env.CODEMASTER_API_HOST = "127.0.0.1";
  });
  afterEach(async () => {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    handle = undefined;
    if (savedPort === undefined) delete process.env.CODEMASTER_API_PORT;
    else process.env.CODEMASTER_API_PORT = savedPort;
    if (savedHost === undefined) delete process.env.CODEMASTER_API_HOST;
    else process.env.CODEMASTER_API_HOST = savedHost;
  });

  it("serves while listening, then close() releases the listener (connection refused after)", async () => {
    handle = await runServer({});
    expect(typeof handle.close).toBe("function");
    expect(handle.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Listening: /healthz answers.
    const live = await fetch(`${handle.address}/healthz`);
    expect(live.status).toBe(200);

    // Close the handle → the listener is released.
    await handle.close();

    // After close, the socket is gone — the connection is refused (fetch rejects).
    await expect(fetch(`${handle.address}/healthz`)).rejects.toThrow();
    handle = undefined; // already closed
  });
});
