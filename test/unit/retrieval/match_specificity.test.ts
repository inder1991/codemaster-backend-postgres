// Unit tests for compute_match_specificity — W1.3 (RH8).
//
// RH8 (docs/audits/2026-06-11-audit-recovered-lenses.md): `match_specificity_score` was hardcoded 0
// everywhere — the floors sort key collapsed to age-only and the prompt's specificity attribute was a
// constant "baseline". This ports the frozen Python
// vendor/codemaster-py/codemaster/retrieval/match_specificity.py::compute_match_specificity 1:1
// (NAMESPACE_WEIGHTS per spec §3.5 line 768-776) and the adapter wires it (integration-asserted in
// similarity_floor.integration.test.ts).

import { describe, expect, it } from "vitest";

import {
  computeMatchSpecificity,
  NAMESPACE_WEIGHTS,
  specificityBucket,
} from "#backend/retrieval/match_specificity.js";

describe("computeMatchSpecificity — label-overlap score (RH8; 1:1 Python port)", () => {
  it("carries the spec §3.5 namespace weights verbatim", () => {
    expect(NAMESPACE_WEIGHTS).toEqual({
      framework: 5,
      topic: 4,
      version: 4,
      org: 4,
      lang: 3,
      infra: 3,
      default: 1,
    });
  });

  it("sums the namespace weight of every MATCHED label", () => {
    const score = computeMatchSpecificity(
      new Set(["framework:fastapi", "lang:python", "default"]),
      new Set(["framework:fastapi", "lang:python", "default", "topic:security"]),
    );
    expect(score).toBe(5 + 3 + 1);
  });

  it("a default-only chunk scores the bare baseline weight (1)", () => {
    expect(computeMatchSpecificity(new Set(["default"]), new Set(["default"]))).toBe(1);
  });

  it("non-overlapping labels contribute nothing", () => {
    expect(
      computeMatchSpecificity(new Set(["lang:go"]), new Set(["lang:python", "default"])),
    ).toBe(0);
  });

  it("unknown namespaces contribute 0 (they neither poison nor help)", () => {
    expect(
      computeMatchSpecificity(new Set(["mystery:thing"]), new Set(["mystery:thing"])),
    ).toBe(0);
  });

  it("a bare non-default label (no namespace) contributes 0", () => {
    expect(computeMatchSpecificity(new Set(["python"]), new Set(["python"]))).toBe(0);
  });

  it("buckets compose with the existing thresholds (high ≥8, medium ≥4)", () => {
    const high = computeMatchSpecificity(
      new Set(["framework:django", "topic:security_policy"]),
      new Set(["framework:django", "topic:security_policy"]),
    );
    expect(high).toBe(9);
    expect(specificityBucket(high)).toBe("high");
    expect(specificityBucket(computeMatchSpecificity(new Set(["topic:x"]), new Set(["topic:x"])))).toBe(
      "medium",
    );
    expect(specificityBucket(computeMatchSpecificity(new Set(["default"]), new Set(["default"])))).toBe(
      "baseline",
    );
  });
});
