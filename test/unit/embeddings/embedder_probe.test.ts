// Unit tests for the embedder /test probe (plan P-1). The probe constructs the keyless-capable
// OpenAI-compat adapter from a candidate config, embeds ONE probe text, and gates on the dimension:
//   - 200 + a vector of the expected width  → ok=true;
//   - 200 + a wrong-width vector            → ok=false with a dimension-mismatch detail (the greenfield
//     gate: a model that returns the wrong dim must be caught at /test, BEFORE any ingest);
//   - transport/5xx/4xx                      → ok=false with the typed-error name in detail.
// It must also drive the keyless path (apiKey null → no Authorization header reaches the transport).

import { describe, expect, it } from "vitest";

import {
  type EmbeddingsHttpClient,
  type EmbeddingsHttpRequestArgs,
  type EmbeddingsHttpResponse,
  EmbeddingsTransportError,
} from "#backend/adapters/embeddings_port.js";
import { probeEmbedder } from "#backend/adapters/embedder_probe.js";

type Scripted = EmbeddingsHttpResponse | "transport-error";

class RecordingHttp implements EmbeddingsHttpClient {
  public readonly requests: Array<EmbeddingsHttpRequestArgs> = [];
  public constructor(private readonly next: Scripted) {}
  public async post(args: EmbeddingsHttpRequestArgs): Promise<EmbeddingsHttpResponse> {
    this.requests.push(args);
    if (this.next === "transport-error") {
      throw new EmbeddingsTransportError("simulated transport failure");
    }
    return this.next;
  }
}

function okBodyOfDim(dim: number): EmbeddingsHttpResponse {
  const embedding = Array.from({ length: dim }, () => 0.01);
  return { status: 200, bodyText: JSON.stringify({ data: [{ embedding }], model: "probed-model" }) };
}

const CONFIG = { baseUrl: "http://embedder.local:8080", apiKey: null, modelName: "the-model" };

describe("probeEmbedder", () => {
  it("returns ok=true when the embedder returns a vector of the expected dimension", async () => {
    const http = new RecordingHttp(okBodyOfDim(8));
    const r = await probeEmbedder(CONFIG, { http, expectedDim: 8 });
    expect(r.ok).toBe(true);
    expect(r.dimension).toBe(8);
  });

  it("returns ok=false with a dimension-mismatch detail when the width differs", async () => {
    const http = new RecordingHttp(okBodyOfDim(7));
    const r = await probeEmbedder(CONFIG, { http, expectedDim: 8 });
    expect(r.ok).toBe(false);
    expect(r.dimension).toBe(7);
    expect(r.detail).toMatch(/dimension 7.*8|7.*configured for 8/);
  });

  it("returns ok=false with the typed-error name on a transport failure", async () => {
    const http = new RecordingHttp("transport-error");
    const r = await probeEmbedder(CONFIG, { http, expectedDim: 8 });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Connectivity/);
  });

  it("drives the KEYLESS path (apiKey null → no Authorization header reaches the transport)", async () => {
    const http = new RecordingHttp(okBodyOfDim(8));
    await probeEmbedder({ ...CONFIG, apiKey: null }, { http, expectedDim: 8 });
    expect(http.requests[0]!.headers).not.toHaveProperty("Authorization");
  });
});
