import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { InstallationTokenV1 } from "#contracts/installation_token.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the inline
// `InstallationTokenV1` model in the frozen integrations module via the oracle —
// `InstallationTokenV1(**payload).model_dump(mode="json")`) and through Zod
// (`InstallationTokenV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
//
// `expires_at` is a PLAIN `datetime` on the Python model: a Z-bearing aware value dumps via isoformat
// as `...Z`; the canonicalizer normalizes both `Z` and `+00:00` to `.ffffff+00:00` so the instant
// compares equal regardless of the offset spelling. The `token` field rejects empty AND
// whitespace-only (the `@field_validator` `_no_whitespace_only`); `extra="forbid"` ↔ `.strict()`.
const PY = "codemaster.integrations.github.installation_token";

describe("InstallationTokenV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically (Z offset)", async () => {
    const payload = {
      token: "ghs_redactedtokenvalue",
      expires_at: "2026-05-02T13:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "InstallationTokenV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(InstallationTokenV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = {
      token: "ghs_x",
      expires_at: "2026-05-02T13:00:00.123456+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "InstallationTokenV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(InstallationTokenV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an empty token (min_length=1)", async () => {
    const bad = { token: "", expires_at: "2026-05-02T13:00:00+00:00" };
    const r = await pyRef({ pyModule: PY, pyCallable: "InstallationTokenV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => InstallationTokenV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a whitespace-only token (_no_whitespace_only)", async () => {
    const bad = { token: "   ", expires_at: "2026-05-02T13:00:00+00:00" };
    const r = await pyRef({ pyModule: PY, pyCallable: "InstallationTokenV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => InstallationTokenV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      token: "ghs_x",
      expires_at: "2026-05-02T13:00:00+00:00",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "InstallationTokenV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => InstallationTokenV1.parse(bad)).toThrow();
  }, 30_000);
});
