import { describe, expect, it } from "vitest";

import {
  EmbeddingGenerationRowV1,
  EmbeddingGenerationState,
  RetireReason,
} from "#contracts/embedding_generation.v1.js";

// Shape-only unit test for the EmbeddingGenerationRowV1 Zod contract — the 1:1 port of the frozen
// Python PLAIN dataclass `EmbeddingGenerationRow` (NOT a Pydantic model, so no oracle-backed parity;
// see the contract module header divergence note). Pins the field set, the two enum vocabularies, the
// nullability of the optional fields, and the `.strict()` extra-key rejection.

function backfillingRow(): Record<string, unknown> {
  return {
    generation_id: 5,
    state: "backfilling",
    generation_label: null,
    generation_reason: null,
    provider_name: "qwen",
    provider_version: null,
    model_name: "qwen3-embed-0.6b",
    embedding_dimension: 1024,
    created_from_generation: null,
    chunker_version: "1",
    preprocessing_version: "1",
    normalization_version: "1",
    created_at: new Date("2026-06-01T00:00:00.000Z"),
    created_by_email: "ops@example.com",
    backfill_started_at: new Date("2026-06-01T00:00:00.000Z"),
    backfill_completed_at: null,
    validation_started_at: null,
    validation_completed_at: null,
    validation_report_json: null,
    validation_passed: null,
    activated_at: null,
    retired_at: null,
    retire_reason: null,
    gc_started_at: null,
    gc_completed_at: null,
    total_chunks: 0,
    chunks_backfilled: 0,
    chunks_failed: 0,
    last_error: null,
  };
}

describe("EmbeddingGenerationRowV1", () => {
  it("accepts a well-formed backfilling row (every field present)", () => {
    const parsed = EmbeddingGenerationRowV1.parse(backfillingRow());
    expect(parsed.generation_id).toBe(5);
    expect(parsed.state).toBe("backfilling");
    expect(parsed.backfill_completed_at).toBeNull();
    expect(parsed.activated_at).toBeNull();
  });

  it("rejects an unknown key (.strict() mirrors the frozen slots=True dataclass)", () => {
    expect(
      EmbeddingGenerationRowV1.safeParse({ ...backfillingRow(), unexpected: true }).success,
    ).toBe(false);
  });

  it("rejects a missing required field (e.g. model_name)", () => {
    const row = backfillingRow();
    delete row["model_name"];
    expect(EmbeddingGenerationRowV1.safeParse(row).success).toBe(false);
  });

  it("rejects a state outside the 4-value vocabulary", () => {
    expect(
      EmbeddingGenerationRowV1.safeParse({ ...backfillingRow(), state: "paused" }).success,
    ).toBe(false);
  });

  it("rejects a retire_reason outside the 3-value vocabulary", () => {
    expect(
      EmbeddingGenerationRowV1.safeParse({
        ...backfillingRow(),
        state: "retired",
        retired_at: new Date("2026-06-02T00:00:00.000Z"),
        retire_reason: "bogus",
      }).success,
    ).toBe(false);
  });

  it("exposes the state + retire-reason enum vocabularies", () => {
    expect(EmbeddingGenerationState.options).toEqual([
      "backfilling",
      "ready",
      "active",
      "retired",
    ]);
    expect(RetireReason.options).toEqual(["cancelled", "demoted", "manual_retire"]);
  });
});
