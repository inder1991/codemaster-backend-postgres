// PurposeModelResolver (ADR-0060 step 1): DB-backed purpose→model selection that the admin Job Routing
// UI actually controls — reads core.llm_purpose_model joined to the catalog's enabled/validation state,
// caches for a short TTL, and FAILS OPEN to the static seed (modelForPurpose) on a missing/invalid pin or
// any read error. Unit-tested with a fake repo + FakeClock (no DB).

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { DEFAULT_MODEL } from "#backend/llm/model_router.js";
import {
  PurposeModelResolver,
  staticPurposeModelResolver,
  type PurposeModelReadRepo,
  type PurposeModelRow,
} from "#backend/llm/purpose_model_resolver.js";

function fakeRepo(
  rows: ReadonlyArray<PurposeModelRow>,
  opts?: { throws?: boolean },
): { repo: PurposeModelReadRepo; calls: () => number } {
  let calls = 0;
  return {
    repo: {
      listPurposeModelsWithState: async (): Promise<ReadonlyArray<PurposeModelRow>> => {
        calls += 1;
        if (opts?.throws === true) {
          throw new Error("db down");
        }
        return rows;
      },
    },
    calls: () => calls,
  };
}

describe("PurposeModelResolver", () => {
  it("returns the pinned model when the pin is enabled AND validation ok", async () => {
    const { repo } = fakeRepo([
      { purpose: "review_finding", model_id: "my-model", enabled: true, last_validation_status: "ok" },
    ]);
    const r = new PurposeModelResolver({ repo, clock: new FakeClock() });
    expect(await r.resolve("review_finding")).toBe("my-model");
  });

  it("falls back to the seed when the pinned model is disabled", async () => {
    const { repo } = fakeRepo([
      { purpose: "review_finding", model_id: "my-model", enabled: false, last_validation_status: "ok" },
    ]);
    const r = new PurposeModelResolver({ repo, clock: new FakeClock() });
    expect(await r.resolve("review_finding")).toBe("claude-sonnet-4-6");
  });

  it("falls back to the seed when the pinned model has not passed preflight", async () => {
    const { repo } = fakeRepo([
      { purpose: "walkthrough", model_id: "my-model", enabled: true, last_validation_status: "failed" },
    ]);
    const r = new PurposeModelResolver({ repo, clock: new FakeClock() });
    expect(await r.resolve("walkthrough")).toBe("claude-opus-4-7");
  });

  it("falls back to the seed when the pinned model is absent from the catalog (LEFT JOIN miss → null state)", async () => {
    const { repo } = fakeRepo([
      { purpose: "analysis_curator", model_id: "ghost", enabled: false, last_validation_status: null },
    ]);
    const r = new PurposeModelResolver({ repo, clock: new FakeClock() });
    expect(await r.resolve("analysis_curator")).toBe("claude-haiku-4-5-20251001");
  });

  it("falls back to the seed when no pin exists for the purpose", async () => {
    const { repo } = fakeRepo([]);
    const r = new PurposeModelResolver({ repo, clock: new FakeClock() });
    expect(await r.resolve("fix_prompt")).toBe("claude-sonnet-4-6");
    expect(await r.resolve("totally_unknown")).toBe(DEFAULT_MODEL);
  });

  it("fails open to the seed on a read error (never blocks a review)", async () => {
    const { repo } = fakeRepo([], { throws: true });
    const r = new PurposeModelResolver({ repo, clock: new FakeClock() });
    expect(await r.resolve("review_finding")).toBe("claude-sonnet-4-6");
  });

  it("caches within the TTL and refetches after it elapses", async () => {
    const f = fakeRepo([
      { purpose: "review_finding", model_id: "m1", enabled: true, last_validation_status: "ok" },
    ]);
    const clock = new FakeClock();
    const r = new PurposeModelResolver({ repo: f.repo, clock, ttlMs: 30_000 });
    expect(await r.resolve("review_finding")).toBe("m1");
    expect(await r.resolve("review_finding")).toBe("m1");
    expect(f.calls()).toBe(1); // served from cache within the TTL window
    clock.advance({ seconds: 31 });
    expect(await r.resolve("review_finding")).toBe("m1");
    expect(f.calls()).toBe(2); // refetched after the TTL elapsed
  });

  it("static fallback resolver returns the seed only", async () => {
    expect(await staticPurposeModelResolver.resolve("walkthrough")).toBe("claude-opus-4-7");
    expect(await staticPurposeModelResolver.resolve("nope")).toBe(DEFAULT_MODEL);
  });
});
