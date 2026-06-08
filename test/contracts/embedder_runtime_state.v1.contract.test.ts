import { describe, expect, it } from "vitest";

import {
  EmbedderRuntimeStateRowV1,
  RetrievalMode,
} from "#contracts/embedder_runtime_state.v1.js";

// Shape-only unit test for the EmbedderRuntimeStateRowV1 Zod contract — the 1:1 port of the frozen
// Python PLAIN dataclass `EmbedderRuntimeStateRow` (NOT a Pydantic model; see the divergence note).

function stateRow(): Record<string, unknown> {
  return {
    active_generation: 1,
    active_model_name: "qwen3-embed-0.6b",
    pending_generation: null,
    pending_model_name: null,
    config_version: 22,
    retrieval_mode: "fallback",
    updated_at: new Date("2026-06-03T00:00:00.000Z"),
    updated_by_email: "ops@example.com",
  };
}

describe("EmbedderRuntimeStateRowV1", () => {
  it("accepts a well-formed singleton row (no pending pair)", () => {
    const parsed = EmbedderRuntimeStateRowV1.parse(stateRow());
    expect(parsed.active_generation).toBe(1);
    expect(parsed.pending_generation).toBeNull();
    expect(parsed.pending_model_name).toBeNull();
    expect(parsed.retrieval_mode).toBe("fallback");
  });

  it("accepts a row with a populated pending pair", () => {
    const parsed = EmbedderRuntimeStateRowV1.parse({
      ...stateRow(),
      pending_generation: 2,
      pending_model_name: "qwen3-embed-4b",
    });
    expect(parsed.pending_generation).toBe(2);
    expect(parsed.pending_model_name).toBe("qwen3-embed-4b");
  });

  it("rejects an unknown key (.strict() mirrors the frozen slots=True dataclass)", () => {
    expect(EmbedderRuntimeStateRowV1.safeParse({ ...stateRow(), extra: 1 }).success).toBe(false);
  });

  it("rejects a retrieval_mode outside the 2-value vocabulary", () => {
    expect(
      EmbedderRuntimeStateRowV1.safeParse({ ...stateRow(), retrieval_mode: "hybrid" }).success,
    ).toBe(false);
  });

  it("exposes the retrieval-mode enum vocabulary", () => {
    expect(RetrievalMode.options).toEqual(["fallback", "generation_only"]);
  });
});
