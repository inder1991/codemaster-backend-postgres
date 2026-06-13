/**
 * ConfluenceClient — read-only typed client over Node's NATIVE `fetch`. The byte-significant logic is
 * the `_get_json` decision loop + the parsers.
 *
 *   Locked failure-mode table:
 *     - 401 Unauthorized      → {@link ConfluenceAuthError}     (fail-closed)
 *     - 403 Forbidden         → {@link ConfluenceAuthError}     (fail-closed)
 *     - 404 Not Found         → {@link ConfluenceNotFoundError} (fail-closed)
 *     - 429 Too Many Requests → exponential backoff (honoring a server `Retry-After` when present,
 *                               capped at 600s) up to a 6-attempt budget, then {@link ConfluenceRateLimitedError}
 *     - 5xx Server Error      → 3-attempt budget with exponential backoff, then {@link ConfluenceRetryableError}
 *     - a THROWN transport error → retried per the 5xx budget, then {@link ConfluenceRetryableError}
 *     - malformed body / unexpected 4xx → {@link ConfluenceProtocolError}
 *
 * Backoff schedule (1:1): (1, 2, 4, 8, 15, 30)s, with SEPARATE indices per error class (S15.D — a
 * 429 storm must not inflate the 5xx backoff start position, and vice-versa).
 *
 * --- Injected seams (everything non-deterministic is injected) ---
 *   - `fetch`: the HTTP transport. Production default: `globalThis.fetch` (undici; NO new dependency).
 *     Tests inject a fake fetch returning the static RESPONSE-fixture cassettes.
 *   - `clock`: ALL timing — the backoff `sleep` AND the F-42 Retry-After `now` read — goes through the
 *     injected {@link Clock} (`clock.sleep` / `clock.now`), NEVER `setTimeout`/`Date`. The
 *     check_clock_random gate enforces this.
 *   - `bearerToken` XOR `tokenProvider`: the credential. `tokenProvider` is invoked PER request so
 *     token rotation propagates without restart (the Python `_current_bearer_token` contract).
 *
 * Auth scheme (1:1 with `_authorization_header`):
 *   - `authEmail` set     → HTTP Basic `base64(email:token)` (Atlassian Cloud API-token scheme).
 *   - `authEmail` absent  → `Bearer <token>` (Server/Data-Center PAT — the ATATT classic-token default).
 *
 * Endpoints (verified against client.py):
 *   - GET `<baseUrl>/api/v2/spaces`
 *   - GET `<baseUrl>/api/v2/pages?space-key=<KEY>&limit=25[&cursor=<c>]`
 *   - GET `<baseUrl>/api/v2/pages/{id}?body-format=storage&include-labels=true`
 *   - GET `<baseUrl>/api/v2/pages/{id}/labels` (the empty-inline-labels fallback)
 *   `baseUrl` ends with `/wiki`; the client appends the `/api/v2/...` paths.
 */

/* eslint-disable security/detect-object-injection --
 * Every computed index access in this file is one of: (a) a bounded numeric index into a local
 * constant array (RETRY_BACKOFF_SECONDS / the backoff-idx walk), (b) a literal string key on a
 * locally-built params/statusMap object, or (c) a read of a known wire field name off a decoded
 * JSON record (`row["id"]`, `version["number"]`). None are attacker-controlled OBJECT KEYS used to
 * write into a prototype-bearing target, so the rule's prototype-pollution threat model does not apply.
 */

import { type Clock, WallClock } from "#platform/clock.js";

import {
  ConfluencePageListV1,
  ConfluencePageSummaryV1,
  ConfluencePageV1,
  ConfluenceSpaceV1,
} from "#contracts/confluence_wire.v1.js";

// ─── Constants ────────────────────────────────────────────────────────────────────────────────

/**
 * Backoff schedule for 429 + 5xx retries. Capped at 30s per call; total budget stays under the
 * activity timeout the ingest worker uses.
 */
const RETRY_BACKOFF_SECONDS: ReadonlyArray<number> = [1.0, 2.0, 4.0, 8.0, 15.0, 30.0];

/**
 * F-42: cap a server-supplied Retry-After at this many seconds. Atlassian Cloud has been observed
 * returning multi-minute values on sustained quota exhaustion.
 */
