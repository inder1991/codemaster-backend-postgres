// F15 / P2-10 — a singleton UPDATE matching 0 rows (missing singleton, e.g. a botched restore) must FAIL
// LOUD, not silently no-op a config-version bump (workers would never see the bump → the ≤30s propagation
// SLA fails silently).

import { describe, expect, it } from "vitest";

import { assertSingletonUpdated } from "#backend/domain/repos/embedder_runtime_state_repo.js";

describe("assertSingletonUpdated (F15 / P2-10)", () => {
  it("passes when exactly 1 singleton row was updated", () => {
    expect(() => assertSingletonUpdated({ numAffectedRows: 1n }, "setPending")).not.toThrow();
  });

  it("throws (fail-closed) when 0 rows matched — the singleton is missing", () => {
    expect(() => assertSingletonUpdated({ numAffectedRows: 0n }, "activate")).toThrow(/activate/);
    expect(() => assertSingletonUpdated({ numAffectedRows: 0n }, "activate")).toThrow(/missing/);
  });

  it("throws when numAffectedRows is absent (treated as 0)", () => {
    expect(() => assertSingletonUpdated({}, "clearPending")).toThrow(/clearPending/);
  });
});
