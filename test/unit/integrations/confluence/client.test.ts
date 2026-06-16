/**
 * Unit tests for the TS ConfluenceClient — the 1:1 port of
 * `vendor/codemaster-py/codemaster/integrations/confluence/client.py` (frozen Python, Sprint 13 /
 * S13.3.1a + Sub-spec A T4 labels + F-42 Retry-After).
 *
 * HTTP is Node's native `fetch`; the tests inject a FAKE fetch returning the static RESPONSE-fixture
 * cassettes under test/cassettes/confluence/*.json (these are response fixtures, NOT VCR). ALL timing
 * (the retry/backoff sleeps + the F-42 Retry-After clock read) is the injected FakeClock — never a real
 * wall-clock wait.
 *
 * Coverage (the byte-significant `_get_json` + parser decisions):
 *   - list_spaces parses the space list (id/key/name → ConfluenceSpaceV1).
 *   - list_pages paginates page1 → page2 via the _links.next cursor; page2 has no next → next_cursor=null.
 *   - get_page parses body_html + status mapping (current→active, draft→draft) + inline labels.
 *   - empty inline labels → the dedicated /api/v2/pages/{id}/labels fallback merges.
 *   - 401 → ConfluenceAuthError; 403 → ConfluenceAuthError; 404 → ConfluenceNotFoundError.
 *   - 429 retries then raises ConfluenceRateLimitedError; honors the Retry-After header (F-42).
 *   - 5xx retries (3-attempt budget) then raises ConfluenceRetryableError.
 *   - a non-JSON / non-dict body → ConfluenceProtocolError.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import {
  ConfluenceAuthError,
  ConfluenceClient,
  ConfluenceNotFoundError,
  ConfluenceProtocolError,
  ConfluenceRateLimitedError,
  ConfluenceRetryableError,
  type ConfluenceFetch,
} from "#backend/integrations/confluence/client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// test/unit/integrations/confluence -> test/cassettes/confluence
const CASSETTES = resolve(HERE, "..", "..", "..", "cassettes", "confluence");

function cassette(name: string): unknown {
  return JSON.parse(readFileSync(resolve(CASSETTES, `${name}.json`), "utf-8"));
}

/** Minimal fetch-Response shape the client consumes (json + status + headers.get). */
function jsonResponse(
  body: unknown,
  { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const h = new Headers(headers);
  return {
    status,
    headers: h,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A fake fetch that returns a scripted sequence of responses, recording the URLs requested. */
function scriptedFetch(responses: ReadonlyArray<Response>): {
  fetch: ConfluenceFetch;
  urls: () => ReadonlyArray<string>;
} {
  const urls: Array<string> = [];
  let i = 0;
  const fetch: ConfluenceFetch = async (url) => {
    urls.push(String(url));
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return r;
  };
  return { fetch, urls: () => urls };
}

/** A fake fetch keyed by URL substring → response (for multi-endpoint flows like the labels fallback). */
function routedFetch(routes: ReadonlyArray<{ match: string; response: Response }>): {
  fetch: ConfluenceFetch;
  urls: () => ReadonlyArray<string>;
} {
  const urls: Array<string> = [];
  const fetch: ConfluenceFetch = async (url) => {
    const s = String(url);
    urls.push(s);
    const route = routes.find((r) => s.includes(r.match));
    if (route === undefined) throw new Error(`no route for ${s}`);
    return route.response;
  };
  return { fetch, urls: () => urls };
}

const BASE_URL = "https://confluence.acme.com/wiki";
const TOKEN = "ATATT-classic-token";

function client(fetch: ConfluenceFetch, opts: { authEmail?: string; clock?: FakeClock } = {}): ConfluenceClient {
  return new ConfluenceClient({
    baseUrl: BASE_URL,
    bearerToken: TOKEN,
    fetch,
    clock: opts.clock ?? new FakeClock(),
    ...(opts.authEmail !== undefined ? { authEmail: opts.authEmail } : {}),
  });
}

describe("ConfluenceClient — constructor guards", () => {
  it("requires exactly one of bearerToken / tokenProvider", () => {
    expect(() => new ConfluenceClient({ baseUrl: BASE_URL, fetch: async () => jsonResponse({}) })).toThrow();
    expect(
      () =>
        new ConfluenceClient({
          baseUrl: BASE_URL,
          bearerToken: TOKEN,
          tokenProvider: async () => TOKEN,
          fetch: async () => jsonResponse({}),
        }),
    ).toThrow();
  });
});

describe("ConfluenceClient — list_spaces", () => {
  it("parses the recorded GET /api/v2/spaces into ConfluenceSpaceV1 tuple", async () => {
    const { fetch, urls } = scriptedFetch([jsonResponse(cassette("list_spaces_happy"))]);
    const spaces = await client(fetch).listSpaces();

    expect(spaces).toHaveLength(2);
    expect(spaces[0]).toMatchObject({ space_id: "98765", space_key: "ACME-PILOT", name: "Acme Pilot Space" });
    expect(spaces[1]).toMatchObject({ space_id: "98766", space_key: "PLATFORM-DOCS" });
    expect(urls()[0]).toBe(`${BASE_URL}/api/v2/spaces`);
  });
});

describe("ConfluenceClient — list_pages pagination", () => {
  it("page1 extracts the cursor from _links.next; page2 has no next → next_cursor=null", async () => {
    const page1 = scriptedFetch([jsonResponse(cassette("list_pages_page1"))]);
    const first = await client(page1.fetch).listPages({ spaceKey: "ACME-PILOT" });

    expect(first.items).toHaveLength(3);
    expect(first.items[0]).toMatchObject({ page_id: "111111", space_key: "ACME-PILOT", version: 3 });
    expect(first.next_cursor).toBe("eyJsYXN0SWQiOiIxMTExMTMifQ==");
    // The first request carries space-key + limit=25, no cursor.
    expect(page1.urls()[0]).toContain("/api/v2/pages?");
    expect(page1.urls()[0]).toContain("space-key=ACME-PILOT");
    expect(page1.urls()[0]).toContain("limit=25");
    expect(page1.urls()[0]).not.toContain("cursor=");

    const page2 = scriptedFetch([jsonResponse(cassette("list_pages_page2"))]);
    const second = await client(page2.fetch).listPages({ spaceKey: "ACME-PILOT", cursor: first.next_cursor! });

    expect(second.items).toHaveLength(2);
    expect(second.items[0]).toMatchObject({ page_id: "111114" });
    expect(second.next_cursor).toBeNull();
    expect(page2.urls()[0]).toContain("cursor=eyJsYXN0SWQiOiIxMTExMTMifQ%3D%3D");
  });
});

describe("ConfluenceClient — get_page", () => {
  it("parses body_html + status current→active + non-empty inline labels", async () => {
    const { fetch, urls } = scriptedFetch([jsonResponse(cassette("get_page_with_labels"))]);
    const page = await client(fetch).getPage({ pageId: "12345", spaceKey: "PYSEC" });

    expect(page.page_id).toBe("12345");
    expect(page.space_key).toBe("PYSEC");
    expect(page.title).toBe("Python Security Best Practices");
    expect(page.version).toBe(7);
    expect(page.body_html).toBe("<p>Use prepared statements.</p>");
    expect(page.status).toBe("active");
    expect(page.labels).toEqual(["python", "security", "default"]);
    // Inline labels present → NO dedicated /labels fallback fetch.
    expect(urls()).toHaveLength(1);
    expect(urls()[0]).toContain("/api/v2/pages/12345?");
    expect(urls()[0]).toContain("body-format=storage");
    expect(urls()[0]).toContain("include-labels=true");
  });

  it("maps status draft→draft and graceful empty labels when no metadata block", async () => {
    // get_page_no_metadata has NO labels → triggers the dedicated /labels fallback, which we route to
    // an empty result so the page keeps its empty labels.
    const { fetch } = routedFetch([
      { match: "/api/v2/pages/99999/labels", response: jsonResponse({ results: [] }) },
      { match: "/api/v2/pages/99999", response: jsonResponse(cassette("get_page_no_metadata")) },
    ]);
    const page = await client(fetch).getPage({ pageId: "99999", spaceKey: "PLATFORM-DOCS" });

    expect(page.status).toBe("draft");
    expect(page.labels).toEqual([]);
    expect(page.body_html).toBe("<p>Work in progress.</p>");
  });

  it("EMPTY inline labels → dedicated /api/v2/pages/{id}/labels fallback MERGES", async () => {
    // get_page_happy has metadata.labels.results = [] (empty inline) → the client fetches the dedicated
    // labels resource and merges its names.
    const { fetch, urls } = routedFetch([
      {
        match: "/api/v2/pages/111112/labels",
        response: jsonResponse({ results: [{ name: "runbook" }, { name: "ops" }] }),
      },
      { match: "/api/v2/pages/111112", response: jsonResponse(cassette("get_page_happy")) },
    ]);
    const page = await client(fetch).getPage({ pageId: "111112", spaceKey: "ACME-PILOT" });

    expect(page.labels).toEqual(["runbook", "ops"]);
    // Two requests: the page, then the dedicated labels resource.
    expect(urls()).toHaveLength(2);
    expect(urls()[1]).toContain("/api/v2/pages/111112/labels");
  });

  it("RESILIENT: a labels-fallback failure leaves the (empty) inline labels", async () => {
    const { fetch } = routedFetch([
      { match: "/api/v2/pages/111112/labels", response: jsonResponse({}, { status: 404 }) },
      { match: "/api/v2/pages/111112", response: jsonResponse(cassette("get_page_happy")) },
    ]);
    const page = await client(fetch).getPage({ pageId: "111112", spaceKey: "ACME-PILOT" });
    expect(page.labels).toEqual([]);
  });
});

describe("ConfluenceClient — auth header", () => {
  it("Bearer scheme when no authEmail (Server/Data-Center PAT)", async () => {
    let seenAuth: string | undefined;
    const fetch: ConfluenceFetch = async (_url, init) => {
      seenAuth = (init?.headers as Record<string, string>)["Authorization"];
      return jsonResponse(cassette("list_spaces_happy"));
    };
    await client(fetch).listSpaces();
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("HTTP Basic email:token when authEmail set (Atlassian Cloud)", async () => {
    let seenAuth: string | undefined;
    const fetch: ConfluenceFetch = async (_url, init) => {
      seenAuth = (init?.headers as Record<string, string>)["Authorization"];
      return jsonResponse(cassette("list_spaces_happy"));
    };
    await client(fetch, { authEmail: "svc@acme.com" }).listSpaces();
    const expected = "Basic " + Buffer.from("svc@acme.com:" + TOKEN).toString("base64");
    expect(seenAuth).toBe(expected);
  });
});

describe("ConfluenceClient — error taxonomy", () => {
  it("401 → ConfluenceAuthError", async () => {
    const { fetch } = scriptedFetch([jsonResponse({}, { status: 401 })]);
    await expect(client(fetch).listSpaces()).rejects.toBeInstanceOf(ConfluenceAuthError);
  });

  it("403 → ConfluenceAuthError", async () => {
    const { fetch } = scriptedFetch([jsonResponse({}, { status: 403 })]);
    await expect(client(fetch).listSpaces()).rejects.toBeInstanceOf(ConfluenceAuthError);
  });

  it("404 → ConfluenceNotFoundError", async () => {
    const { fetch } = scriptedFetch([jsonResponse({}, { status: 404 })]);
    await expect(client(fetch).listSpaces()).rejects.toBeInstanceOf(ConfluenceNotFoundError);
  });

  it("a non-dict JSON body → ConfluenceProtocolError", async () => {
    const { fetch } = scriptedFetch([jsonResponse([1, 2, 3])]);
    await expect(client(fetch).listSpaces()).rejects.toBeInstanceOf(ConfluenceProtocolError);
  });

  it("an unexpected 4xx (e.g. 418) → ConfluenceProtocolError", async () => {
    const { fetch } = scriptedFetch([jsonResponse({}, { status: 418 })]);
    await expect(client(fetch).listSpaces()).rejects.toBeInstanceOf(ConfluenceProtocolError);
  });
});

describe("ConfluenceClient — 429 rate-limit", () => {
  it("retries then raises ConfluenceRateLimitedError after the budget; records backoff sleeps", async () => {
    const clock = new FakeClock();
    // Always-429 → exhausts the 6-attempt 429 budget.
    const { fetch } = scriptedFetch([jsonResponse({}, { status: 429 })]);
    await expect(client(fetch, { clock }).listSpaces()).rejects.toBeInstanceOf(ConfluenceRateLimitedError);
    // 5 sleeps before the 6th attempt raises (budget = 6 attempts, sleeps between them).
    expect(clock.recordedSleeps()).toEqual([1, 2, 4, 8, 15]);
  });

  it("honors a numeric Retry-After header (F-42), capped at 600s", async () => {
    const clock = new FakeClock();
    const ok = jsonResponse(cassette("list_spaces_happy"));
    const limited = jsonResponse({}, { status: 429, headers: { "Retry-After": "120" } });
    const { fetch } = scriptedFetch([limited, ok]);
    const spaces = await client(fetch, { clock }).listSpaces();
    expect(spaces).toHaveLength(2);
    // The single 429 slept the server-supplied 120s, not the local backoff (1s).
    expect(clock.recordedSleeps()).toEqual([120]);
  });
});

describe("ConfluenceClient — 5xx retry", () => {
  it("retries a 503 then returns the 200; records one backoff sleep", async () => {
    const clock = new FakeClock();
    const { fetch } = scriptedFetch([
      jsonResponse({}, { status: 503 }),
      jsonResponse(cassette("list_spaces_happy")),
    ]);
    const spaces = await client(fetch, { clock }).listSpaces();
    expect(spaces).toHaveLength(2);
    expect(clock.recordedSleeps()).toEqual([1]);
  });

  it("exhausts the 3-attempt 5xx budget then raises ConfluenceRetryableError", async () => {
    const clock = new FakeClock();
    const { fetch } = scriptedFetch([jsonResponse({}, { status: 500 })]);
    await expect(client(fetch, { clock }).listSpaces()).rejects.toBeInstanceOf(ConfluenceRetryableError);
    // 2 sleeps before the 3rd attempt raises.
    expect(clock.recordedSleeps()).toEqual([1, 2]);
  });

  it("a THROWN transport error retries per the 5xx budget then raises ConfluenceRetryableError", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const fetch: ConfluenceFetch = async () => {
      calls += 1;
      throw new TypeError("network down");
    };
    await expect(client(fetch, { clock }).listSpaces()).rejects.toBeInstanceOf(ConfluenceRetryableError);
    expect(calls).toBe(3);
    expect(clock.recordedSleeps()).toEqual([1, 2]);
  });
});

describe("ConfluenceClient — tokenProvider", () => {
  it("invokes the provider per request so rotation propagates", async () => {
    const tokens = ["tok-a", "tok-b"];
    let i = 0;
    const seenAuth: Array<string> = [];
    const fetch: ConfluenceFetch = async (_url, init) => {
      seenAuth.push((init?.headers as Record<string, string>)["Authorization"]!);
      return jsonResponse(cassette("list_spaces_happy"));
    };
    const c = new ConfluenceClient({
      baseUrl: BASE_URL,
      tokenProvider: async () => {
        const t = tokens[Math.min(i, tokens.length - 1)]!;
        i += 1;
        return t;
      },
      fetch,
      clock: new FakeClock(),
    });
    await c.listSpaces();
    await c.listSpaces();
    expect(seenAuth).toEqual(["Bearer tok-a", "Bearer tok-b"]);
  });
});

describe("ConfluenceClient — fast-fail mode (admin live-read seam)", () => {
  it("caps the 5xx budget to ONE attempt and never sleeps", async () => {
    // A persistent 5xx normally consumes the 3-attempt budget (2 sleeps). In fast-fail mode the
    // client must give up after a SINGLE attempt and never touch the clock.
    const clock = new FakeClock();
    let calls = 0;
    const fetch: ConfluenceFetch = async () => {
      calls += 1;
      return jsonResponse({}, { status: 503 });
    };
    const c = new ConfluenceClient({ baseUrl: BASE_URL, bearerToken: TOKEN, fetch, clock, fastFail: true });
    await expect(c.listSpaces()).rejects.toBeInstanceOf(ConfluenceRetryableError);
    expect(calls).toBe(1);
    expect(clock.recordedSleeps()).toEqual([]);
  });

  it("caps the 429 budget to ONE attempt and never sleeps (ignores Retry-After)", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const fetch: ConfluenceFetch = async () => {
      calls += 1;
      return jsonResponse({}, { status: 429, headers: { "Retry-After": "120" } });
    };
    const c = new ConfluenceClient({ baseUrl: BASE_URL, bearerToken: TOKEN, fetch, clock, fastFail: true });
    await expect(c.listSpaces()).rejects.toBeInstanceOf(ConfluenceRateLimitedError);
    expect(calls).toBe(1);
    expect(clock.recordedSleeps()).toEqual([]);
  });

  it("caps a THROWN transport error to ONE attempt and never sleeps", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const fetch: ConfluenceFetch = async () => {
      calls += 1;
      throw new TypeError("network down");
    };
    const c = new ConfluenceClient({ baseUrl: BASE_URL, bearerToken: TOKEN, fetch, clock, fastFail: true });
    await expect(c.listSpaces()).rejects.toBeInstanceOf(ConfluenceRetryableError);
    expect(calls).toBe(1);
    expect(clock.recordedSleeps()).toEqual([]);
  });

  it("a single 200 still succeeds in fast-fail mode (the happy path is unaffected)", async () => {
    const { fetch } = scriptedFetch([jsonResponse(cassette("list_spaces_happy"))]);
    const c = new ConfluenceClient({ baseUrl: BASE_URL, bearerToken: TOKEN, fetch, clock: new FakeClock(), fastFail: true });
    const spaces = await c.listSpaces();
    expect(spaces).toHaveLength(2);
  });

  it("default (no fastFail) preserves the full 3-attempt 5xx budget", async () => {
    // Regression guard: the default budget MUST be unchanged by the new option.
    const clock = new FakeClock();
    let calls = 0;
    const fetch: ConfluenceFetch = async () => {
      calls += 1;
      return jsonResponse({}, { status: 500 });
    };
    const c = new ConfluenceClient({ baseUrl: BASE_URL, bearerToken: TOKEN, fetch, clock });
    await expect(c.listSpaces()).rejects.toBeInstanceOf(ConfluenceRetryableError);
    expect(calls).toBe(3);
    expect(clock.recordedSleeps()).toEqual([1, 2]);
  });
});

describe("ConfluenceClient — AbortSignal cancellation (real transport abort)", () => {
  it("threads the request signal into the fetch init", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetch: ConfluenceFetch = async (_url, init) => {
      seenSignal = init?.signal;
      return jsonResponse(cassette("list_spaces_happy"));
    };
    const controller = new AbortController();
    const c = new ConfluenceClient({ baseUrl: BASE_URL, bearerToken: TOKEN, fetch, clock: new FakeClock() });
    await c.listSpaces({ signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });

  it("an aborted signal surfaces promptly as the transport's AbortError (no retry, no sleep)", async () => {
    // The real undici fetch rejects with an AbortError DOMException when the passed signal aborts. A
    // thrown abort must NOT be retried as a transient transport error (that would orphan the budget and
    // defeat the deadline) — it surfaces at once. We model undici: a fetch that rejects with an
    // AbortError when the signal is already aborted.
    const clock = new FakeClock();
    let calls = 0;
    const fetch: ConfluenceFetch = async (_url, init) => {
      calls += 1;
      if (init?.signal?.aborted === true) {
        const e = new DOMException("The operation was aborted.", "AbortError");
        return Promise.reject(e);
      }
      return jsonResponse(cassette("list_spaces_happy"));
    };
    const controller = new AbortController();
    controller.abort();
    const c = new ConfluenceClient({ baseUrl: BASE_URL, bearerToken: TOKEN, fetch, clock });
    await expect(c.listSpaces({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    // ONE transport call, no retry budget consumed, no sleep — the abort is terminal.
    expect(calls).toBe(1);
    expect(clock.recordedSleeps()).toEqual([]);
  });
});
