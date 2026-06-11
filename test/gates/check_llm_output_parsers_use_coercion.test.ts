import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";

import {
  EXEMPTED,
  findCoercionViolations,
  isProductionSource,
  LLM_OUTPUT_CONTRACTS,
  main,
  type Violation,
} from "../../scripts/gates/check_llm_output_parsers_use_coercion.js";

// Build an in-memory TS project from a snippet and run the gate over it. Mirrors the frozen Python
// gate's tests (test_check_llm_output_parsers_use_coercion.py) but for the Zod v3 idioms: `.parse` /
// `.safeParse` as the `model_validate` equivalent and `coerceForContract` as `coerce_for_contract`.
// The file lives under a production `apps/<app>/src/` path so the gate's production-only scope sees it.
function violations(code: string, filePath = "apps/backend/src/review/x.ts"): Array<Violation> {
  const p = new Project({ useInMemoryFileSystem: true });
  p.createSourceFile(filePath, code);
  return findCoercionViolations(p);
}

describe("llm-output-parsers-use-coercion gate", () => {
  it("registers the four contracts ported verbatim from the Python frozenset", () => {
    expect([...LLM_OUTPUT_CONTRACTS].sort()).toEqual([
      "ArbitrationIntentV1",
      "ReviewChunkResponseV1",
      "ReviewFindingV1",
      "WalkthroughV1",
    ]);
  });

  describe("compliant parser shapes (the registered TS parser sites)", () => {
    it("passes coerce-then-parse on the same identifier (tool_schema.ts shape)", () => {
      expect(
        violations(`
          function parseBlock(payload: Record<string, unknown>) {
            const coerced = coerceForContract(payload, ReviewFindingV1, { blockId });
            return ReviewFindingV1.parse(coerced);
          }`),
      ).toHaveLength(0);
    });

    it("passes coerce-then-safeParse (walkthrough_schema.ts / curator_schema.ts shape)", () => {
      expect(
        violations(`
          function parseWalkthrough(payload: Record<string, unknown>) {
            const coerced = coerceForContract(payload, WalkthroughV1, { blockId });
            return WalkthroughV1.safeParse(coerced);
          }`),
      ).toHaveLength(0);
    });

    it("passes the in-place rebind shape `payload = coerceForContract(payload, C, ...)`", () => {
      expect(
        violations(`
          function f(payload: Record<string, unknown>) {
            payload = coerceForContract(payload, WalkthroughV1, { blockId });
            return WalkthroughV1.parse(payload);
          }`),
      ).toHaveLength(0);
    });

    it("passes two independent coerce/parse pairs in one function (tool_schema two-contract shape)", () => {
      expect(
        violations(`
          function parseToolUse(payload: Record<string, unknown>, intentPayload: Record<string, unknown>) {
            const coerced = coerceForContract(payload, ReviewFindingV1, { blockId });
            const finding = ReviewFindingV1.parse(coerced);
            const coercedIntent = coerceForContract(intentPayload, ArbitrationIntentV1, { blockId });
            const intent = ArbitrationIntentV1.parse(coercedIntent);
            return [finding, intent];
          }`),
      ).toHaveLength(0);
    });
  });

  describe("bypass violations", () => {
    it("flags a bare parse with no coerce call at all", () => {
      const v = violations(`
        function f(payload: Record<string, unknown>) {
          return ReviewFindingV1.parse(payload);
        }`);
      expect(v).toHaveLength(1);
      expect(v[0]!.contract).toBe("ReviewFindingV1");
      expect(v[0]!.method).toBe("parse");
      expect(v[0]!.payloadArg).toBe("payload");
      expect(v[0]!.file).toBe("apps/backend/src/review/x.ts");
    });

    it("flags an uncoerced safeParse (safeParse is gated like model_validate)", () => {
      const v = violations(`
        function f(payload: Record<string, unknown>) {
          return WalkthroughV1.safeParse(payload);
        }`);
      expect(v).toHaveLength(1);
      expect(v[0]!.method).toBe("safeParse");
    });

    it("flags an un-captured coerce call (coerce returns a NEW object; result must be bound)", () => {
      expect(
        violations(`
          function f(payload: Record<string, unknown>) {
            coerceForContract(payload, ReviewFindingV1, { blockId });
            return ReviewFindingV1.parse(payload);
          }`),
      ).toHaveLength(1);
    });

    it("flags a parse whose payload is NOT the coerce-bound name", () => {
      expect(
        violations(`
          function f(payload: Record<string, unknown>) {
            const coerced = coerceForContract(payload, ReviewFindingV1, { blockId });
            return ReviewFindingV1.parse(payload);
          }`),
      ).toHaveLength(1);
    });

    it("flags a coerce for a DIFFERENT contract than the one parsed", () => {
      expect(
        violations(`
          function f(payload: Record<string, unknown>) {
            const coerced = coerceForContract(payload, WalkthroughV1, { blockId });
            return ReviewFindingV1.parse(coerced);
          }`),
      ).toHaveLength(1);
    });

    it("flags a coerce that appears AFTER the parse (AST-order, strictly-earlier-line rule)", () => {
      expect(
        violations(`
          function f(payload: Record<string, unknown>) {
            const result = ReviewFindingV1.parse(coerced);
            const coerced = coerceForContract(payload, ReviewFindingV1, { blockId });
            return result;
          }`),
      ).toHaveLength(1);
    });

    it("conservatively rejects non-identifier payloads: call expressions and property access", () => {
      const v = violations(`
        function f(row: { walkthrough: string }, args: { walkthrough: unknown }) {
          const a = WalkthroughV1.parse(JSON.parse(row.walkthrough));
          const b = WalkthroughV1.parse(args.walkthrough);
          return [a, b];
        }`);
      expect(v).toHaveLength(2);
      expect(v.every((x) => x.payloadArg === "<non-name>")).toBe(true);
    });
  });

  describe("constructor idiom (Python→Zod adaptation: keyword-construction is not gated)", () => {
    it("does NOT gate parse of an inline object literal (Zod's Pydantic-constructor analogue)", () => {
      expect(
        violations(`
          function autoPromote(finding: { file: string }) {
            return ReviewFindingV1.parse({
              file: finding.file,
              severity: "blocker",
              confidence: 0.99,
            });
          }`),
      ).toHaveLength(0);
    });
  });

  describe("function-body scoping (mirrors the Python per-function walker)", () => {
    it("does NOT let an outer coerce binding cover a parse in a NESTED function", () => {
      expect(
        violations(`
          function outer(payload: Record<string, unknown>) {
            const coerced = coerceForContract(payload, ReviewFindingV1, { blockId });
            function inner() {
              return ReviewFindingV1.parse(coerced);
            }
            return inner();
          }`),
      ).toHaveLength(1);
    });

    it("treats a BLOCK-body arrow as its own context (like a nested def)", () => {
      expect(
        violations(`
          function outer(payload: Record<string, unknown>) {
            const coerced = coerceForContract(payload, ReviewFindingV1, { blockId });
            return [1].map(() => {
              return ReviewFindingV1.parse(coerced);
            });
          }`),
      ).toHaveLength(1);
    });

    it("treats a CONCISE-body arrow as transparent (the Python lambda rule)", () => {
      expect(
        violations(`
          function outer(payload: Record<string, unknown>) {
            const coerced = coerceForContract(payload, ReviewFindingV1, { blockId });
            return [1].map(() => ReviewFindingV1.parse(coerced));
          }`),
      ).toHaveLength(0);
    });

    it("skips module-scope parse calls (the Python walks function bodies only)", () => {
      expect(violations("const x = ReviewFindingV1.parse(payload);")).toHaveLength(0);
    });
  });

  describe("registry boundaries", () => {
    it("ignores schemas not in the LLM-output registry (e.g. FixPromptV1 — matches Python)", () => {
      expect(
        violations(`
          function f(payload: Record<string, unknown>) {
            return FixPromptV1.parse(payload);
          }`),
      ).toHaveLength(0);
    });

    it("ignores attribute-chain receivers (bare-Name-only rule, verbatim from the Python gate)", () => {
      expect(
        violations(`
          function f(payload: Record<string, unknown>) {
            return contracts.ReviewFindingV1.parse(payload);
          }`),
      ).toHaveLength(0);
    });

    it("ignores non-parse methods on registered contracts", () => {
      expect(
        violations(`
          function f() {
            return ReviewFindingV1.extend({ extra: z.string() });
          }`),
      ).toHaveLength(0);
    });
  });

  describe("production-only scope (matches the sibling gates)", () => {
    const bypass = `
      function f(payload: Record<string, unknown>) {
        return ReviewFindingV1.parse(payload);
      }`;

    it("does NOT scan test files, scripts/, tools/, or test/ trees", () => {
      expect(violations(bypass, "apps/backend/src/review/x.test.ts")).toHaveLength(0);
      expect(violations(bypass, "test/parity/x.ts")).toHaveLength(0);
      expect(violations(bypass, "scripts/gates/x.ts")).toHaveLength(0);
      expect(violations(bypass, "tools/parity/x.ts")).toHaveLength(0);
    });

    it("DOES scan production source under apps/<app>/src and libs/<pkg>/src", () => {
      expect(violations(bypass, "apps/backend/src/review/x.ts")).toHaveLength(1);
      expect(violations(bypass, "libs/contracts/src/x.ts")).toHaveLength(1);
    });

    it("isProductionSource: {libs,apps}/<pkg>/src non-test → true; test/scripts/*.test.ts → false", () => {
      expect(isProductionSource("/r/apps/backend/src/x.ts")).toBe(true);
      expect(isProductionSource("/r/libs/contracts/src/x.ts")).toBe(true);
      expect(isProductionSource("/r/apps/backend/src/x.test.ts")).toBe(false);
      expect(isProductionSource("/r/test/gates/x.ts")).toBe(false);
      expect(isProductionSource("/r/scripts/gates/x.ts")).toBe(false);
    });
  });

  describe("EXEMPTED registry discipline", () => {
    it("every entry carries a PERMANENT-EXEMPTION-* or well-formed story-id follow_up_story", () => {
      const storyIdRe = /^(S\d+\.([A-Z]+\.\d+|X-[\w-]+|[A-Z]+)|PERMANENT-EXEMPTION-[\w-]+)$/;
      for (const entry of Object.values(EXEMPTED)) {
        expect(entry.follow_up_story).toMatch(storyIdRe);
        expect(entry.reason.length).toBeGreaterThan(0);
        expect(entry.symbol.length).toBeGreaterThan(0);
      }
    });

    it("every exempted key points at a live registered-contract parse line (no stale over-exemption)", () => {
      // Guards the key shape `<repo-relative path>::<line>` against silent drift: if the target file
      // is edited and the parse call moves, this test fails BEFORE the main() smoke turns red.
      for (const key of Object.keys(EXEMPTED)) {
        const [file, lineStr] = key.split("::") as [string, string];
        const line = Number(lineStr);
        expect(Number.isInteger(line) && line > 0).toBe(true);
        const lines = readFileSync(file, "utf8").split("\n");
        const target = lines[line - 1] ?? "";
        const referencesContract = [...LLM_OUTPUT_CONTRACTS].some(
          (contract) => target.includes(`${contract}.parse(`) || target.includes(`${contract}.safeParse(`),
        );
        expect(referencesContract, `${key} does not point at a registered-contract parse call`).toBe(
          true,
        );
      }
    });

    it("suppresses an exempted real-tree site in a fixture replica (key = path::line)", () => {
      // Reconstruct the exempted shape at the exact exempted path + line so the registry branch is
      // exercised hermetically: pad the fixture so the parse call lands on line 132.
      const path = "apps/backend/src/domain/repos/review_walkthroughs_repo.ts";
      const pad = "// pad\n".repeat(129);
      const code =
        `${pad}function upsert(args: { walkthrough: unknown }) {\n` +
        `  const s =\n` +
        `    JSON.stringify(WalkthroughV1.parse(args.walkthrough));\n` + // line 132
        `  return s;\n}\n`;
      expect(violations(code, path)).toHaveLength(0);
      // The same shape at an UN-exempted line in another file is a violation — the exemption is
      // keyed, not structural.
      expect(violations(code, "apps/backend/src/domain/repos/other_repo.ts")).toHaveLength(1);
    });
  });

  describe("main() return code (real-repo smoke)", () => {
    it("returns 0 against the real tree (all live LLM-output parsers route through coercion)", () => {
      // The registered TS parser sites (tool_schema.ts, walkthrough_schema.ts, curator_schema.ts)
      // coerce before parse; the two walkthrough-repo DB-roundtrip sites are EXEMPTED by design.
      expect(main()).toBe(0);
    });

    it("reports a non-empty finding set when a bypass is present (the input to main()'s 1)", () => {
      const v = violations(`
        function f(payload: Record<string, unknown>) {
          return ReviewChunkResponseV1.parse(payload);
        }`);
      expect(v.length).toBeGreaterThan(0);
    });
  });
});
