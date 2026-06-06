// Unit tests for reservePriorityFloors — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/floors.py::reserve_priority_floors (Sub-spec B T11 2/3).
//
// Tier-1 PARITY: the selection-ordering / starvation / tie-break expectations below were extracted by
// running the frozen Python `reserve_priority_floors` directly (see the inline PARITY comments). Pure-
// function tests — no DB.

import { describe, expect, it } from "vitest";

import { reservePriorityFloors, type FloorClassifiable } from "#backend/retrieval/floors.js";
import { PriorityTier } from "#backend/retrieval/precedence.js";

/** A floor-classifiable chunk (the structural shape floors operates on). */
function chunk(args: {
  labels?: ReadonlyArray<string>;
  source?: string;
  docKind?: string | null;
  matchSpecificityScore?: number;
  ageDays?: number;
  tokenCount?: number;
}): FloorClassifiable {
  return {
    labels: args.labels ?? [],
    source: args.source ?? "confluence",
    doc_kind: args.docKind ?? null,
    match_specificity_score: args.matchSpecificityScore ?? 0,
    age_days: args.ageDays ?? 0,
    token_count: args.tokenCount ?? 0,
  };
}

describe("reservePriorityFloors", () => {
  it("reserves one SECURITY_POLICY + one REPO_ADR slot, highest specificity first", () => {
    const s1 = chunk({
      labels: ["topic:security_policy"],
      matchSpecificityScore: 5,
      ageDays: 10,
      tokenCount: 100,
    });
    const s2 = chunk({
      labels: ["topic:security_policy"],
      matchSpecificityScore: 9,
      ageDays: 2,
      tokenCount: 100,
    });
    const adr = chunk({
      source: "repo_knowledge",
      docKind: "adr",
      matchSpecificityScore: 1,
      ageDays: 1,
      tokenCount: 50,
    });
    const result = reservePriorityFloors([s1, s2, adr], { tokenBudget: 1000 });
    // PARITY: selected == [s2, adr]; budget_remaining == 1000-100-50 == 850; no starvation.
    expect(result.selected).toEqual([s2, adr]);
    expect(result.budgetRemaining).toBe(850);
    expect(result.starvationTiers).toEqual([]);
  });

  it("records starvation when the best candidate exceeds remaining budget", () => {
    const s1 = chunk({ labels: ["topic:security_policy"], tokenCount: 100 });
    const result = reservePriorityFloors([s1], { tokenBudget: 50 });
    // PARITY: token_count(100) > budget(50) → SECURITY_POLICY starved, nothing selected, budget unchanged.
    expect(result.selected).toEqual([]);
    expect(result.starvationTiers).toEqual([PriorityTier.SECURITY_POLICY]);
    expect(result.budgetRemaining).toBe(50);
  });

  it("tie-breaks equal specificity by youngest age (freshest first)", () => {
    const older = chunk({ labels: ["topic:security_policy"], matchSpecificityScore: 5, ageDays: 10, tokenCount: 20 });
    const younger = chunk({ labels: ["topic:security_policy"], matchSpecificityScore: 5, ageDays: 3, tokenCount: 20 });
    const result = reservePriorityFloors([older, younger], { tokenBudget: 1000 });
    // PARITY: younger wins (lower age_days).
    expect(result.selected).toEqual([younger]);
  });

  it("skips a tier with no candidates without starving it", () => {
    // Only a SECURITY_POLICY candidate — REPO_ADR tier has no candidates, so it is silently skipped.
    const s1 = chunk({ labels: ["topic:security_policy"], tokenCount: 10 });
    const result = reservePriorityFloors([s1], { tokenBudget: 1000 });
    expect(result.selected).toEqual([s1]);
    expect(result.starvationTiers).toEqual([]);
    expect(result.budgetRemaining).toBe(990);
  });

  it("ignores non-floor tiers (framework / lang / default) entirely", () => {
    const fw = chunk({ labels: ["framework:react"], tokenCount: 10 });
    const lang = chunk({ labels: ["lang:python"], tokenCount: 10 });
    const def = chunk({ labels: ["default"], tokenCount: 10 });
    const result = reservePriorityFloors([fw, lang, def], { tokenBudget: 1000 });
    expect(result.selected).toEqual([]);
    expect(result.starvationTiers).toEqual([]);
    expect(result.budgetRemaining).toBe(1000);
  });

  it("empty candidate list → empty selection, full budget", () => {
    const result = reservePriorityFloors([], { tokenBudget: 500 });
    expect(result.selected).toEqual([]);
    expect(result.starvationTiers).toEqual([]);
    expect(result.budgetRemaining).toBe(500);
  });

  it("unwraps a .chunk-wrapped candidate (ScoredKnowledgeChunkV1 shape) for classification", () => {
    // A wrapped candidate: `{ chunk: <floor-classifiable> }`. floors normalizes via `.chunk`.
    const inner = chunk({ labels: ["topic:security_policy"], matchSpecificityScore: 3, tokenCount: 30 });
    const wrapped = { chunk: inner, score: 0.5, stage: "ann" };
    const result = reservePriorityFloors([wrapped], { tokenBudget: 1000 });
    // The wrapped OBJECT is what gets selected (identity preserved), classified via its `.chunk`.
    expect(result.selected).toEqual([wrapped]);
    expect(result.budgetRemaining).toBe(970);
  });
});
