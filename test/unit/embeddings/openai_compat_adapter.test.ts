// Unit tests for OpenAICompatibleEmbeddingsAdapter's KEYLESS support (plan r7 D7 / 6-7). A sidecar
// embedder (Ollama, an in-cluster vLLM with no auth) needs NO Authorization header — sending an empty
// `Bearer ` would be wrong. With apiKey === null the adapter MUST omit the header entirely; with a key it
// MUST send `Authorization: Bearer <key>`. The model is fixed at construction (ADR-0059), asserted here.
//
// No live network: a RecordingEmbeddingsHttpClient captures the POST args so we can assert the headers.

import { describe, expect, it } from "vitest";

import {
  type EmbeddingsHttpClient,
  type EmbeddingsHttpRequestArgs,
  type EmbeddingsHttpResponse,
} from "#backend/adapters/embeddings_port.js";
import { OpenAICompatibleEmbeddingsAdapter } from "#backend/integrations/openai_compat/adapter.js";

class RecordingHttp implements EmbeddingsHttpClient {
  public readonly requests: Array<EmbeddingsHttpRequestArgs> = [];
  public constructor(private readonly response: EmbeddingsHttpResponse) {}
  public async post(args: EmbeddingsHttpRequestArgs): Promise<EmbeddingsHttpResponse> {
    this.requests.push(args);
    return this.response;
  }
}

const OK = {
  status: 200,
  bodyText: JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }], model: "the-model" }),
};

describe("OpenAICompatibleEmbeddingsAdapter keyless support", () => {
  it("OMITS the Authorization header when apiKey is null (keyless)", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenAICompatibleEmbeddingsAdapter({
      baseUrl: "http://embedder.local:8080",
      apiKey: null,
      modelName: "the-model",
      http,
    });
    await adapter.embed({ texts: ["hi"], model_name: "ignored", purpose: "config_test" });
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.headers).not.toHaveProperty("Authorization");
  });

  it("SENDS Authorization: Bearer <key> when a key is present", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenAICompatibleEmbeddingsAdapter({
      baseUrl: "http://embedder.local:8080",
      apiKey: "sk-secret",
      modelName: "the-model",
      http,
    });
    await adapter.embed({ texts: ["hi"], model_name: "ignored", purpose: "config_test" });
    expect(http.requests[0]!.headers["Authorization"]).toBe("Bearer sk-secret");
  });

  it("sends the construction-time model in the body, ignoring req.model_name", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenAICompatibleEmbeddingsAdapter({
      baseUrl: "http://embedder.local:8080",
      apiKey: null,
      modelName: "fixed-model",
      http,
    });
    await adapter.embed({ texts: ["hi"], model_name: "per-call-ignored", purpose: "config_test" });
    expect((http.requests[0]!.jsonBody as { model: string }).model).toBe("fixed-model");
  });
});
