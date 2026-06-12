// W4.7 / EM5 — TRUSTED client-IP derivation for rate-limit bucketing. The legacy port keyed the
// login rate limiter on the LEFTMOST X-Forwarded-For entry — a client-controlled value, so a
// credential sprayer bypasses per-IP bucketing by rotating a fake XFF. The trusted derivation walks
// the chain from the RIGHT by the deployment's known proxy hop count; with 0 trusted hops the
// socket peer address is used and XFF is ignored entirely.

import { describe, expect, it } from "vitest";

import { trustedClientIp } from "#backend/api/auth/client_ip.js";

describe("W4.7/EM5 trustedClientIp", () => {
  it("hops=0 → the socket IP; a spoofed XFF is ignored", () => {
    expect(
      trustedClientIp({ xff: "6.6.6.6, 7.7.7.7", socketIp: "10.0.0.9", trustedProxyHops: 0 }),
    ).toBe("10.0.0.9");
    expect(trustedClientIp({ xff: undefined, socketIp: "10.0.0.9", trustedProxyHops: 0 })).toBe(
      "10.0.0.9",
    );
  });

  it("hops=1 → the RIGHTMOST XFF entry (appended by the one trusted proxy)", () => {
    expect(
      trustedClientIp({ xff: "6.6.6.6, 198.51.100.7", socketIp: "10.0.0.9", trustedProxyHops: 1 }),
    ).toBe("198.51.100.7");
  });

  it("hops=2 → the second entry from the right", () => {
    expect(
      trustedClientIp({
        xff: "6.6.6.6, 198.51.100.7, 192.0.2.1",
        socketIp: "10.0.0.9",
        trustedProxyHops: 2,
      }),
    ).toBe("198.51.100.7");
  });

  it("fewer XFF entries than the trusted hop position → fall back to the socket IP", () => {
    expect(
      trustedClientIp({ xff: "198.51.100.7", socketIp: "10.0.0.9", trustedProxyHops: 2 }),
    ).toBe("10.0.0.9");
    expect(trustedClientIp({ xff: "", socketIp: "10.0.0.9", trustedProxyHops: 1 })).toBe("10.0.0.9");
  });

  it("multi-header XFF (string[]) joins in order before walking from the right", () => {
    expect(
      trustedClientIp({
        xff: ["6.6.6.6, 7.7.7.7", "198.51.100.7"],
        socketIp: "10.0.0.9",
        trustedProxyHops: 1,
      }),
    ).toBe("198.51.100.7");
  });

  it("empty socket IP degrades to the 'unknown' bucket, never an empty key", () => {
    expect(trustedClientIp({ xff: undefined, socketIp: "", trustedProxyHops: 0 })).toBe("unknown");
  });
});
