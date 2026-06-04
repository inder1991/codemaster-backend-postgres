/**
 * Unit tests for the cassette-replay client — port of `tests/unit/test_cassettes.py` (frozen Python,
 * Sprint 0 / Story S0.5a), extended to assert the on-disk GitHub VCR cassettes replay correctly,
 * since this client is the http double the GitHub API-client agent injects.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import {
  CassetteHttpClient,
  CassetteMismatch,
  normalizeUrl,
  parseCassette,
} from "#backend/infra/cassettes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// test/unit/infra -> test/cassettes
const CASSETTES = resolve(HERE, "..", "..", "cassettes");

function githubCassette(name: string): string {
  return resolve(CASSETTES, "github", name);
}

// === Round-trip from disk: GitHub VCR cassettes (uri / status_code / body) ===

describe("CassetteHttpClient — GitHub VCR cassettes", () => {
  it("replays get_pr.yaml: returns the recorded status, headers, and body", async () => {
    const client = CassetteHttpClient.fromPath(githubCassette("get_pr.yaml"));

    const r = await client.request({
      method: "GET",
      url: "https://api.github.com/repos/acme/example/pulls/42",
    });

    expect(r.status).toBe(200);
    expect(r.headers["X-RateLimit-Limit"]).toBe("5000");
    expect(r.headers["X-RateLimit-Remaining"]).toBe("4999");
    expect(r.headers["Content-Type"]).toBe("application/json");
    // VCR `body` → body_text (raw recorded text); the API-client agent JSON.parses it.
    const parsed = JSON.parse(r.body_text ?? "") as { number: number; head: { sha: string } };
    expect(parsed.number).toBe(42);
    expect(parsed.head.sha).toBe("abc123");

    client.assertFullyConsumed();
  });

  it("replays installation_token_success.yaml: a POST 201 with the recorded body", async () => {
    const client = CassetteHttpClient.fromPath(githubCassette("installation_token_success.yaml"));

    const r = await client.request({
      // The cassette recorded `body: ""` on the request, so the matcher (1:1 with the Python
      // CassetteHttpClient) requires an empty text body here. A non-empty body_text would mismatch.
      method: "POST",
      url: "https://api.github.com/app/installations/12345/access_tokens",
      text_body: "",
    });

    expect(r.status).toBe(201);
    expect(r.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    const body = JSON.parse(r.body_text ?? "") as { token: string };
    expect(body.token).toBe("ghs_redactedtokenvalue");
    client.assertFullyConsumed();
  });

  it("replays the two sequential interactions in 401_token_invalid.yaml in cursor order", async () => {
    const client = CassetteHttpClient.fromPath(githubCassette("401_token_invalid.yaml"));

    const first = await client.request({
      method: "GET",
      url: "https://api.github.com/repos/acme/example/pulls/42",
    });
    expect(first.status).toBe(401);

    expect(client.remaining()).toBe(1);

    const second = await client.request({
      method: "GET",
      url: "https://api.github.com/repos/acme/example/pulls/42",
    });
    expect(second.status).toBe(200);
    const body = JSON.parse(second.body_text ?? "") as { title: string };
    expect(body.title).toBe("after refresh");

    client.assertFullyConsumed();
  });

  it("returns an empty-body 204 (headers: {}) for a webhook-style cassette", async () => {
    const client = CassetteHttpClient.fromPath(githubCassette("pull_request_closed.yaml"));

    const r = await client.request({
      method: "POST",
      url: "https://codemaster-dev.acme.com/v1/github/webhook",
      text_body:
        '{\n  "action": "closed",\n  "number": 42,\n  "repository": {"id": 1, "full_name": ' +
        '"acme/example", "default_branch": "main", "archived": false},\n  "installation": ' +
        '{"id": 999, "account": {"id": 1, "login": "acme", "type": "Organization"}},\n  ' +
        '"sender": {"id": 2, "login": "alice", "type": "User"}\n}',
    });

    expect(r.status).toBe(204);
    expect(r.headers).toEqual({});
    client.assertFullyConsumed();
  });
});

// === Round-trip from disk: canonical cassettes.py envelope (url / status / body_json) ===

describe("CassetteHttpClient — canonical envelope cassette", () => {
  it("replays example-happy-path.yaml: body_json comes back structured", async () => {
    const client = CassetteHttpClient.fromPath(
      resolve(CASSETTES, "test", "example-happy-path.yaml"),
    );

    const r1 = await client.request({
      method: "GET",
      url: "https://api.example.com/v1/widgets/42",
    });
    expect(r1.status).toBe(200);
    expect(r1.body_json).toEqual({ id: 42, name: "test widget", active: true });

    const r2 = await client.request({
      method: "POST",
      url: "https://api.example.com/v1/widgets/42/actions",
      json_body: { action: "rotate" },
    });
    expect(r2.status).toBe(202);
    expect(r2.body_json).toEqual({ accepted: true });

    client.assertFullyConsumed();
  });
});

// === Inline-built cassettes (from_dict analogue) for mismatch + edge surfaces ===

function inlineClient(): CassetteHttpClient {
  return CassetteHttpClient.fromData({
    service: "test",
    scenario: "inline test",
    recorded_at: "2026-05-01T12:00:00Z",
    recorded_by: "tests",
    interactions: [
      {
        request: { method: "GET", url: "https://x.test/a" },
        response: { status: 200, body_json: { ok: true } },
      },
      {
        request: { method: "POST", url: "https://x.test/b", body_json: { action: "go" } },
        response: { status: 202, body_json: { accepted: true } },
      },
    ],
  });
}

describe("CassetteHttpClient — mismatch surfacing", () => {
  it("raises CassetteMismatch on a method mismatch", async () => {
    const client = inlineClient();
    await expect(client.request({ method: "POST", url: "https://x.test/a" })).rejects.toThrow(
      /method mismatch/,
    );
  });

  it("raises CassetteMismatch on a URL mismatch", async () => {
    const client = inlineClient();
    await expect(
      client.request({ method: "GET", url: "https://x.test/different" }),
    ).rejects.toThrow(/URL mismatch/);
  });

  it("raises CassetteMismatch on a JSON body mismatch", async () => {
    const client = inlineClient();
    await client.request({ method: "GET", url: "https://x.test/a" });
    await expect(
      client.request({
        method: "POST",
        url: "https://x.test/b",
        json_body: { action: "different" },
      }),
    ).rejects.toThrow(/JSON body mismatch/);
  });

  it("the thrown error is a CassetteMismatch instance", async () => {
    const client = inlineClient();
    await expect(client.request({ method: "POST", url: "https://x.test/a" })).rejects.toBeInstanceOf(
      CassetteMismatch,
    );
  });
});

describe("CassetteHttpClient — exhaustion", () => {
  it("raises when a request is issued after the cassette is consumed", async () => {
    const client = inlineClient();
    await client.request({ method: "GET", url: "https://x.test/a" });
    await client.request({
      method: "POST",
      url: "https://x.test/b",
      json_body: { action: "go" },
    });
    await expect(client.request({ method: "GET", url: "https://x.test/a" })).rejects.toThrow(
      /test issued one more/,
    );
  });

  it("assertFullyConsumed detects an unused interaction", () => {
    const client = inlineClient();
    // Did NOT consume the second interaction.
    expect(() => {
      client.assertFullyConsumed();
    }).toThrow(/unused interaction/);
  });

  it("advances the cursor exactly one interaction per request", async () => {
    const client = inlineClient();
    expect(client.remaining()).toBe(2);
    await client.request({ method: "GET", url: "https://x.test/a" });
    expect(client.remaining()).toBe(1);
    await client.request({
      method: "POST",
      url: "https://x.test/b",
      json_body: { action: "go" },
    });
    expect(client.remaining()).toBe(0);
  });
});

// === URL normalization ===

describe("CassetteHttpClient — URL normalization", () => {
  it("matches query params regardless of order", async () => {
    const client = CassetteHttpClient.fromData({
      service: "test",
      scenario: "qs order",
      interactions: [
        {
          request: { method: "GET", url: "https://x.test/a?b=2&a=1" },
          response: { status: 200 },
        },
      ],
    });
    const r = await client.request({ method: "GET", url: "https://x.test/a?a=1&b=2" });
    expect(r.status).toBe(200);
  });

  it("case-normalizes scheme and host even with no query string", async () => {
    const client = CassetteHttpClient.fromData({
      service: "test",
      scenario: "case",
      interactions: [
        {
          request: { method: "GET", url: "https://API.Example.com/widgets" },
          response: { status: 200 },
        },
      ],
    });
    const r = await client.request({ method: "GET", url: "HTTPS://api.example.com/widgets" });
    expect(r.status).toBe(200);
  });

  it("normalizeUrl lowercases scheme/host and sorts query params", () => {
    expect(normalizeUrl("HTTPS://API.Example.com/Widgets")).toBe(
      "https://api.example.com/Widgets",
    );
    expect(normalizeUrl("https://x.test/a?b=2&a=1")).toBe("https://x.test/a?a=1&b=2");
    expect(normalizeUrl("https://x.test/a")).toBe("https://x.test/a");
  });
});

// === Schema parsing ===

describe("parseCassette", () => {
  it("defaults the optional envelope metadata for a bare VCR cassette", () => {
    const cassette = parseCassette({
      interactions: [
        {
          request: { method: "GET", uri: "https://x.test/a" },
          response: { status_code: 200, body: "ok" },
        },
      ],
    });
    expect(cassette.schema_version).toBe(1);
    expect(cassette.service).toBe("test");
    expect(cassette.interactions[0]!.request.url).toBe("https://x.test/a");
    expect(cassette.interactions[0]!.response.status).toBe(200);
    expect(cassette.interactions[0]!.response.body_text).toBe("ok");
  });

  it("rejects a response status outside 100..599", () => {
    expect(() =>
      parseCassette({
        interactions: [
          {
            request: { method: "GET", url: "https://x.test/" },
            response: { status: 42 },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an unknown HTTP method", () => {
    expect(() =>
      parseCassette({
        interactions: [
          {
            request: { method: "TEAPOT", url: "https://x.test/" },
            response: { status: 200 },
          },
        ],
      }),
    ).toThrow();
  });
});
