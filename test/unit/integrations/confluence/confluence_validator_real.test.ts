// Unit tests for the REAL Confluence space-validator + platform-credential probe adapters
// (fix/wire-confluence-adapters). Both inject a STUB ConfluenceClient (the narrow listSpaces slice) so no
// network and no DB are touched:
//   - makeConfluenceValidator.validateSpace: reads the ACTIVE decrypted creds (injected stub reader,
//     mirroring confluence_config_resolver's DB tier) → builds the client → list-spaces reachability:
//       * the space key IS in the list                  → ok=true, validatedAt=now;
//       * the space key is NOT in the list              → ok=false, detail carries "404"/"not found"
//         (so integrations_write's classifier maps it to not_found);
//       * a ConfluenceAuthError (401/403)               → ok=false, detail carries "401"/"auth";
//       * a ConfluenceRateLimitedError                   → ok=false, detail carries "rate";
//       * creds unconfigured (reader returns null)       → ok=false, detail carries "not configured".
//   - makePlatformCredentialProbe.testConfluence: builds the client from the PASSED creds (NOT the DB) +
//     list-spaces smoke, mapping each typed error to a PlatformTestErrorCode; testQwen delegates to
//     probeEmbedder and carries the detected dimension.

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import {
  ConfluenceAuthError,
  ConfluenceNotFoundError,
  ConfluenceProtocolError,
  ConfluenceRateLimitedError,
  ConfluenceRetryableError,
} from "#backend/integrations/confluence/client.js";
import {
  makeConfluenceValidator,
  makePlatformCredentialProbe,
  type ConfluenceListSpacesClient,
} from "#backend/integrations/confluence/confluence_validator_real.js";
import type { ConfluenceSettings } from "#backend/integrations/confluence/confluence_settings_repo.js";

const NOW = new Date("2026-06-15T12:00:00.000Z");

// A space row carrying only the fields the validator reads (space_key). The real client returns
// ConfluenceSpaceV1; the validator only inspects `space_key`, so the stub returns that subset.
const space = (key: string): { space_key: string } => ({ space_key: key });

/** A stub ConfluenceListSpacesClient: returns a fixed space list OR throws a scripted error. */
function stubClient(
  behavior: { spaces: ReadonlyArray<{ space_key: string }> } | { throws: unknown },
): ConfluenceListSpacesClient {
  return {
    listSpaces: async () => {
      if ("throws" in behavior) throw behavior.throws;
      return behavior.spaces as ConfluenceListSpacesClient extends {
        listSpaces(): Promise<infer R>;
      }
        ? R
        : never;
    },
  };
}

const SETTINGS: ConfluenceSettings = {
  baseUrl: "https://acme.atlassian.net/wiki",
  authEmail: "bot@acme.com",
  token: "secret-token",
  enabled: true,
};

