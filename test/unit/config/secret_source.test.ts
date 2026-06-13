import { describe, expect, it } from "vitest";

import { resolveSecretSource } from "#backend/config/secret_source.js";

// The single switch deciding where the two bootstrap secrets (DB creds + field key) are read from:
// a Secret-injected env (`openshift`) or a Vault path (`vault`). Global CODEMASTER_SECRET_SOURCE with
// optional per-secret overrides; the app reads ONLY the chosen source (no fallback) so errors name
// exactly where to fix.
describe("resolveSecretSource", () => {
  it("defaults to openshift when nothing is set", () => {
    expect(resolveSecretSource({})).toBe("openshift");
  });

  it("honors the global CODEMASTER_SECRET_SOURCE", () => {
    expect(resolveSecretSource({ CODEMASTER_SECRET_SOURCE: "vault" })).toBe("vault");
  });

  it("lets a per-secret override win over the global", () => {
    expect(
      resolveSecretSource(
        { CODEMASTER_SECRET_SOURCE: "openshift", CODEMASTER_PG_SECRET_SOURCE: "vault" },
        "CODEMASTER_PG_SECRET_SOURCE",
      ),
    ).toBe("vault");
  });

  it("falls back to the global when the per-secret override is unset", () => {
    expect(
      resolveSecretSource({ CODEMASTER_SECRET_SOURCE: "vault" }, "CODEMASTER_PG_SECRET_SOURCE"),
    ).toBe("vault");
  });

  it("throws on an invalid value, naming the allowed set", () => {
    expect(() => resolveSecretSource({ CODEMASTER_SECRET_SOURCE: "s3" })).toThrow(
      /openshift.*vault|vault.*openshift/,
    );
  });
});
