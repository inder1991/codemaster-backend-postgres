import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { LLM_PURPOSE_LITERALS, LlmPurposeV1 } from "#contracts/llm_routing.v1.js";

afterAll(() => shutdownRef());

// Contract parity for the only surviving type in contracts/llm_routing/v1.py: the LlmPurposeV1
// StrEnum (ADR-0060 A retired KNOWN_MODELS / SizeRule / RoutingPolicyV1 / RoutingDecisionV1). The
// Python enum constructor `LlmPurposeV1(value=x)` returns the member; the generic ref runner encodes
// `isinstance(result, Enum) -> result.value`, so a valid value round-trips to its own string and an
// invalid value raises ValueError. The Zod port (`z.enum`) parses valid → the string and throws on
// invalid, so accept/reject and the canonical output must agree for every case.
const PY = "contracts.llm_routing.v1";

describe("LlmPurposeV1 parity (Pydantic StrEnum ↔ Zod enum)", () => {
  for (const value of LLM_PURPOSE_LITERALS) {
    it(`accepts member ${value} and round-trips to its own string`, async () => {
      const r = await pyRef({ pyModule: PY, pyCallable: "LlmPurposeV1", kwargs: { value } });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(LlmPurposeV1.parse(value))).toBe(r.out);
    }, 30_000);
  }

  it("both REJECT an unknown value (StrEnum ValueError ↔ z.enum throw)", async () => {
    const bad = "not_a_real_purpose";
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmPurposeV1", kwargs: { value: bad } });
    expect(r.ok).toBe(false); // Python: ValueError
    expect(() => LlmPurposeV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty value", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmPurposeV1", kwargs: { value: "" } });
    expect(r.ok).toBe(false);
    expect(() => LlmPurposeV1.parse("")).toThrow();
  }, 30_000);

  it("the literal set matches the frozen enum membership exactly", () => {
    // Snapshot the exact vocabulary so a drift on either side fails loudly here, not subtly downstream.
    expect([...LLM_PURPOSE_LITERALS]).toEqual([
      "review_summary",
      "review_finding",
      "chat_reply",
      "walkthrough",
      "redaction_check",
      "cost_estimate",
      "analysis_curator",
      "fix_prompt",
    ]);
  });
});
