/**
 * Unit tests for {@link QwenEmbeddingsConsumer} — 1:1 behavioural parity with the frozen Python
 * `codemaster/integrations/qwen/consumer.py`.
 *
 * No live network: a {@link RecordingEmbeddingsHttpClient} captures every POST and returns scripted
 * responses (or simulates a transport error). Each test pins a specific Python semantic so a port
 * regression (a swapped status mapping, a wrong URL, a dropped wire key) fails a NAMED test.
 *
 * Axes:
 *   - WIRE: POST `{dsn}/embed`, body EXACTLY {texts, model_name, purpose}, NO auth header, dsn trailing
 *     slash stripped.
 *   - STATUS MAPPING: 200 ok → EmbedResult; 200 bad-shape → Connectivity; 429 → RateLimited; 5xx →
 *     Connectivity; other 4xx → Validation; transport error → Connectivity; other status → Connectivity.
 */

import { describe, expect, it } from "vitest";

import {
  type EmbedRequest,
  type EmbeddingsHttpClient,
  type EmbeddingsHttpRequestArgs,
  type EmbeddingsHttpResponse,
  EmbeddingsConnectivityError,
  EmbeddingsRateLimitedError,
  EmbeddingsTransportError,
  EmbeddingsValidationError,
} from "#backend/adapters/embeddings_port.js";
import { QwenEmbeddingsConsumer } from "#backend/integrations/qwen/consumer.js";

/** A scripted response, OR the sentinel "throw a transport error" (to drive the catch arm). */
type Scripted = EmbeddingsHttpResponse | "transport-error";

/** Records every POST and returns scripted responses in order (test-only double). */
class RecordingEmbeddingsHttpClient implements EmbeddingsHttpClient {
  public readonly requests: Array<EmbeddingsHttpRequestArgs> = [];
  private readonly scripted: Array<Scripted>;
  private index = 0;

  public constructor(scripted: Array<Scripted>) {
    this.scripted = scripted;
  }

  public async post(args: EmbeddingsHttpRequestArgs): Promise<EmbeddingsHttpResponse> {
    this.requests.push(args);
    const next = this.scripted[this.index];
    this.index += 1;
    if (next === undefined) {
      throw new Error(`no scripted response for request #${this.index - 1}`);
    }
    if (next === "transport-error") {
      throw new EmbeddingsTransportError("simulated transport failure");
    }
    return next;
  }
}

function resp(status: number, body: unknown): EmbeddingsHttpResponse {
  return { status, bodyText: typeof body === "string" ? body : JSON.stringify(body) };
}

const REQ: EmbedRequest = {
  texts: ["hello", "world"],
  model_name: "qwen3-embed-0.6b",
  purpose: "review_query",
};

describe("QwenEmbeddingsConsumer wire shape", () => {
  it("POSTs {dsn}/embed with body {texts, model_name, purpose} and NO auth header", async () => {
    const http = new RecordingEmbeddingsHttpClient([
      resp(200, {
        vectors: [[0.1], [0.2]],
        model_name: "qwen3-embed-0.6b",
        model_version: "v9",
        cache_hits: 1,
      }),
    ]);
    const consumer = new QwenEmbeddingsConsumer({ dsn: "http://qwen.svc:8080/", http });
    const result = await consumer.embed(REQ);

    expect(http.requests).toHaveLength(1);
    const sent = http.requests[0]!;
    // dsn trailing slash stripped → no double slash before /embed.
    expect(sent.url).toBe("http://qwen.svc:8080/embed");
    expect(sent.jsonBody).toEqual({
      texts: ["hello", "world"],
      model_name: "qwen3-embed-0.6b",
      purpose: "review_query",
    });
    // NO Authorization header (the platform service uses mesh mTLS, not bearer auth).
    expect(sent.headers).toEqual({});

    expect(result.vectors).toEqual([[0.1], [0.2]]);
    expect(result.model_name).toBe("qwen3-embed-0.6b");
    expect(result.model_version).toBe("v9");
    expect(result.cache_hits).toBe(1);
  });

  it("defaults cache_hits to 0 when the response omits it", async () => {
    const http = new RecordingEmbeddingsHttpClient([
      resp(200, { vectors: [[1]], model_name: "m", model_version: "v" }),
    ]);
    const consumer = new QwenEmbeddingsConsumer({ dsn: "http://qwen.svc", http });
    const result = await consumer.embed({ texts: ["x"], model_name: "m", purpose: "symbol" });
    expect(result.cache_hits).toBe(0);
  });
});

describe("QwenEmbeddingsConsumer status mapping", () => {
  const consumerWith = (scripted: Array<Scripted>): QwenEmbeddingsConsumer =>
    new QwenEmbeddingsConsumer({
      dsn: "http://qwen.svc",
      http: new RecordingEmbeddingsHttpClient(scripted),
    });

  it("200 with an unexpected shape → EmbeddingsConnectivityError (transient drift)", async () => {
    const consumer = consumerWith([resp(200, { vectors: "not-a-list" })]);
    await expect(consumer.embed(REQ)).rejects.toBeInstanceOf(EmbeddingsConnectivityError);
  });

  it("429 → EmbeddingsRateLimitedError", async () => {
    const consumer = consumerWith([resp(429, "slow down")]);
    await expect(consumer.embed(REQ)).rejects.toBeInstanceOf(EmbeddingsRateLimitedError);
  });

  it("500 → EmbeddingsConnectivityError", async () => {
    const consumer = consumerWith([resp(500, "boom")]);
    await expect(consumer.embed(REQ)).rejects.toBeInstanceOf(EmbeddingsConnectivityError);
  });

  it("503 → EmbeddingsConnectivityError", async () => {
    const consumer = consumerWith([resp(503, "unavailable")]);
    await expect(consumer.embed(REQ)).rejects.toBeInstanceOf(EmbeddingsConnectivityError);
  });

  it("other 4xx (e.g. 400) → EmbeddingsValidationError", async () => {
    const consumer = consumerWith([resp(400, "bad request")]);
    await expect(consumer.embed(REQ)).rejects.toBeInstanceOf(EmbeddingsValidationError);
  });

  it("404 → EmbeddingsValidationError", async () => {
    const consumer = consumerWith([resp(404, "not found")]);
    await expect(consumer.embed(REQ)).rejects.toBeInstanceOf(EmbeddingsValidationError);
  });

  it("transport error (connect/timeout/network) → EmbeddingsConnectivityError", async () => {
    const consumer = consumerWith(["transport-error"]);
    await expect(consumer.embed(REQ)).rejects.toBeInstanceOf(EmbeddingsConnectivityError);
  });

  it("an unexpected status (e.g. 302) → EmbeddingsConnectivityError (defensive)", async () => {
    const consumer = consumerWith([resp(302, "redirect")]);
    await expect(consumer.embed(REQ)).rejects.toBeInstanceOf(EmbeddingsConnectivityError);
  });

  it("a locally-invalid request (empty texts) → EmbeddingsValidationError, no POST issued", async () => {
    const http = new RecordingEmbeddingsHttpClient([]);
    const consumer = new QwenEmbeddingsConsumer({ dsn: "http://qwen.svc", http });
    await expect(
      consumer.embed({ texts: [], model_name: "m", purpose: "symbol" }),
    ).rejects.toBeInstanceOf(EmbeddingsValidationError);
    expect(http.requests).toHaveLength(0);
  });
});