describe("makeConfluenceValidator.validateSpace", () => {
  it("ok=true + validatedAt=now when the space key is reachable in the space list", async () => {
    const validator = makeConfluenceValidator({
      readSettings: async () => SETTINGS,
      makeClient: () => stubClient({ spaces: [space("ENG"), space("OPS")] }),
    });
    const r = await validator.validateSpace({ spaceKey: "ENG", now: NOW });
    expect(r.ok).toBe(true);
    expect(r.validatedAt).toBe(NOW);
    expect(r.detail).toMatch(/ENG/);
  });

  it("ok=false + a 404/not-found detail when the space key is absent (→ classifier not_found)", async () => {
    const validator = makeConfluenceValidator({
      readSettings: async () => SETTINGS,
      makeClient: () => stubClient({ spaces: [space("OPS")] }),
    });
    const r = await validator.validateSpace({ spaceKey: "ENG", now: NOW });
    expect(r.ok).toBe(false);
    // Must carry the upstream status/reason integrations_write classifies → not_found.
    expect(r.detail).toMatch(/404|not found/i);
  });

  it("ok=false + an auth detail on ConfluenceAuthError (→ classifier auth_error)", async () => {
    const validator = makeConfluenceValidator({
      readSettings: async () => SETTINGS,
      makeClient: () => stubClient({ throws: new ConfluenceAuthError("GET /api/v2/spaces returned 401") }),
    });
    const r = await validator.validateSpace({ spaceKey: "ENG", now: NOW });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/401|auth/i);
  });

  it("ok=false + a not-found detail on ConfluenceNotFoundError (→ classifier not_found)", async () => {
    const validator = makeConfluenceValidator({
      readSettings: async () => SETTINGS,
      makeClient: () => stubClient({ throws: new ConfluenceNotFoundError("GET /api/v2/spaces returned 404") }),
    });
    const r = await validator.validateSpace({ spaceKey: "ENG", now: NOW });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/404|not found/i);
  });

  it("ok=false + a rate detail on ConfluenceRateLimitedError (→ classifier rate_limited)", async () => {
    const validator = makeConfluenceValidator({
      readSettings: async () => SETTINGS,
      makeClient: () => stubClient({ throws: new ConfluenceRateLimitedError("GET /api/v2/spaces rate-limited") }),
    });
    const r = await validator.validateSpace({ spaceKey: "ENG", now: NOW });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/429|rate/i);
  });

  it("ok=false + a validation detail on a protocol/retryable error (→ classifier validation_failed)", async () => {
    for (const err of [
      new ConfluenceProtocolError("response body is array, expected object"),
      new ConfluenceRetryableError("GET /api/v2/spaces server-errored after 3 attempts: 500"),
    ]) {
      const validator = makeConfluenceValidator({
        readSettings: async () => SETTINGS,
        makeClient: () => stubClient({ throws: err }),
      });
      const r = await validator.validateSpace({ spaceKey: "ENG", now: NOW });
      expect(r.ok).toBe(false);
      // Must NOT accidentally contain 401/404/429/auth/rate/"not found" → falls through to validation_failed.
      expect(r.detail).not.toMatch(/401|404|429|auth|rate|not found/i);
    }
  });

  it("ok=false when Confluence is unconfigured (reader returns null) — never builds a client", async () => {
    let built = false;
    const validator = makeConfluenceValidator({
      readSettings: async () => null,
      makeClient: () => {
        built = true;
        return stubClient({ spaces: [] });
      },
    });
    const r = await validator.validateSpace({ spaceKey: "ENG", now: NOW });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not configured/i);
    expect(built).toBe(false);
  });

  it("passes the decrypted creds (baseUrl/token/authEmail) into the client factory", async () => {
    let seen: { baseUrl: string; token: string; authEmail: string | null } | null = null;
    const validator = makeConfluenceValidator({
      readSettings: async () => SETTINGS,
      makeClient: (creds) => {
        seen = creds;
        return stubClient({ spaces: [space("ENG")] });
      },
    });
    await validator.validateSpace({ spaceKey: "ENG", now: NOW });
    expect(seen).toEqual({
      baseUrl: "https://acme.atlassian.net/wiki",
      token: "secret-token",
      authEmail: "bot@acme.com",
    });
  });
});

