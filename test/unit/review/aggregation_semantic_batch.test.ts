// F9 / P2-3 — aggregateSemantic must BATCH the embed at the port's MAX_TEXTS (128). A single oversized
// embed of ALL finding bodies throws on a large review (≥128 findings) → the stage fails open to exact-only
// dedup (semantic_skipped=true), defeating semantic dedup exactly where it matters most. Batching keeps it on.

import { describe, expect, it } from "vitest";

import type { EmbedRequest, EmbedResult, EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import { aggregateSemantic } from "#backend/review/aggregation_semantic.js";

import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

function findingFor(i: number): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file: `src/f_${i}.ts`,
    start_line: 1,
    end_line: 1,
    severity: "issue",
    category: "bug",
    title: `t-${i}`,
    body: `body ${i}`,
    confidence: 0.9,
  });
}

/** An embedder that mirrors embeddings_port's MAX_TEXTS: THROWS when handed more than `maxTexts`. */
function limitedEmbedder(maxTexts: number): { port: EmbeddingsPort; calls: () => number } {
  let calls = 0;
  const port: EmbeddingsPort = {
    async embed(req: EmbedRequest): Promise<EmbedResult> {
      calls += 1;
      if (req.texts.length > maxTexts) {
        throw new Error(`MAX_TEXTS ${maxTexts} exceeded: ${req.texts.length}`);
      }
      return {
        vectors: req.texts.map((_t, i) => [Math.cos(i), Math.sin(i), 0]),
        model_name: req.model_name,
        model_version: "v1",
        cache_hits: 0,
      };
    },
  };
  return { port, calls: () => calls };
}

describe("aggregateSemantic — embed batching (F9 / P2-3)", () => {
  it("a >128 finding set still runs semantic dedup (batched in ≤128), not fail-open to exact-only", async () => {
    const findings = Array.from({ length: 130 }, (_v, i) => findingFor(i));
    const { port, calls } = limitedEmbedder(128);

    const [, semanticSkipped] = await aggregateSemantic(findings, port);

    expect(semanticSkipped).toBe(false); // semantic dedup RAN — pre-fix the one >128 embed threw → true
    expect(calls()).toBe(2); // batched: 128 + 2
  });
});
