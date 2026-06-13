import { describe, expect, it } from "vitest";

import { resolveLayered } from "#backend/config/layered_config.js";

// The non-blocking feature-config precedence: DB (UI) > env (ConfigMap/Secret) > Vault > disabled.
// First layer to yield a non-null value wins; its source is reported (for /config-status).
describe("resolveLayered", () => {
  it("returns the first non-null layer and its source (DB wins)", async () => {
    const got = await resolveLayered([
      { source: "db", load: () => Promise.resolve({ k: "from-db" }) },
      { source: "env", load: () => Promise.resolve({ k: "from-env" }) },
    ]);
    expect(got).toEqual({ value: { k: "from-db" }, source: "db" });
  });

  it("falls through past null layers to the first that yields", async () => {
    const got = await resolveLayered([
      { source: "db", load: () => Promise.resolve(null) },
      { source: "env", load: () => Promise.resolve(null) },
      { source: "vault", load: () => Promise.resolve({ k: "from-vault" }) },
    ]);
    expect(got).toEqual({ value: { k: "from-vault" }, source: "vault" });
  });

  it("returns null when every layer is null (disabled)", async () => {
    const got = await resolveLayered([
      { source: "db", load: () => Promise.resolve(null) },
      { source: "vault", load: () => Promise.resolve(null) },
    ]);
    expect(got).toBeNull();
  });

  it("does not consult later layers once one yields (no wasted Vault round-trip)", async () => {
    let vaultCalls = 0;
    await resolveLayered([
      { source: "env", load: () => Promise.resolve({ k: "x" }) },
      {
        source: "vault",
        load: () => {
          vaultCalls += 1;
          return Promise.resolve({ k: "y" });
        },
      },
    ]);
    expect(vaultCalls).toBe(0);
  });
});