const MAX_RETRY_AFTER_SECONDS = 600; // 10 minutes

/** 5xx + connection-error retry budget (1:1 with `_RETRY_BUDGET_FOR_5XX`). */
const RETRY_BUDGET_FOR_5XX = 3;
/** 429 retry budget — the full backoff schedule length. */
const RETRY_BUDGET_FOR_429 = 6;

// HTTP status thresholds.
const HTTP_OK_MIN = 200;
const HTTP_REDIRECT_MIN = 300;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;

// ─── F-42 Retry-After parsing (1:1 with `_parse_retry_after_seconds`) ───────────────────────────

/**
 * Parse an RFC-7231 Retry-After header → seconds-from-now. Returns `null` when absent/malformed (caller
 * falls back to local exp-backoff). Two forms per RFC-7231 §7.1.3: delta-seconds (`120`) or HTTP-date
 * (`Wed, 21 Oct 2026 07:28:00 GMT`). The HTTP-date branch returns `max(0, server_time - now)` so a
 * past-time degrades to zero-sleep. `nowUtc` is caller-supplied (the injected clock) per the Clock Protocol.
 */
export function parseRetryAfterSeconds(headerValue: string | null, nowUtc: Date): number | null {
  if (headerValue === null) return null;
  const stripped = headerValue.trim();
  if (stripped === "") return null;
  // Branch 1 — delta-seconds (integer). Python `int(stripped)` accepts an optional sign + digits ONLY.
  if (/^[+-]?\d+$/.test(stripped)) {
    return Number.parseInt(stripped, 10);
  }
  // Branch 2 — HTTP-date. `Date.parse` handles RFC-1123 / RFC-7231 HTTP-date (assumes UTC when no tz).
  const retryAtMs = Date.parse(stripped);
  if (Number.isNaN(retryAtMs)) return null;
  const delta = (retryAtMs - nowUtc.getTime()) / 1000;
  return Math.max(0.0, delta);
}

// ─── Exceptions ──────────────────────────────────────────────────────────────────────────────────

/** Base class for all client-level Confluence errors. */
export class ConfluenceClientError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfluenceClientError";
  }
}

/** 401 / 403 — credentials rotated or scope insufficient. Fail-closed. */
export class ConfluenceAuthError extends ConfluenceClientError {
  public constructor(message: string) {
    super(message);
    this.name = "ConfluenceAuthError";
  }
}

/** 404 — page / space deleted between list + get. */
export class ConfluenceNotFoundError extends ConfluenceClientError {
  public constructor(message: string) {
    super(message);
    this.name = "ConfluenceNotFoundError";
  }
}

/** Exhausted the 429 backoff budget. */
export class ConfluenceRateLimitedError extends ConfluenceClientError {
  public constructor(message: string) {
    super(message);
    this.name = "ConfluenceRateLimitedError";
  }
}

/** Exhausted the 5xx retry budget. */
export class ConfluenceRetryableError extends ConfluenceClientError {
  public constructor(message: string) {
    super(message);
    this.name = "ConfluenceRetryableError";
  }
}

/** Response shape didn't match the locked contract. */
export class ConfluenceProtocolError extends ConfluenceClientError {
  public constructor(message: string) {
    super(message);
    this.name = "ConfluenceProtocolError";
  }
}

// ─── Injected fetch seam ────────────────────────────────────────────────────────────────────────

/**
 * The injected HTTP transport — a subset of the native `fetch` signature. Production passes
 * `globalThis.fetch`; tests pass a fake returning a {@link Response}-shaped object. The client reads
 * `.status`, `.headers.get(name)`, and `.json()` off the result.
 */
export type ConfluenceFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>;

// ─── Client ───────────────────────────────────────────────────────────────────────────────────

