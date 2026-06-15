/**
 * REAL Confluence space-validator + platform-credential probe adapters — the live external seams wired at
 * the composition root (server.ts) so:
 *   - POST /api/admin/integrations/confluence-spaces (add space) validates space-reachability BEFORE
 *     persisting (was 503 — getConfluenceValidator unwired), and
 *   - POST /api/admin/confluence-config/test (connectivity test) actually probes Confluence/embedder
 *     (was 503 — getPlatformCredentialProbe unwired).
 *
 * Both reuse the established patterns:
 *   - validateSpace reads the ACTIVE decrypted creds the SAME way the ingest sync resolves them — the DB
 *     tier of confluence_config_resolver: PostgresConfluenceSettingsRepo({db, registry}).read() (the
 *     field-codec-decrypted platform-scope row). validateSpace receives NO creds (it is a pre-write probe
 *     of the operator-saved config), so it must read them itself.
 *   - testConfluence builds the client from the PASSED creds (the route stages base_url + token in the
 *     request body — NOT the DB), mirroring the LLM test-credentials UX.
 *   - the ConfluenceClient construction mirrors makeLazyConfluenceChunkClient (_confluence_page_sync.ts):
 *     authEmail (when present) selects HTTP-Basic (Atlassian Cloud); absent → Bearer (Server/DC PAT).
 *   - both list-spaces (GET /api/v2/spaces) for the reachability/smoke check (the only space-scoped read
 *     the client exposes — there is no get-space-by-key endpoint).
 *   - testQwen delegates to probeEmbedder (adapters/embedder_probe.ts) and adapts its EmbedderProbeResult
 *     to PlatformTestResult (carrying the detected dimension).
 *
 * The injected client factory / settings reader / probe fn are the unit-test seams (stubbed — no network,
 * no DB); production omits them and the real defaults are used.
 *
 * LIVE-CONFLUENCE VERIFICATION REQUIRED before shipping (per confluence_validator.ts header): the
 * list-spaces reachability + the error-class → detail/code mapping must be exercised against live
 * Atlassian Cloud + a self-hosted Data Center instance.
 */

import { type Kysely } from "kysely";

import { type Clock, WallClock } from "#platform/clock.js";
import { type KeyRegistry } from "#platform/crypto/key_registry.js";

import { probeEmbedder as defaultProbeEmbedder, type EmbedderProbeResult } from "#backend/adapters/embedder_probe.js";
import { DEFAULT_EMBEDDER_MODEL_NAME } from "#backend/adapters/embeddings_port.js";
import {
  ConfluenceAuthError,
  ConfluenceClient,
  ConfluenceNotFoundError,
  ConfluenceRateLimitedError,
} from "#backend/integrations/confluence/client.js";
import {
  type ConfluenceSettings,
  PostgresConfluenceSettingsRepo,
} from "#backend/integrations/confluence/confluence_settings_repo.js";
import {
  type ConfluenceValidationResult,
  type ConfluenceValidatorPort,
} from "#backend/integrations/confluence/confluence_validator.js";

import {
  type PlatformCredentialProbePort,
  type PlatformTestResult,
} from "#backend/api/admin/platform_credentials_probe.js";

import { type PlatformTestErrorCode } from "#contracts/admin.v1.js";

// ─── Narrow client slice ────────────────────────────────────────────────────────────────────────

/** The narrow list-spaces slice both adapters drive; the real {@link ConfluenceClient} satisfies it
 *  structurally (its `listSpaces` returns rows carrying `space_key`). Tests inject a stub. */
export type ConfluenceListSpacesClient = {
  listSpaces(): Promise<ReadonlyArray<{ space_key: string }>>;
};

/** The decrypted creds the client factory builds from. */
type ConfluenceCreds = { baseUrl: string; token: string; authEmail: string | null };

/** Build a real {@link ConfluenceClient} for the list-spaces slice — 1:1 with the auth-scheme selection in
 *  makeLazyConfluenceChunkClient (authEmail present → Basic; absent → Bearer). `authEmail` is OMITTED (not
 *  set to undefined) when null, per exactOptionalPropertyTypes. */
function buildRealClient(creds: ConfluenceCreds): ConfluenceListSpacesClient {
  return new ConfluenceClient({
    baseUrl: creds.baseUrl,
    bearerToken: creds.token,
    ...(creds.authEmail !== null ? { authEmail: creds.authEmail } : {}),
  });
}

// ─── Confluence space validator ───────────────────────────────────────────────────────────────────

export type MakeConfluenceValidatorOptions = {
  /** Production wiring (the composition root passes these): the shared core Kysely + the boot key
   *  registry. Used to build the default `readSettings` (the DB tier — field-codec decrypt). */
  db?: Kysely<unknown>;
  registry?: KeyRegistry;
  /** Test seam: read the ACTIVE decrypted Confluence creds (null when unconfigured/disabled). Default:
   *  PostgresConfluenceSettingsRepo({db, registry}).read() (requires `db` + `registry`). */
  readSettings?: () => Promise<ConfluenceSettings | null>;
  /** Test seam: build the list-spaces client from the resolved creds. Default: the real ConfluenceClient. */
  makeClient?: (creds: ConfluenceCreds) => ConfluenceListSpacesClient;
};

