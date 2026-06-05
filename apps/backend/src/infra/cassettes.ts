/**
 * Cassette-based HTTP replay — 1:1 port of `codemaster/infra/cassettes.py`
 * (frozen Python, Sprint 0 / Story S0.5a).
 *
 * A {@link CassetteHttpClient} replays HTTP interactions recorded to a YAML file. Used in tests to
 * make external-service integration (GitHub REST, Bedrock, Vault, …) deterministic, fast, and
 * forensically valuable. The GitHub API client takes an injected http client; in production that is
 * a real `fetch` transport, in tests it is this cassette double.
 *
 * Why not hand-crafted mocks: mocks lie about real-world response shapes. Cassettes are recorded
 * against real services and replayed verbatim, and catch drift between code and recordings (request
 * shape diff → {@link CassetteMismatch}).
 *
 * --- Two on-disk shapes, one client ---
 *
 * The repo carries cassettes in two YAML shapes; this reader normalises both to one internal model:
 *
 *   (a) The CANONICAL `cassettes.py` envelope (e.g. `test/cassettes/test/example-happy-path.yaml`):
 *
 *         schema_version: 1
 *         service: github | bedrock | embeddings | confluence | test
 *         scenario: "PR opened — happy path"
 *         recorded_at: "2026-05-01T12:00:00Z"
 *         recorded_by: "<author>"
 *         interactions:
 *           - request:  { method, url,  headers, body_text | body_json }
 *             response: { status, headers, body_text | body_json }
 *
 *   (b) The VCR recording shape the recorded GitHub/Vault/Bedrock cassettes use
 *       (`test/cassettes/github/*.yaml`), with no envelope and field aliases:
 *
 *         interactions:
 *           - request:  { method, uri,  headers, body }   # uri≡url, body≡raw text
 *             response: { status_code, headers, body }    # status_code≡status
 *
 *   Field aliasing applied at parse time: `uri`→`url`, `status_code`→`status`, raw `body`→`body_text`.
 *   The envelope metadata (schema_version/service/scenario/recorded_at/recorded_by) is OPTIONAL — the
 *   VCR cassettes omit it — and defaulted so the matcher can run on either shape.
 *
 * Sensitive headers (Authorization, X-GitHub-Token, …) are scrubbed at record time; this replay-only
 * client never matches on them (see the match strategy on {@link CassetteHttpClient}).
 */

import { readFileSync } from "node:fs";

import { load as yamlLoad } from "js-yaml";
import { z } from "zod";

// === Cassette contract ===

/** JSON value — the body_json / structured-body type (Python `dict | list | scalar | None`). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | Array<JsonValue>
  | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

/** The HTTP methods a recorded request may carry (mirrors the Python `Literal[...]`). */
export const CASSETTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export type CassetteMethod = (typeof CASSETTE_METHODS)[number];

/**
 * One recorded HTTP request. Field aliasing handles the VCR shape: `uri`→`url`, raw `body`→`body_text`
 * (only when no explicit `body_text`/`body_json` is present). Extra keys are ignored (Pydantic
 * `extra="ignore"`).
 */
const cassetteRequestSchema = z
  .object({
    method: z.enum(CASSETTE_METHODS),
    url: z.string().optional(),
    uri: z.string().optional(),
    headers: z.record(z.string()).default({}),
    body_text: z.string().nullable().optional(),
    body_json: jsonValueSchema.nullable().optional(),
    body: z.string().nullable().optional(),
  })
  .passthrough()
  .transform((r) => {
    const url = r.url ?? r.uri;
    if (url === undefined) {
      throw new Error("cassette request is missing both `url` and `uri`");
    }
    // VCR `body` is raw text; map it onto body_text only when no explicit body_text/body_json given.
    const bodyText =
      r.body_text ?? (r.body_json === undefined || r.body_json === null ? (r.body ?? null) : null);
    return {
      method: r.method,
      url,
      headers: r.headers,
      body_text: bodyText ?? null,
      body_json: r.body_json ?? null,
    };
  });

/** One recorded HTTP request, normalised. */
export type CassetteRequest = {
  method: CassetteMethod;
  url: string;
  headers: Record<string, string>;
  body_text: string | null;
  body_json: JsonValue | null;
};

/**
 * One recorded HTTP response. Field aliasing handles the VCR shape: `status_code`→`status`,
 * raw `body`→`body_text`.
 */
