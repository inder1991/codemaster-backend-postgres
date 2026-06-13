import { describe, expect, it } from "vitest";

import { VaultK8sAuth } from "#backend/adapters/vault_k8s_auth.js";

type PostCall = { url: string; body: unknown };

function harness(opts: { status?: number; lease?: number } = {}) {
  const posts: Array<PostCall> = [];
  let nowMs = 1_000_000;
  const auth = new VaultK8sAuth({
    addr: "https://vault:8200",
    role: "codemaster",
    readToken: () => Promise.resolve("sa-jwt-xyz"),
    httpPostJson: (url, body) => {
      posts.push({ url, body });
      return Promise.resolve({
        status: opts.status ?? 200,
        body: { auth: { client_token: `vt-${posts.length}`, lease_duration: opts.lease ?? 3600 } },
      });
    },
    now: () => nowMs,
  });
  return { auth, posts, advance: (s: number) => (nowMs += s * 1000) };
}

describe("VaultK8sAuth", () => {
  it("logs in at the kubernetes auth path with {role, jwt} and returns the client_token", async () => {
    const { auth, posts } = harness();
    const token = await auth.token();
    expect(token).toBe("vt-1");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("https://vault:8200/v1/auth/kubernetes/login");
    expect(posts[0]?.body).toEqual({ role: "codemaster", jwt: "sa-jwt-xyz" });
  });

  it("caches the token within the lease (no re-login)", async () => {
    const { auth, posts, advance } = harness({ lease: 3600 });
    await auth.token();
    advance(60); // well within the lease
    await auth.token();
    expect(posts).toHaveLength(1);
  });

  it("re-logs-in after the lease nears expiry", async () => {
    const { auth, posts, advance } = harness({ lease: 100 });
    await auth.token();
    advance(95); // past the renew threshold (<100% of lease)
    const t2 = await auth.token();
    expect(posts).toHaveLength(2);
    expect(t2).toBe("vt-2");
  });

  it("floors a zero/absent lease so the token caches (no per-call re-login storm) (P2)", async () => {
    const { auth, posts, advance } = harness({ lease: 0 });
    await auth.token();
    advance(10); // a later call, still well within the floored lease
    await auth.token();
    expect(posts).toHaveLength(1);
  });

  it("HONORS a real short lease — does NOT over-trust it past the true TTL (review P2)", async () => {
    // A real lease of 30s must renew at ~27s (90%), NOT be floored up to 54s — else the cached token is
    // already expired by Vault but still served, causing a 403 window. The floor applies only to lease<=0.
    const { auth, posts, advance } = harness({ lease: 30 });
    await auth.token();
    advance(28); // past 90% of the REAL 30s lease (would still be cached if wrongly floored to 60)
    const t2 = await auth.token();
    expect(posts).toHaveLength(2);
    expect(t2).toBe("vt-2");
  });

  it("de-duplicates concurrent cold-start logins — one POST, not N (P2)", async () => {
    const { auth, posts } = harness();
    const [a, b] = await Promise.all([auth.token(), auth.token()]);
    expect(a).toBe(b);
    expect(posts).toHaveLength(1);
  });

  it("invalidate() forces a re-login on the next token()", async () => {
    const { auth, posts } = harness();
    await auth.token();
    auth.invalidate();
    await auth.token();
    expect(posts).toHaveLength(2);
  });

  it("throws a clear error when the SA token file is unreadable", async () => {
    const auth = new VaultK8sAuth({
      addr: "https://vault:8200",
      role: "codemaster",
      readToken: () => Promise.reject(new Error("ENOENT")),
      httpPostJson: () => Promise.resolve({ status: 200, body: {} }),
      now: () => 1,
    });
    await expect(auth.token()).rejects.toThrow(/service account token/i);
  });

  it("throws naming the role on a non-200 login", async () => {
    const { auth } = harness({ status: 403 });
    await expect(auth.token()).rejects.toThrow(/codemaster/);
  });
});