describe("makePlatformCredentialProbe.testConfluence", () => {
  const clock = new FakeClock({ now: NOW });

  it("ok=true when list-spaces succeeds; detectedDimension always null; builds from PASSED creds", async () => {
    let seen: { baseUrl: string; token: string; authEmail: string | null } | null = null;
    const probe = makePlatformCredentialProbe({
      clock,
      makeConfluenceClient: (creds) => {
        seen = creds;
        return stubClient({ spaces: [space("ENG")] });
      },
    });
    const r = await probe.testConfluence({ baseUrl: "https://acme.atlassian.net/wiki", token: "tok" });
    expect(r.ok).toBe(true);
    expect(r.errorCode).toBeNull();
    expect(r.errorDetail).toBeNull();
    expect(r.detectedDimension).toBeNull();
    expect(r.latencyMs).not.toBeNull();
    // The probe uses the body creds, NOT the DB; no authEmail is in the body → Bearer (authEmail null).
    expect(seen).toEqual({ baseUrl: "https://acme.atlassian.net/wiki", token: "tok", authEmail: null });
  });

  it("maps ConfluenceAuthError → auth_error", async () => {
    const probe = makePlatformCredentialProbe({
      clock,
      makeConfluenceClient: () => stubClient({ throws: new ConfluenceAuthError("returned 401") }),
    });
    const r = await probe.testConfluence({ baseUrl: "https://x/wiki", token: "t" });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("auth_error");
  });

  it("maps ConfluenceNotFoundError → connectivity_error (wrong base path, not a creds problem)", async () => {
    const probe = makePlatformCredentialProbe({
      clock,
      makeConfluenceClient: () => stubClient({ throws: new ConfluenceNotFoundError("returned 404") }),
    });
    const r = await probe.testConfluence({ baseUrl: "https://x/wiki", token: "t" });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("connectivity_error");
  });

  it("maps ConfluenceRateLimitedError → rate_limited", async () => {
    const probe = makePlatformCredentialProbe({
      clock,
      makeConfluenceClient: () => stubClient({ throws: new ConfluenceRateLimitedError("rate-limited") }),
    });
    const r = await probe.testConfluence({ baseUrl: "https://x/wiki", token: "t" });
    expect(r.errorCode).toBe("rate_limited");
  });

  it("maps a transport/5xx (ConfluenceRetryableError) → connectivity_error", async () => {
    const probe = makePlatformCredentialProbe({
      clock,
      makeConfluenceClient: () => stubClient({ throws: new ConfluenceRetryableError("unreachable after 3") }),
    });
    const r = await probe.testConfluence({ baseUrl: "https://x/wiki", token: "t" });
    expect(r.errorCode).toBe("connectivity_error");
  });

  it("maps a protocol error → validation_failed", async () => {
    const probe = makePlatformCredentialProbe({
      clock,
      makeConfluenceClient: () => stubClient({ throws: new ConfluenceProtocolError("not JSON") }),
    });
    const r = await probe.testConfluence({ baseUrl: "https://x/wiki", token: "t" });
    expect(r.errorCode).toBe("validation_failed");
  });

  it("never leaks the token in errorDetail", async () => {
    const probe = makePlatformCredentialProbe({
      clock,
      makeConfluenceClient: () => stubClient({ throws: new ConfluenceAuthError("returned 401") }),
    });
    const r = await probe.testConfluence({ baseUrl: "https://x/wiki", token: "super-secret-tok" });
    expect(JSON.stringify(r)).not.toContain("super-secret-tok");
  });
});

describe("makePlatformCredentialProbe.testQwen", () => {
  const clock = new FakeClock({ now: NOW });

  it("delegates to probeEmbedder, carrying ok + the detected dimension", async () => {
    const probe = makePlatformCredentialProbe({
      clock,
      probeEmbedderFn: async () => ({ ok: true, detail: "ok", dimension: 1024, code: null }),
    });
    const r = await probe.testQwen({ baseUrl: "http://embedder.local:8080", apiKey: "k" });
    expect(r.ok).toBe(true);
    expect(r.errorCode).toBeNull();
    expect(r.detectedDimension).toBe(1024);
  });

  it("maps a dimension mismatch through to dimension_mismatch + the observed dimension", async () => {
    const probe = makePlatformCredentialProbe({
      clock,
      probeEmbedderFn: async () => ({
        ok: false,
        detail: "embedder returned dimension 512 but ... 1024",
        dimension: 512,
        code: "dimension_mismatch",
      }),
    });
    const r = await probe.testQwen({ baseUrl: "http://embedder.local:8080", apiKey: "k" });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("dimension_mismatch");
    expect(r.detectedDimension).toBe(512);
    expect(r.errorDetail).toMatch(/512/);
  });

  it("forwards the apiKey + the default model name to the embedder probe config", async () => {
    let seenConfig: { baseUrl: string; apiKey: string | null; modelName: string } | null = null;
    const probe = makePlatformCredentialProbe({
      clock,
      probeEmbedderFn: async (config) => {
        seenConfig = config;
        return { ok: true, detail: "ok", dimension: 1024, code: null };
      },
    });
    await probe.testQwen({ baseUrl: "http://embedder.local:8080", apiKey: "qwen-key" });
    expect(seenConfig).not.toBeNull();
    expect(seenConfig!.apiKey).toBe("qwen-key");
    expect(seenConfig!.baseUrl).toBe("http://embedder.local:8080");
    expect(seenConfig!.modelName).toBeTruthy();
  });
});