export type ConfluenceClientOptions = {
  /** Confluence base URL rooted at `/wiki` (Cloud) or the on-prem equivalent. */
  baseUrl: string;
  /** Opaque service-account token. Mutually exclusive with `tokenProvider`. */
  bearerToken?: string;
  /** Async callable returning the current bearer token (invoked per request). Mutually exclusive with `bearerToken`. */
  tokenProvider?: () => Promise<string>;
  /**
   * When set, authenticate with HTTP Basic `email:token` (Atlassian Cloud). When absent, use
   * `Bearer <token>` (Server/Data-Center PATs — the ATATT classic-token default).
   */
  authEmail?: string;
  /** Injected fetch (default `globalThis.fetch`). */
  fetch?: ConfluenceFetch;
  /** Injected clock (default {@link WallClock}) — backoff sleeps + F-42 Retry-After `now`. */
  clock?: Clock;
};

export class ConfluenceClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string | null;
  private readonly tokenProvider: (() => Promise<string>) | null;
  private readonly authEmail: string | null;
  private readonly fetchImpl: ConfluenceFetch;
  private readonly clock: Clock;

  public constructor({
    baseUrl,
    bearerToken,
    tokenProvider,
    authEmail,
    fetch,
    clock,
  }: ConfluenceClientOptions) {
    if (bearerToken === undefined && tokenProvider === undefined) {
      throw new Error("ConfluenceClient requires either bearerToken or tokenProvider");
    }
    if (bearerToken !== undefined && tokenProvider !== undefined) {
      throw new Error("ConfluenceClient cannot accept both bearerToken and tokenProvider");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.bearerToken = bearerToken ?? null;
    this.tokenProvider = tokenProvider ?? null;
    this.authEmail = authEmail ?? null;
    // Default to the native global fetch (undici). NO new HTTP dependency — the GitHub clients do this too.
    this.fetchImpl = fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.clock = clock ?? new WallClock();
  }

  // ─── Public methods ──────────────────────────────────────────────────────────────────────────

  /** GET /api/v2/spaces → the visible spaces (1:1 with `list_spaces`). */
  public async listSpaces(): Promise<ReadonlyArray<ConfluenceSpaceV1>> {
    const payload = await this.getJson("/api/v2/spaces");
    const results = ConfluenceClient.requireList(payload, "results");
    return results
      .filter((row): row is Record<string, unknown> => isRecord(row))
      .map((row) => this.parseSpace(row));
  }

  /**
   * GET /api/v2/pages?space-key=<KEY>&limit=25[&cursor=<c>] → one page of the page list (1:1 with
   * `list_pages`). The caller threads `cursor` from a prior page's `next_cursor`.
   */
  public async listPages({
    spaceKey,
    cursor = null,
  }: {
    spaceKey: string;
    cursor?: string | null;
  }): Promise<ConfluencePageListV1> {
    const params: Record<string, string> = { "space-key": spaceKey, limit: "25" };
    if (cursor !== null) params["cursor"] = cursor;
    const payload = await this.getJson("/api/v2/pages", params);
    const results = ConfluenceClient.requireList(payload, "results");
    const items = results
      .filter((row): row is Record<string, unknown> => isRecord(row))
      .map((row) => this.parsePageSummary(row, spaceKey));
    const nextCursor = ConfluenceClient.extractNextCursor(payload);
    return ConfluencePageListV1.parse({ schema_version: 1, items, next_cursor: nextCursor });
  }

  /**
   * GET /api/v2/pages/{id}?body-format=storage&include-labels=true → one page version (1:1 with
   * `get_page`). When inline labels are EMPTY, fetches the dedicated /labels resource and merges
   * (resilient — a labels-fetch failure leaves the empty inline labels).
   */
  public async getPage({
    pageId,
    spaceKey = null,
  }: {
    pageId: string;
    spaceKey?: string | null;
  }): Promise<ConfluencePageV1> {
    const payload = await this.getJson(`/api/v2/pages/${pageId}`, {
      "body-format": "storage",
      "include-labels": "true",
    });
    let page = this.parsePage(payload, spaceKey);
    // Live Atlassian Cloud v2 returns EMPTY inline labels even with include-labels=true; the real labels
    // live on the dedicated /labels resource. Fetch it when inline is empty so label-based corpus curation
    // sees them. Resilient: a fetch failure leaves the (empty) inline labels.
    if (page.labels.length === 0) {
      const dedicated = await this.fetchPageLabels(pageId);
      if (dedicated.length > 0) {
        page = { ...page, labels: dedicated };
      }
    }
    return page;
  }

  /** Return label names from the dedicated v2 labels resource, or [] (1:1 with `_fetch_page_labels`). */
  private async fetchPageLabels(pageId: string): Promise<Array<string>> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.getJson(`/api/v2/pages/${pageId}/labels`);
    } catch (e) {
      // Resilient: swallow the same error classes the Python catches; any other class propagates.
      if (
        e instanceof ConfluenceNotFoundError ||
        e instanceof ConfluenceAuthError ||
        e instanceof ConfluenceProtocolError
      ) {
        return [];
      }
      throw e;
    }
    const results = payload["results"];
    if (!Array.isArray(results)) return [];
    return results
      .filter((item): item is Record<string, unknown> => isRecord(item) && Boolean(item["name"]))
      .map((item) => String(item["name"]));
  }

  // ─── Parsers ─────────────────────────────────────────────────────────────────────────────────

  private parseSpace(row: Record<string, unknown>): ConfluenceSpaceV1 {
    try {
      return ConfluenceSpaceV1.parse({
        schema_version: 1,
        space_id: requireField(row, "id"),
        space_key: requireField(row, "key"),
        name: requireField(row, "name"),
      });
    } catch (err) {
      throw new ConfluenceProtocolError(
        `space row missing/invalid required field: ${formatErr(err)}`,
      );
    }
  }

  private parsePageSummary(
    row: Record<string, unknown>,
    spaceKey: string | null,
  ): ConfluencePageSummaryV1 {
    try {
      return ConfluencePageSummaryV1.parse({
        schema_version: 1,
        page_id: requireField(row, "id"),
        space_key: spaceKey !== null ? spaceKey : ConfluenceClient.extractSpaceKey(row),
        title: requireField(row, "title"),
        version: ConfluenceClient.extractVersionNumber(row),
        last_modified_at: ConfluenceClient.parseDt(
          versionCreatedAt(row) ?? row["createdAt"],
        ),
      });
    } catch (err) {
      throw new ConfluenceProtocolError(
        `page-list row missing/invalid required field: ${formatErr(err)}`,
      );
    }
  }

  private parsePage(row: Record<string, unknown>, spaceKey: string | null): ConfluencePageV1 {
    try {
      const body = isRecord(row["body"]) ? row["body"] : {};
      const storage = isRecord(body["storage"]) ? body["storage"] : {};
      const bodyHtml = typeof storage["value"] === "string" ? storage["value"] : "";

      // Labels: the live v2 payload puts them at the TOP level (`labels.results[].name`); older/observed
      // shapes nest them under `metadata.labels`. Prefer top-level, fall back to metadata.
      let labelsBlock = row["labels"];
      if (!isRecord(labelsBlock)) {
        const metadata = isRecord(row["metadata"]) ? row["metadata"] : {};
        labelsBlock = isRecord(metadata["labels"]) ? metadata["labels"] : {};
      }
      const labelResults = isRecord(labelsBlock) && Array.isArray(labelsBlock["results"])
        ? labelsBlock["results"]
        : [];
      const labels = labelResults
        .filter((item): item is Record<string, unknown> => isRecord(item) && Boolean(item["name"]))
        .map((item) => String(item["name"]));

      // Normalize Confluence native status → the wire-layer values.
      const rawStatus = typeof row["status"] === "string" ? row["status"] : "current";
      const statusMap: Record<string, string> = {
        current: "active",
        draft: "draft",
        archived: "archived",
        trashed: "archived",
        historical: "archived",
      };
      const status = statusMap[rawStatus] ?? "active";

      return ConfluencePageV1.parse({
        schema_version: 2,
        page_id: requireField(row, "id"),
        space_key: spaceKey !== null ? spaceKey : ConfluenceClient.extractSpaceKey(row),
        title: requireField(row, "title"),
        version: ConfluenceClient.extractVersionNumber(row),
        body_html: bodyHtml,
        last_modified_at: ConfluenceClient.parseDt(versionCreatedAt(row) ?? row["createdAt"]),
        labels,
        status,
      });
    } catch (err) {
      throw new ConfluenceProtocolError(
        `page payload missing/invalid required field: ${formatErr(err)}`,
      );
    }
  }

  /**
   * Confluence v2 nests the space key under either `spaceKey` (compact) or `space.key` (expanded).
   * (1:1 with `_extract_space_key`.) The v2 page payload identifies its space by NUMERIC `spaceId`, NOT
   * a key — so callers thread the known `space_key` and this is only the fallback for callers that don't.
   */
  private static extractSpaceKey(row: Record<string, unknown>): string {
    if ("spaceKey" in row) return String(row["spaceKey"]);
    const space = row["space"];
    if (isRecord(space) && "key" in space) return String(space["key"]);
    throw new Error("spaceKey");
  }

  /** Extract the integer version number from `version.number` or a bare `version` int (1:1 with `_extract_version_number`). */
  private static extractVersionNumber(row: Record<string, unknown>): number {
    const version = row["version"];
    if (isRecord(version)) {
      const n = version["number"];
      if (typeof n === "number" && Number.isInteger(n)) return n;
    }
    if (typeof version === "number" && Number.isInteger(version)) return version;
    throw new Error("version");
  }

  /** Parse a Confluence ISO-8601 datetime string (accepts `Z` suffix). (1:1 with `_parse_dt`.) */
  private static parseDt(raw: unknown): string {
    if (typeof raw !== "string") {
      throw new Error(`datetime field is ${typeof raw}, expected string`);
    }
    // `datetime.fromisoformat` would raise on a non-ISO string; the contract's z.string().datetime()
    // validates the shape, so we pass the raw string through and let Zod enforce. A malformed value
    // surfaces as a ZodError caught by the parser → ConfluenceProtocolError (same as the Python ValueError).
    return raw;
  }

  /**
   * Extract the next-page cursor from `_links.next` (a relative URL with the cursor in the query string)
   * (1:1 with `_extract_next_cursor`). Returns the URL-decoded cursor value, or null.
   */
  private static extractNextCursor(payload: Record<string, unknown>): string | null {
    const links = payload["_links"];
    if (!isRecord(links)) return null;
    const nextUrl = links["next"];
    if (typeof nextUrl !== "string" || nextUrl === "") return null;
    // Parse `cursor=...` out of the query string; URL-decode the value. A relative URL needs a base for
    // the URL parser — use a throwaway origin since we only read the query string.
    let query: URLSearchParams;
    try {
      query = new URL(nextUrl, "https://placeholder.invalid").searchParams;
    } catch {
      return null;
    }
    return query.get("cursor");
  }

  // ─── HTTP wrapper (1:1 with `_get_json`) ──────────────────────────────────────────────────────

  private static requireList(payload: Record<string, unknown>, key: string): Array<unknown> {
    const results = payload[key];
    if (!Array.isArray(results)) {
      throw new ConfluenceProtocolError(`response payload missing/invalid \`${key}\` list`);
    }
    return results;
  }

  private async currentBearerToken(): Promise<string> {
    if (this.tokenProvider !== null) return this.tokenProvider();
    return this.bearerToken ?? "";
  }

  /** Build the Authorization header value for the configured scheme (1:1 with `_authorization_header`). */
  private authorizationHeader(token: string): string {
    if (this.authEmail !== null && this.authEmail !== "") {
      return "Basic " + Buffer.from(`${this.authEmail}:${token}`).toString("base64");
    }
    return `Bearer ${token}`;
  }

  /**
   * Drives the retry / rate-limit / error-taxonomy loop; returns the decoded JSON dict on 2xx or raises
   * a typed error. SEPARATE backoff indices per error class (S15.D).
   */
  private async getJson(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
    const query = params !== undefined ? "?" + new URLSearchParams(params).toString() : "";
    const url = `${this.baseUrl}${path}${query}`;
    const token = await this.currentBearerToken();
    const headers = {
      Authorization: this.authorizationHeader(token),
      Accept: "application/json",
    };

    let attempts5xx = 0;
    let attempts429 = 0;
    let rateLimitBackoffIdx = 0;
    let serverErrorBackoffIdx = 0;

    for (;;) {
      let resp: Response;
      try {
        resp = await this.fetchImpl(url, { method: "GET", headers });
      } catch (err) {
        // A THROWN transport/network error — retry per the 5xx budget (1:1 with the httpx.RequestError branch).
        attempts5xx += 1;
        if (attempts5xx >= RETRY_BUDGET_FOR_5XX) {
          throw new ConfluenceRetryableError(
            `GET ${path} unreachable after ${attempts5xx} attempts: ${formatErr(err)}`,
          );
        }
        await this.clock.sleep(RETRY_BACKOFF_SECONDS[serverErrorBackoffIdx]!);
        serverErrorBackoffIdx = Math.min(serverErrorBackoffIdx + 1, RETRY_BACKOFF_SECONDS.length - 1);
        continue;
      }

      const status = resp.status;

      if (status >= HTTP_OK_MIN && status < HTTP_REDIRECT_MIN) {
        return ConfluenceClient.parseJson(await ConfluenceClient.decodeJson(resp));
      }
      if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
        throw new ConfluenceAuthError(
          `GET ${path} returned ${status}; service-account credentials likely rotated or scope insufficient`,
        );
      }
      if (status === HTTP_NOT_FOUND) {
        throw new ConfluenceNotFoundError(`GET ${path} returned 404`);
      }
      if (status === HTTP_TOO_MANY_REQUESTS) {
        attempts429 += 1;
        if (attempts429 >= RETRY_BUDGET_FOR_429) {
          throw new ConfluenceRateLimitedError(
            `GET ${path} rate-limited beyond ${attempts429} attempts`,
          );
        }
        // F-42: honor a server-supplied Retry-After when present; else local exp-backoff.
        let sleepSeconds = parseRetryAfterSeconds(resp.headers.get("Retry-After"), this.clock.now());
        if (sleepSeconds === null) {
          sleepSeconds = RETRY_BACKOFF_SECONDS[rateLimitBackoffIdx]!;
        }
        await this.clock.sleep(Math.min(sleepSeconds, MAX_RETRY_AFTER_SECONDS));
        rateLimitBackoffIdx = Math.min(rateLimitBackoffIdx + 1, RETRY_BACKOFF_SECONDS.length - 1);
        continue;
      }
      if (status >= HTTP_SERVER_ERROR_MIN) {
        attempts5xx += 1;
        if (attempts5xx >= RETRY_BUDGET_FOR_5XX) {
          throw new ConfluenceRetryableError(
            `GET ${path} server-errored after ${attempts5xx} attempts: ${status}`,
          );
        }
        await this.clock.sleep(RETRY_BACKOFF_SECONDS[serverErrorBackoffIdx]!);
        serverErrorBackoffIdx = Math.min(serverErrorBackoffIdx + 1, RETRY_BACKOFF_SECONDS.length - 1);
        continue;
      }
      // Anything else (3xx already excluded; 4xx that isn't 401/403/404/429) is a protocol error.
      throw new ConfluenceProtocolError(`GET ${path} returned unexpected status ${status}`);
    }
  }

  /** Decode the response body as JSON, raising ConfluenceProtocolError on a non-JSON body. */
  private static async decodeJson(resp: Response): Promise<unknown> {
    try {
      return await resp.json();
    } catch (err) {
      throw new ConfluenceProtocolError(`response body is not JSON: ${formatErr(err)}`);
    }
  }

  /** Assert the decoded body is a JSON object; throws ConfluenceProtocolError if not. */
  private static parseJson(decoded: unknown): Record<string, unknown> {
    if (!isRecord(decoded)) {
      const kind = Array.isArray(decoded) ? "array" : typeof decoded;
      throw new ConfluenceProtocolError(`response body is ${kind}, expected object`);
    }
    return decoded;
  }
}

// ─── module-local helpers ───────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Read a required field, coercing to string. Throws (→ ConfluenceProtocolError upstream) when absent. */
function requireField(row: Record<string, unknown>, key: string): string {
  if (!(key in row) || row[key] === undefined || row[key] === null) {
    throw new Error(`missing required field: ${key}`);
  }
  return String(row[key]);
}

/** Read `version.createdAt` when `version` is an object, else undefined. */
function versionCreatedAt(row: Record<string, unknown>): unknown {
  const version = row["version"];
  if (isRecord(version)) return version["createdAt"];
  return undefined;
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
