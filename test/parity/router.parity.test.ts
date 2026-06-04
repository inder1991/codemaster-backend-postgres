import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import { type ClassificationInput, pyDecideRoute, shutdownRouterRef } from "./router_oracle.js";
import { decideRoute, type RoutingBucket, SANDBOX_LANGUAGES } from "#backend/files/router.js";
import { FileClassificationV1 } from "#contracts/file_classification.v1.js";

afterAll(() => shutdownRouterRef());

// Tier-A parity for the file router. `decide_route` is a MODULE-LEVEL PURE function over a constructed
// FileClassificationV1 instance, returning a `frozenset[RoutingBucket]`. Because the input is a
// Pydantic instance (not a kwargs dict) and the output is a non-JSON-native frozenset, this uses the
// DEDICATED driver (tools/parity/run_router_ref.py + router_oracle.ts) rather than the generic oracle
// — the same precedent as the policy `extract_rules` parity (run_policy_ref.py / policy_oracle.ts).
//
// Set-ordering handling (byte-parity contract): a frozenset has no order. The Python driver emits the
// decision as `sorted(decision)`; the TS port returns a ReadonlySet whose members we likewise sort
// before canonicalizing. So {"review", "sandbox"} compares stably regardless of iteration order on
// either side. Both sides are then run through the SAME canonicalize() the other parity suites use.

/** Canonicalize the TS decision as the driver does the Python one: members sorted into a stable list. */
function tsBuckets(c: ClassificationInput): string {
  // Round-trip the wire dict through the ported Zod contract so the TS path validates the exact same
  // shape the Python driver re-constructs (parity at the contract boundary, not just the function).
  const parsed: FileClassificationV1 = FileClassificationV1.parse(c);
  const decision = decideRoute(parsed);
  const sorted: Array<RoutingBucket> = [...decision].sort();
  return canonicalize(sorted);
}

/** Drive the frozen Python router and assert the TS port is byte-identical on the sorted bucket list. */
async function assertRouteParity(c: ClassificationInput): Promise<void> {
  const py = canonicalize(await pyDecideRoute(c));
  expect(tsBuckets(c)).toBe(py);
}

/** Base classification with the routing-irrelevant fields fixed; per-case overrides drive the rules. */
function classification(over: Partial<ClassificationInput>): ClassificationInput {
  return {
    path: "src/file.txt",
    byte_size: 100,
    magika_label: "txt",
    language: null,
    is_binary: false,
    is_generated: false,
    ...over,
  };
}

describe("decide_route parity (TS ↔ frozen Python file router)", () => {
  // ── Rule 1: is_generated → {"skip"} ────────────────────────────────────────────────────────────
  // First match wins: even a sandbox language + non-empty label still skips when generated.
  it("is_generated=true → {skip}", async () => {
    await assertRouteParity(classification({ is_generated: true }));
  }, 30_000);

  it("is_generated=true short-circuits a sandbox language → {skip}", async () => {
    await assertRouteParity(
      classification({ is_generated: true, language: "python", magika_label: "python" }),
    );
  }, 30_000);

  it("is_generated=true short-circuits even is_binary + empty (rule 1 wins) → {skip}", async () => {
    await assertRouteParity(
      classification({ is_generated: true, is_binary: true, magika_label: "empty" }),
    );
  }, 30_000);

  // ── Rule 2: is_binary → {"skip"} (not generated) ───────────────────────────────────────────────
  it("is_binary=true (not generated) → {skip}", async () => {
    await assertRouteParity(classification({ is_binary: true, magika_label: "binary" }));
  }, 30_000);

  it("is_binary=true short-circuits a sandbox language → {skip}", async () => {
    await assertRouteParity(
      classification({ is_binary: true, language: "go", magika_label: "go" }),
    );
  }, 30_000);

  // ── Rule 3: magika_label == "empty" → {"skip"} (not generated, not binary) ─────────────────────
  it("magika_label=empty → {skip}", async () => {
    await assertRouteParity(classification({ magika_label: "empty" }));
  }, 30_000);

  it("magika_label=empty short-circuits a sandbox language → {skip}", async () => {
    // language set but the empty-label check (rule 3) fires before the SANDBOX_LANGUAGES check (rule 4).
    await assertRouteParity(classification({ magika_label: "empty", language: "typescript" }));
  }, 30_000);

  // ── Rule 4: language ∈ SANDBOX_LANGUAGES → {"review", "sandbox"} ────────────────────────────────
  // Every member of the frozen SANDBOX_LANGUAGES set, driven from the ported set itself.
  for (const lang of [...SANDBOX_LANGUAGES].sort()) {
    it(`language=${lang} (sandbox) → {review, sandbox}`, async () => {
      await assertRouteParity(classification({ language: lang, magika_label: lang }));
    }, 30_000);
  }

  it("sandbox language with an unrelated magika_label still → {review, sandbox}", async () => {
    // The bucket-4 decision keys off `language`, NOT `magika_label` (as long as label != "empty").
    await assertRouteParity(classification({ language: "python", magika_label: "text/x-script" }));
  }, 30_000);

  // ── Rule 5: otherwise → {"review"} ─────────────────────────────────────────────────────────────
  it("non-sandbox language (e.g. ruby) → {review}", async () => {
    await assertRouteParity(classification({ language: "ruby", magika_label: "ruby" }));
  }, 30_000);

  it("language=null, non-empty label (markdown) → {review}", async () => {
    await assertRouteParity(classification({ language: null, magika_label: "markdown" }));
  }, 30_000);

  it("unknown magika_label, language=null → {review} (safe default, not skip)", async () => {
    await assertRouteParity(
      classification({ language: null, magika_label: "application/x-novel-format" }),
    );
  }, 30_000);

  it("config-ish file (json label, no language) → {review}", async () => {
    await assertRouteParity(classification({ language: null, magika_label: "json" }));
  }, 30_000);

  // ── Edge: case sensitivity — SANDBOX_LANGUAGES is exact-match, so "Python" is NOT a member ──────
  it("language=Python (capitalized, not an exact member) → {review}", async () => {
    await assertRouteParity(classification({ language: "Python", magika_label: "python" }));
  }, 30_000);

  // ── Edge: a near-miss label "empties" must NOT trigger the empty short-circuit ──────────────────
  it('magika_label="empties" (not exactly "empty") → {review}', async () => {
    await assertRouteParity(classification({ language: null, magika_label: "empties" }));
  }, 30_000);

  // ── Edge: byte_size=0 is allowed (ge=0) and does NOT itself force skip (label drives rule 3) ────
  it("byte_size=0 with non-empty label and no language → {review}", async () => {
    await assertRouteParity(classification({ byte_size: 0, magika_label: "txt", language: null }));
  }, 30_000);
});