/**
 * The REAL {@link ConfluenceValidatorPort}. `validateSpace`:
 *   1. reads the active decrypted creds (the DB tier — same as the ingest sync);
 *   2. builds the Confluence client (Basic/Bearer per authEmail);
 *   3. lists spaces and checks the key is reachable.
 * On any failure the `detail` carries the upstream status/reason so integrations_write.ts's classifier
 * maps it to a stable code (auth_error/rate_limited/not_found/validation_failed). Never throws — a thrown
 * error would surface as a route 500; every outcome is a {ok, detail, validatedAt}.
 */
export function makeConfluenceValidator(opts: MakeConfluenceValidatorOptions = {}): ConfluenceValidatorPort {
  const readSettings =
    opts.readSettings ??
    (async (): Promise<ConfluenceSettings | null> => {
      if (opts.db === undefined || opts.registry === undefined) {
        throw new Error(
          "makeConfluenceValidator: default readSettings requires { db, registry } (or inject readSettings)",
        );
      }
      return new PostgresConfluenceSettingsRepo({ db: opts.db, registry: opts.registry }).read();
    });
  const makeClient = opts.makeClient ?? buildRealClient;

  return {
    async validateSpace({ spaceKey, now }): Promise<ConfluenceValidationResult> {
      let settings: ConfluenceSettings | null;
      try {
        settings = await readSettings();
      } catch (err) {
        // A DB/decrypt failure reading the saved creds: treat as a validation failure (the route maps it to
        // validation_failed) rather than a 500 — the operator can re-save the config.
        return { ok: false, detail: `could not read Confluence configuration: ${errMsg(err)}`, validatedAt: now };
      }
      if (settings === null) {
        // Unconfigured/disabled → validation_failed (no 401/404/429/auth/rate/"not found" tokens).
        return {
          ok: false,
          detail: "Confluence is not configured (no platform credentials saved); save the Confluence config first.",
          validatedAt: now,
        };
      }

      const client = makeClient({
        baseUrl: settings.baseUrl,
        token: settings.token,
        authEmail: settings.authEmail,
      });

      let spaces: ReadonlyArray<{ space_key: string }>;
      try {
        spaces = await client.listSpaces();
      } catch (err) {
        return { ok: false, detail: confluenceErrorDetail(err), validatedAt: now };
      }

      const reachable = spaces.some((s) => s.space_key === spaceKey);
      if (!reachable) {
        // The service account can authenticate but the space is not visible/does not exist → not_found. The
        // literal "404" + "not found" both steer integrations_write's classifier to not_found.
        return {
          ok: false,
          detail: `404: space '${spaceKey}' is not reachable by the service account (not found among the visible spaces).`,
          validatedAt: now,
        };
      }
      return { ok: true, detail: `space '${spaceKey}' is reachable`, validatedAt: now };
    },
  };
}

/**
 * Map a thrown ConfluenceClient error to a free-form `detail` carrying the upstream status/reason the route
 * classifier keys on. The client's own messages already embed the status ("returned 401", "rate-limited"),
 * but we prefix an explicit status token so the mapping is robust even if the message wording changes.
 *   - auth (401/403)  → "401 ..."        → auth_error
 *   - rate-limited     → "429 ... rate"  → rate_limited
 *   - not found (404)  → "404 ..."        → not_found
 *   - anything else    → no keyword       → validation_failed
 */
function confluenceErrorDetail(err: unknown): string {
  if (err instanceof ConfluenceAuthError) {
    return `401/403 auth error: ${err.message}`;
  }
  if (err instanceof ConfluenceRateLimitedError) {
    return `429 rate-limited: ${err.message}`;
  }
  if (err instanceof ConfluenceNotFoundError) {
    return `404 not found: ${err.message}`;
  }
  // ConfluenceProtocolError / ConfluenceRetryableError / anything else → validation_failed. Strip any
  // accidental status keywords so the classifier does not mis-route (e.g. a 5xx body echoing "404").
  return `Confluence reachability check failed: ${sanitizeForValidationFailed(err)}`;
}

/** Render an error message for the validation_failed bucket, removing tokens that would mis-route the
 *  classifier (401/403/404/429/auth/rate/"not found"). */
function sanitizeForValidationFailed(err: unknown): string {
  const raw = errMsg(err);
  return raw.replace(/\b(401|403|404|429)\b/g, "5xx").replace(/auth|rate|not found/gi, "error");
}

// ─── Platform-credential probe ──────────────────────────────────────────────────────────────────

