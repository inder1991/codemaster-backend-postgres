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

  // Review P1: a THROWING layer (transient DB/Vault outage) must NOT break fall-through — else a core-DB
  // blip would disable a feature whose creds live in env/Vault. The throw is treated as "this layer has
  // nothing" and surfaced via onError (so it's not silent).
  it("falls through a THROWING layer to the next, reporting the error", async () => {
    const errors: Array<{ source: string; message: string }> = [];
    const got = await resolveLayered(
      [
        { source: "db", load: () => Promise.reject(new Error("db connection refused")) },
        { source: "env", load: () => Promise.resolve({ k: "from-env" }) },
      ],
      (source, err) => errors.push({ source, message: err instanceof Error ? err.message : String(err) }),
    );
    expect(got).toEqual({ value: { k: "from-env" }, source: "env" });
    expect(errors).toEqual([{ source: "db", message: "db connection refused" }]);
  });

  it("returns null (disabled) when the only layer throws — fail-closed, not fail-crash", async () => {
    let reported = 0;
    const got = await resolveLayered(
      [{ source: "db", load: () => Promise.reject(new Error("db down")) }],
      () => {
        reported += 1;
      },
    );
    expect(got).toBeNull();
    expect(reported).toBe(1);
  });
});
