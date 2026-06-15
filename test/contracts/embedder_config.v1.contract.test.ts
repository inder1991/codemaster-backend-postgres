import { describe, expect, it } from "vitest";

import {
  ConfigStatusItemV1,
  ConfigStatusV1,
  EmbedderConfigV1,
  PutEmbedderConfigRequestV1,
} from "#contracts/embedder_config.v1.js";

// Shape-only unit tests for the DB-backed embedder-config admin contracts (Phase 2). The GET shape NEVER
// carries the api key (key_present:bool only); provider is server-owned (literal openai_compat); the PUT
// body omits provider and treats api_key as TRI-STATE (absent=keep, null=keyless, string=set). The
// config-status item adds the `invalid` state + an optional `detail` while staying a strict array so the
// existing lean items keep validating.

function configuredGet(): Record<string, unknown> {
  return {
    provider: "openai_compat",
    base_url: "http://embedder.local:8080/v1",
    model_name: "qwen3-embed-0.6b",
    key_present: true,
    enabled: true,
    last_validation_status: "ok",
    last_validation_error: null,
    last_validated_at: "2026-06-15T00:00:00.000Z",
    last_rotated_at: "2026-06-15T00:00:00.000Z",
    last_rotated_by: "admin@example.com",
    updated_at: "2026-06-15T00:00:00.000Z",
  };
}

describe("EmbedderConfigV1 (GET, no secret)", () => {
  it("accepts a configured shape and defaults schema_version", () => {
    const p = EmbedderConfigV1.parse(configuredGet());
    expect(p.schema_version).toBe(1);
    expect(p.provider).toBe("openai_compat");
    expect(p.key_present).toBe(true);
  });

  it("accepts an unconfigured shape (nulls, keyless)", () => {
    const p = EmbedderConfigV1.parse({
      provider: "openai_compat",
      base_url: null,
      model_name: null,
      key_present: false,
      enabled: false,
      last_validation_status: null,
      last_validation_error: null,
      last_validated_at: null,
      last_rotated_at: null,
      last_rotated_by: null,
      updated_at: null,
    });
    expect(p.base_url).toBeNull();
    expect(p.key_present).toBe(false);
  });

  it("rejects a provider other than openai_compat", () => {
    expect(EmbedderConfigV1.safeParse({ ...configuredGet(), provider: "bedrock" }).success).toBe(false);
  });

  it("rejects an unknown key (.strict)", () => {
    expect(EmbedderConfigV1.safeParse({ ...configuredGet(), secret: "x" }).success).toBe(false);
  });
});

describe("PutEmbedderConfigRequestV1 (PUT body, no provider)", () => {
  it("accepts a minimal body and defaults enabled=true; api_key absent → undefined (keep)", () => {
    const p = PutEmbedderConfigRequestV1.parse({
      base_url: "http://embedder.local:8080/v1",
      model_name: "qwen3-embed-0.6b",
    });
    expect(p.enabled).toBe(true);
    expect(p.api_key).toBeUndefined();
  });

  it("accepts api_key:null (clear → keyless) and a string (set/rotate)", () => {
    expect(
      PutEmbedderConfigRequestV1.parse({
        base_url: "http://e/v1",
        model_name: "m",
        api_key: null,
      }).api_key,
    ).toBeNull();
    expect(
      PutEmbedderConfigRequestV1.parse({
        base_url: "http://e/v1",
        model_name: "m",
        api_key: "sk-secret",
      }).api_key,
    ).toBe("sk-secret");
  });

  it("rejects an api_key shorter than 4 chars (would violate the DB fingerprint CHECK → 500)", () => {
    expect(
      PutEmbedderConfigRequestV1.safeParse({ base_url: "http://e/v1", model_name: "m", api_key: "abc" })
        .success,
    ).toBe(false);
  });

  it("rejects an empty base_url, an over-long model_name, and a server-owned provider key", () => {
    expect(PutEmbedderConfigRequestV1.safeParse({ base_url: "", model_name: "m" }).success).toBe(false);
    expect(
      PutEmbedderConfigRequestV1.safeParse({ base_url: "http://e/v1", model_name: "m".repeat(257) })
        .success,
    ).toBe(false);
    expect(
      PutEmbedderConfigRequestV1.safeParse({
        base_url: "http://e/v1",
        model_name: "m",
        provider: "openai_compat",
      }).success,
    ).toBe(false);
  });
});

describe("ConfigStatusV1 (validated array; adds invalid + detail)", () => {
  it("accepts the four states including invalid + detail (response is { items: [...] })", () => {
    const parsed = ConfigStatusV1.parse({
      items: [
        { key: "github.app", state: "configured", source: "db" },
        { key: "confluence", state: "disabled", source: "db" },
        { key: "llm.provider", state: "pending", source: "none", gates: "no reviews until configured" },
        { key: "embedder.provider", state: "invalid", source: "db", detail: "Connectivity: unreachable" },
      ],
    });
    expect(parsed.items).toHaveLength(4);
    expect(parsed.items[3]!.state).toBe("invalid");
    expect(parsed.items[3]!.detail).toBe("Connectivity: unreachable");
  });

  it("accepts a lean current-style item (no detail/gates)", () => {
    expect(ConfigStatusItemV1.safeParse({ key: "x", state: "pending", source: "none" }).success).toBe(
      true,
    );
  });

  it("rejects an unknown state and an unknown key", () => {
    expect(
      ConfigStatusItemV1.safeParse({ key: "x", state: "bogus", source: "db" }).success,
    ).toBe(false);
    expect(
      ConfigStatusItemV1.safeParse({ key: "x", state: "configured", source: "db", extra: 1 }).success,
    ).toBe(false);
  });
});