export type MakePlatformCredentialProbeOptions = {
  /** Duration clock (default {@link WallClock}); FakeClock in tests. Measures latencyMs via monotonic(). */
  clock?: Clock;
  /** Test seam: build the list-spaces client from the PASSED body creds. Default: the real ConfluenceClient
   *  (Bearer — the /test body carries no email, so the Server/DC PAT scheme; see the divergence note). */
  makeConfluenceClient?: (creds: ConfluenceCreds) => ConfluenceListSpacesClient;
  /** Test seam: the embedder probe. Default: the real probeEmbedder (production fetch transport). */
  probeEmbedderFn?: (config: { baseUrl: string; apiKey: string | null; modelName: string }) => Promise<EmbedderProbeResult>;
  /** The model name testQwen probes with (the /test body carries no model). Default DEFAULT_EMBEDDER_MODEL_NAME. */
  embedderModelName?: string;
};

/**
 * The REAL {@link PlatformCredentialProbePort}.
 *   - testConfluence: builds the client from the PASSED creds + a list-spaces smoke, mapping each typed
 *     ConfluenceClient error to a PlatformTestErrorCode. detectedDimension is always null (confluence).
 *
 *     DIVERGENCE (must verify against live Cloud): the /test route body carries only { base_url, token }
 *     (no auth_email), so this builds a BEARER client. Atlassian Cloud uses HTTP-Basic (email:token); a
 *     Cloud connectivity test through THIS path would therefore fail auth even with valid creds. The route
 *     contract does not pass an email, so this matches the wire — but a Cloud deployment relies on the
 *     SAVED-config validator (validateSpace, which reads authEmail from the DB), not this body-creds test.
 *
 *   - testQwen: delegates to probeEmbedder and carries the detected dimension.
 */
export function makePlatformCredentialProbe(
  opts: MakePlatformCredentialProbeOptions = {},
): PlatformCredentialProbePort {
  const clock = opts.clock ?? new WallClock();
  const makeConfluenceClient = opts.makeConfluenceClient ?? buildRealClient;
  const probeEmbedderFn = opts.probeEmbedderFn ?? ((config) => defaultProbeEmbedder(config));
  const embedderModelName = opts.embedderModelName ?? DEFAULT_EMBEDDER_MODEL_NAME;

  return {
    async testConfluence({ baseUrl, token }): Promise<PlatformTestResult> {
      const startedAt = clock.monotonic();
      // No email in the /test body → Bearer (see the divergence note above).
      const client = makeConfluenceClient({ baseUrl, token, authEmail: null });
      try {
        await client.listSpaces();
        return {
          ok: true,
          errorCode: null,
          errorDetail: null,
          latencyMs: elapsedMs(clock, startedAt),
          detectedDimension: null,
        };
      } catch (err) {
        const { code, detail } = classifyConfluenceProbeError(err, token);
        return {
          ok: false,
          errorCode: code,
          errorDetail: detail,
          latencyMs: elapsedMs(clock, startedAt),
          detectedDimension: null,
        };
      }
    },

    async testQwen({ baseUrl, apiKey }): Promise<PlatformTestResult> {
      const startedAt = clock.monotonic();
      const result = await probeEmbedderFn({ baseUrl, apiKey, modelName: embedderModelName });
      return {
        ok: result.ok,
        errorCode: result.code,
        errorDetail: result.ok ? null : result.detail,
        latencyMs: elapsedMs(clock, startedAt),
        detectedDimension: result.dimension,
      };
    },
  };
}

/**
 * Map a thrown ConfluenceClient error to a {@link PlatformTestErrorCode} + a token-redacted detail.
 *   - auth (401/403)       → auth_error          (actionable: check the token);
 *   - rate-limited (429)    → rate_limited;
 *   - not found (404)       → connectivity_error  (a 404 on /api/v2/spaces is a wrong base_url / path, not a
 *                             creds problem — the operator should fix the URL, not the token);
 *   - protocol error        → validation_failed   (a non-JSON/unexpected body — likely not Confluence);
 *   - retryable (5xx/network)/anything else → connectivity_error.
 */
function classifyConfluenceProbeError(
  err: unknown,
  token: string,
): { code: PlatformTestErrorCode; detail: string } {
  const detail = redactToken(errMsg(err), token);
  if (err instanceof ConfluenceAuthError) {
    return { code: "auth_error", detail };
  }
  if (err instanceof ConfluenceRateLimitedError) {
    return { code: "rate_limited", detail };
  }
  if (err instanceof ConfluenceNotFoundError) {
    return { code: "connectivity_error", detail };
  }
  // ConfluenceProtocolError is the "this is not a Confluence v2 API / malformed body" signal.
  if (err instanceof Error && err.name === "ConfluenceProtocolError") {
    return { code: "validation_failed", detail };
  }
  // ConfluenceRetryableError (5xx / network / transport) + any unexpected error → connectivity_error.
  return { code: "connectivity_error", detail };
}

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Redact the plaintext token from a detail string (no-op for short tokens; mirrors stripToken). */
function redactToken(message: string, token: string): string {
  if (!token || token.length < 8) return message;
  return message.split(token).join("<REDACTED-TOKEN>");
}

/** Elapsed ms since `startedMonotonic` (seconds axis → ms), floored at 0. */
function elapsedMs(clock: Clock, startedMonotonic: number): number {
  return Math.max(0, Math.round((clock.monotonic() - startedMonotonic) * 1000));
}