const cassetteResponseSchema = z
  .object({
    status: z.number().int().gte(100).lte(599).optional(),
    status_code: z.number().int().gte(100).lte(599).optional(),
    headers: z.record(z.string()).default({}),
    body_text: z.string().nullable().optional(),
    body_json: jsonValueSchema.nullable().optional(),
    body: z.string().nullable().optional(),
  })
  .passthrough()
  .transform((r) => {
    const status = r.status ?? r.status_code;
    if (status === undefined) {
      throw new Error("cassette response is missing both `status` and `status_code`");
    }
    const bodyText =
      r.body_text ?? (r.body_json === undefined || r.body_json === null ? (r.body ?? null) : null);
    return {
      status,
      headers: r.headers,
      body_text: bodyText ?? null,
      body_json: r.body_json ?? null,
    };
  });

/** One recorded HTTP response, normalised. */
export type CassetteResponse = {
  status: number;
  headers: Record<string, string>;
  body_text: string | null;
  body_json: JsonValue | null;
};

const cassetteInteractionSchema = z.object({
  request: cassetteRequestSchema,
  response: cassetteResponseSchema,
});

/** One request/response pair. */
export type CassetteInteraction = {
  request: CassetteRequest;
  response: CassetteResponse;
};

/**
 * Top-level cassette envelope. Envelope metadata is OPTIONAL so the VCR cassettes (which omit it)
 * parse; the canonical `cassettes.py` cassettes supply it.
 */
const cassetteSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    service: z
      .enum(["github", "bedrock", "embeddings", "confluence", "vault", "langfuse", "test"])
      .default("test"),
    scenario: z.string().default(""),
    recorded_at: z.string().default(""),
    recorded_by: z.string().default(""),
    interactions: z.array(cassetteInteractionSchema),
  })
  .passthrough();

/** Top-level cassette envelope, normalised. */
export type Cassette = {
  schema_version: 1;
  service: string;
  scenario: string;
  recorded_at: string;
  recorded_by: string;
  interactions: Array<CassetteInteraction>;
};

/** Parse + validate an already-loaded cassette object (analogue of `Cassette.model_validate`). */
export function parseCassette(data: unknown): Cassette {
  return cassetteSchema.parse(data) as Cassette;
}

// === Replay client ===

/** Raised when a replayed test issues a request the cassette didn't record. */
export class CassetteMismatch extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CassetteMismatch";
  }
}

/** Arguments to {@link CassetteHttpClient.request} — mirrors the Python keyword-only signature. */
export type CassetteRequestArgs = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  json_body?: JsonValue | null;
  text_body?: string | null;
};

/**
 * A replay-only HTTP client backed by a cassette file.
 *
 * Tests do `const client = CassetteHttpClient.fromPath(...)` then call
 * `await client.request({ method, url, ... })`. The client matches the request against the NEXT
 * interaction (by cursor) and returns the recorded response.
 *
 * Match strategy (strict by default, 1:1 with the Python):
 * - Method must match exactly (case-insensitive on the caller side — uppercased before compare).
 * - URL must match at path-and-query level; scheme + host are case-normalised and query params sorted
 *   (so `?b=2&a=1` ≡ `?a=1&b=2`).
 * - Body, if the cassette recorded one, must match: JSON-deep-equal for `body_json`, exact for
 *   `body_text`.
 * - Headers other than auth/agent/date are NOT matched (avoids false mismatches on transient headers).
 *
 * On mismatch / exhaustion: throws {@link CassetteMismatch} with a diff — the desired behaviour, it
 * surfaces drift between code and recording.
 */
export class CassetteHttpClient {
  private readonly cassette: Cassette;
  private cursor = 0;

  public constructor(cassette: Cassette) {
    this.cassette = cassette;
  }

  // --- factories ---

  /** Load a cassette from a YAML file on disk (`yaml.safe_load` analogue via js-yaml). */
  public static fromPath(path: string): CassetteHttpClient {
    const raw = readFileSync(path, "utf8");
    const data = yamlLoad(raw);
    return new CassetteHttpClient(parseCassette(data));
  }

  /** Build a client from an already-loaded plain object (analogue of `from_dict`). */
  public static fromData(data: unknown): CassetteHttpClient {
    return new CassetteHttpClient(parseCassette(data));
  }

  // --- request API ---

