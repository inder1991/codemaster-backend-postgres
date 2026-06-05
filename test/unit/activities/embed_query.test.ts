// Unit tests for EmbedQueryActivity — the 1024-dim guard + the happy path.
//
// The activity embeds via an injected EmbeddingsPort double (NEVER a live service in a unit test). The
// load-bearing assertion is the dim guard: an embed service returning a wrong-shape vector MUST throw
// rather than return it (poisoning the downstream ANN cosine search). We use the deterministic
// RecordingEmbeddingsClient (always 1024-dim) for the happy path, and a tiny inline double that returns
// a 3-dim vector for the failure path.

import { describe, expect, it } from "vitest";

import { EmbedQueryActivity } from "#backend/activities/embed_query.activity.js";
import {
  type EmbedResult,
  type EmbeddingsPort,
  EMBEDDING_DIM,
  RecordingEmbeddingsClient,
} from "#backend/adapters/embeddings_port.js";

import { EmbedQueryInputV1 } from "#contracts/embed_query.v1.js";

/** A double that returns a fixed wrong-dim vector (NOT 1024) to trip the activity's dim guard. */
class WrongDimEmbeddings implements EmbeddingsPort {
  public constructor(private readonly dim: number) {}
  public async embed(): Promise<EmbedResult> {
    return {
      vectors: [new Array<number>(this.dim).fill(0.1)],
      model_name: "test",
      model_version: "test-v1",
      cache_hits: 0,
    };
  }
}

describe("EmbedQueryActivity", () => {
  it("embeds a query into a 1024-dim vector on the happy path", async () => {
    const activity = new EmbedQueryActivity({
      embeddings: new RecordingEmbeddingsClient(),
      modelName: "qwen3-embed-0.6b",
    });
    const input = EmbedQueryInputV1.parse({ query: "how does the mutex lease work?" });

    const result = await activity.embedQuery(input);

    expect(result.vector).toHaveLength(EMBEDDING_DIM);
    expect(result.schema_version).toBe(1);
    expect(result.vector.every((x) => typeof x === "number")).toBe(true);
  });

  it("routes through the in_repo_doc purpose bucket", async () => {
    const recording = new RecordingEmbeddingsClient();
    const activity = new EmbedQueryActivity({ embeddings: recording, modelName: "m" });
    await activity.embedQuery(EmbedQueryInputV1.parse({ query: "scope check" }));

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]!.purpose).toBe("in_repo_doc");
    expect(recording.calls[0]!.texts).toEqual(["scope check"]);
  });

  it("throws on a wrong-dim vector (embed-service contract violation)", async () => {
    const activity = new EmbedQueryActivity({
      embeddings: new WrongDimEmbeddings(3),
      modelName: "m",
    });
    const input = EmbedQueryInputV1.parse({ query: "x" });

    await expect(activity.embedQuery(input)).rejects.toThrow(
      `embed_query: vector dim mismatch (got=3 expected=${EMBEDDING_DIM})`,
    );
  });
});
