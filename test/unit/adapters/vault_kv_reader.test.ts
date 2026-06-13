import { describe, expect, it } from "vitest";

import { makeVaultKvReader } from "#backend/adapters/vault_kv_reader.js";

type GetCall = { url: string; token: string };

function harness(responses: Array<{ status: number; body: unknown }>) {
  const gets: Array<GetCall> = [];
  let invalidated = 0;
  let i = 0;
  const reader = makeVaultKvReader({
    addr: "https://vault:8200",
    mount: "secret",
    auth: {
      token: () => Promise.resolve(`tok-${invalidated}`),
      invalidate: () => {
        invalidated += 1;
      },
    },
    httpGetJson: (url, token) => {
      gets.push({ url, token });
      return Promise.resolve(responses[i++] ?? { status: 500, body: {} });
    },
  });
  return { reader, gets, invalidated: () => invalidated };
}

const kvOk = { status: 200, body: { data: { data: { dsn: "postgresql://v/d", k: "v" } } } };

describe("makeVaultKvReader", () => {
  it("GETs the KV-v2 data path with the token and returns data.data", async () => {
    const { reader, gets } = harness([kvOk]);
    const out = await reader("codemaster/postgres/app");
    expect(out).toEqual({ dsn: "postgresql://v/d", k: "v" });
    expect(gets[0]?.url).toBe("https://vault:8200/v1/secret/data/codemaster/postgres/app");
    expect(gets[0]?.token).toBe("tok-0");
  });

  it("on 403 invalidates the token and retries once with a fresh token", async () => {
    const { reader, gets, invalidated } = harness([{ status: 403, body: {} }, kvOk]);
    const out = await reader("codemaster/postgres/app");
    expect(out).toEqual({ dsn: "postgresql://v/d", k: "v" });
    expect(invalidated()).toBe(1);
    expect(gets).toHaveLength(2);
    expect(gets[1]?.token).toBe("tok-1");
  });

  it("throws naming the path on 404", async () => {
    const { reader } = harness([{ status: 404, body: {} }]);
    await expect(reader("codemaster/postgres/app")).rejects.toThrow(/codemaster\/postgres\/app/);
  });
});