  /**
   * Replay the next recorded interaction matching this request. Throws {@link CassetteMismatch} on
   * drift (method / URL / body) or on cassette exhaustion.
   */
  public async request(args: CassetteRequestArgs): Promise<CassetteResponse> {
    // Async to mirror the Python `async def request`; the body is synchronous (no awaits needed).
    await Promise.resolve();

    if (this.cursor >= this.cassette.interactions.length) {
      throw new CassetteMismatch(
        `cassette '${this.cassette.scenario}' has ` +
          `${this.cassette.interactions.length} interaction(s); ` +
          "test issued one more",
      );
    }

    const interaction = this.cassette.interactions[this.cursor]!;
    this.cursor += 1;
    const idx = this.cursor - 1;

    const actualMethod = args.method.toUpperCase();
    const actualUrlNormalized = normalizeUrl(args.url);
    const recordedUrlNormalized = normalizeUrl(interaction.request.url);

    if (actualMethod !== interaction.request.method) {
      throw new CassetteMismatch(
        `interaction ${idx}: method mismatch: ` +
          `recorded=${JSON.stringify(interaction.request.method)} ` +
          `actual=${JSON.stringify(actualMethod)}`,
      );
    }
    if (actualUrlNormalized !== recordedUrlNormalized) {
      throw new CassetteMismatch(
        `interaction ${idx}: URL mismatch:\n` +
          `  recorded: ${recordedUrlNormalized}\n` +
          `  actual:   ${actualUrlNormalized}`,
      );
    }

    // Body match (only checked if the cassette recorded a body).
    const jsonBody = args.json_body ?? null;
    if (
      interaction.request.body_json !== null &&
      !deepEqual(jsonBody, interaction.request.body_json)
    ) {
      throw new CassetteMismatch(
        `interaction ${idx}: JSON body mismatch:\n` +
          `  recorded: ${JSON.stringify(interaction.request.body_json)}\n` +
          `  actual:   ${JSON.stringify(jsonBody)}`,
      );
    }
    const textBody = args.text_body ?? null;
    if (interaction.request.body_text !== null && textBody !== interaction.request.body_text) {
      throw new CassetteMismatch(
        `interaction ${idx}: text body mismatch:\n` +
          `  recorded: ${JSON.stringify(interaction.request.body_text)}\n` +
          `  actual:   ${JSON.stringify(textBody)}`,
      );
    }

    return interaction.response;
  }

  /** The number of un-replayed interactions. */
  public remaining(): number {
    return this.cassette.interactions.length - this.cursor;
  }

  /** Assert all recorded interactions were used. Call at test teardown. */
  public assertFullyConsumed(): void {
    const n = this.remaining();
    if (n > 0) {
      throw new CassetteMismatch(
        `cassette '${this.cassette.scenario}' has ${n} unused interaction(s)`,
      );
    }
  }
}

// === Helpers ===

/**
 * Normalize a URL for comparison: lowercase scheme/host; sort query params.
 *
 * Scheme/host case-normalisation runs REGARDLESS of whether the URL has a query string (RFC 3986
 * §3.1 + §3.2.2 declare both case-insensitive) — mirroring the frozen Python `_normalize_url` fix
 * that stopped early-returning on no-query URLs and leaving `HTTPS://API.Example.com/widgets`
 * distinct from `https://api.example.com/widgets`.
 */
export function normalizeUrl(url: string): string {
  const queryIndex = url.indexOf("?");
  let base = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const qs = queryIndex === -1 ? "" : url.slice(queryIndex + 1);

  const schemeSep = base.indexOf("://");
  if (schemeSep !== -1) {
    const scheme = base.slice(0, schemeSep);
    const rest = base.slice(schemeSep + 3);
    const slashIndex = rest.indexOf("/");
    const host = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
    const slashAndPath = slashIndex === -1 ? "" : rest.slice(slashIndex);
    base = `${scheme.toLowerCase()}://${host.toLowerCase()}${slashAndPath}`;
  }

  if (qs === "") {
    return base;
  }
  const pairs = qs
    .split("&")
    .filter((p) => p !== "")
    .sort();
  return `${base}?${pairs.join("&")}`;
}

/**
 * Structural deep-equality for JSON values. Object key ORDER is irrelevant (compares by key set),
 * matching Python `dict == dict` semantics used by the frozen `json_body != recorded` check.
 */
function deepEqual(a: JsonValue | null, b: JsonValue | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]!));
  }

  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        deepEqual((a as Record<string, JsonValue>)[k]!, (b as Record<string, JsonValue>)[k]!),
    );
  }

  return false;
}
