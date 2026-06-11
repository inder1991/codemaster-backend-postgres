import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";

import {
  EXEMPTED,
  findActivityInputRoots,
  findJobPayloadRoots,
  findJsonUnsafeViolations,
  type GateResult,
  main,
} from "../../scripts/gates/check_activity_input_json_safe.js";

// Build an in-memory TS project from a {path: code} map and run the gate over it. Mirrors the frozen
// Python gate's tests (test_check_temporal_activity_input_json_safe.py): fixture contracts reachable
// from a dispatch boundary (an activity's first typed parameter / a runner payload parse site) are
// walked recursively for JSON-round-trip-unsafe shapes — the smoke-#10 dict[UUID, UUID] crash class
// transposed onto Zod/TS (z.date()/z.map()/z.set()/z.bigint(), non-string record keys, Date/Map/Set/
// bigint-typed fields).
function resultFor(files: Record<string, string>): GateResult {
  const p = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, code] of Object.entries(files)) {
    p.createSourceFile(filePath, code);
  }
  return findJsonUnsafeViolations(p);
}

function constructsFor(files: Record<string, string>): Array<string> {
  return resultFor(files).errors.map((v) => v.construct);
}

/** A minimal activity module whose exported function's FIRST parameter is the given contract type. */
function activityUsing(typeName: string, contractModule: string): string {
  return [
    `import type { ${typeName} } from "#contracts/${contractModule}.js";`,
    `export async function fooActivity(input: ${typeName}): Promise<void> { void input; }`,
  ].join("\n");
}

/** A minimal Zod contract module exporting `FooInputV1` with the given object fields. */
function contractWith(fields: string): string {
  return [
    'import { z } from "zod";',
    `export const FooInputV1 = z.object({ ${fields} }).strict();`,
    "export type FooInputV1 = z.infer<typeof FooInputV1>;",
  ].join("\n");
}

const ACTIVITY_PATH = "apps/backend/src/activities/foo.activity.ts";
const CONTRACT_PATH = "libs/contracts/src/foo_input.v1.ts";

describe("activity/job-input JSON-safety gate", () => {
  it("should export an empty EXEMPTED dict at landing (no production contract is JSON-unsafe)", () => {
    expect(EXEMPTED).toEqual({});
  });

  describe("activity-input surface (the @activity.defn analogue)", () => {
    it("passes a JSON-safe activity input contract (strings, ints, string-keyed records)", () => {
      const r = resultFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        [CONTRACT_PATH]: contractWith(
          "schema_version: z.literal(1).default(1), id: z.string().uuid(), n: z.number().int(), " +
            "by_id: z.record(z.string().uuid(), z.string()), opaque: z.record(z.unknown()), " +
            "when: z.string().datetime({ offset: true })",
        ),
      });
      expect(r.errors).toHaveLength(0);
      expect(r.warnings).toHaveLength(0);
      expect(r.roots).toHaveLength(1);
    });

    it("flags z.date() on an activity input (a validated Date round-trips to an ISO string)", () => {
      const r = resultFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        [CONTRACT_PATH]: contractWith("when: z.date()"),
      });
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.construct).toBe("z.date()");
      expect(r.errors[0]!.file).toBe(CONTRACT_PATH);
      expect(r.errors[0]!.schema).toBe("FooInputV1");
      expect(r.errors[0]!.root).toContain("fooActivity()");
    });

    it("allows z.coerce.date() (coercion re-accepts the post-round-trip ISO string)", () => {
      expect(
        constructsFor({
          [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
          [CONTRACT_PATH]: contractWith("when: z.coerce.date()"),
        }),
      ).toHaveLength(0);
    });

    it("flags z.bigint()/z.coerce.bigint()/z.map()/z.set()/z.nan() (the W4c.1 #9 unsafe set)", () => {
      const constructs = constructsFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        [CONTRACT_PATH]: contractWith(
          "a: z.bigint(), b: z.coerce.bigint(), c: z.map(z.string(), z.string()), " +
            "d: z.set(z.string()), e: z.nan()",
        ),
      });
      expect(constructs).toEqual(
        expect.arrayContaining(["z.bigint()", "z.coerce.bigint()", "z.map()", "z.set()", "z.nan()"]),
      );
      expect(constructs).toHaveLength(5);
    });

    it("flags unsafe shapes NESTED in a sibling contract (recursion through contract imports)", () => {
      const r = resultFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        [CONTRACT_PATH]: [
          'import { z } from "zod";',
          'import { NestedV1 } from "./nested.v1.js";',
          "export const FooInputV1 = z.object({ items: z.array(z.array(NestedV1)) }).strict();",
        ].join("\n"),
        "libs/contracts/src/nested.v1.ts": [
          'import { z } from "zod";',
          "export const NestedV1 = z.object({ bad: z.map(z.string(), z.string()) });",
        ].join("\n"),
      });
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.file).toBe("libs/contracts/src/nested.v1.ts");
      expect(r.errors[0]!.schema).toBe("NestedV1");
      expect(r.errors[0]!.construct).toBe("z.map()");
    });

    it("does NOT walk contracts unreachable from any dispatch boundary (row contracts may use z.date())", () => {
      const r = resultFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        [CONTRACT_PATH]: contractWith("id: z.string()"),
        // A repo-row contract: nothing dispatches it, so its z.date() is out of the gate's scope.
        "libs/contracts/src/some_row.v1.ts":
          'import { z } from "zod";\nexport const SomeRowV1 = z.object({ created_at: z.date() });',
      });
      expect(r.errors).toHaveLength(0);
    });

    it("skips helpers whose first parameter is an inline object (not a wire boundary)", () => {
      const p = new Project({ useInMemoryFileSystem: true });
      p.createSourceFile(
        ACTIVITY_PATH,
        "export async function doHelper(args: { when: Date }): Promise<void> { void args; }",
      );
      expect(findActivityInputRoots(p)).toHaveLength(0);
    });
  });

  describe("z.record key discipline (the literal dict[UUID, UUID] analogue)", () => {
    it("flags z.record(z.number(), V) — JSON object keys arrive as strings and fail re-parse", () => {
      const constructs = constructsFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        [CONTRACT_PATH]: contractWith("by_n: z.record(z.number(), z.string())"),
      });
      expect(constructs).toHaveLength(1);
      expect(constructs[0]).toContain("non-string key");
    });

    it("accepts a same-file string-producing key helper (the uuidLower() idiom)", () => {
      const r = resultFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        [CONTRACT_PATH]: [
          'import { z } from "zod";',
          "const uuidLower = () => z.string().uuid().transform((s) => s.toLowerCase());",
          "export const FooInputV1 = z.object({ by_id: z.record(uuidLower(), z.string()) }).strict();",
        ].join("\n"),
      });
      expect(r.errors).toHaveLength(0);
      expect(r.warnings).toHaveLength(0);
    });

    it("WARNs (not ERRORs) on a key schema the gate cannot statically classify", () => {
      const r = resultFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        [CONTRACT_PATH]: [
          'import { z } from "zod";',
          'import { opaqueKey } from "#platform/keys.js";', // non-contract import: not followed
          "export const FooInputV1 = z.object({ m: z.record(opaqueKey(), z.string()) }).strict();",
        ].join("\n"),
      });
      expect(r.errors).toHaveLength(0);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]!.message).toContain("not statically verifiable");
    });
  });

  describe("job-payload surface (background_jobs / review_jobs — the W2b handler-owned parse)", () => {
    const RUNNER_PATH = "apps/backend/src/runner/handlers/bar_handlers.ts";
    const runnerParsing = (call: string): string =>
      [
        'import { BarPayloadV1 } from "#contracts/bar_payload.v1.js";',
        `export function handle(payload: unknown): void { ${call}; }`,
      ].join("\n");

    it("flags an unsafe shape on a contract parsed in a runner handler", () => {
      const r = resultFor({
        [RUNNER_PATH]: runnerParsing("BarPayloadV1.parse(payload)"),
        "libs/contracts/src/bar_payload.v1.ts":
          'import { z } from "zod";\nexport const BarPayloadV1 = z.object({ s: z.set(z.string()) });',
      });
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.construct).toBe("z.set()");
      expect(r.errors[0]!.root).toContain("BarPayloadV1.parse(...)");
    });

    it("discovers safeParse sites too", () => {
      const p = new Project({ useInMemoryFileSystem: true });
      p.createSourceFile(RUNNER_PATH, runnerParsing("BarPayloadV1.safeParse(payload)"));
      p.createSourceFile(
        "libs/contracts/src/bar_payload.v1.ts",
        'import { z } from "zod";\nexport const BarPayloadV1 = z.object({});',
      );
      expect(findJobPayloadRoots(p)).toHaveLength(1);
    });

    it("does NOT treat runner *.test.ts parse sites as dispatch roots", () => {
      const r = resultFor({
        "apps/backend/src/runner/handlers/bar_handlers.test.ts": runnerParsing("BarPayloadV1.parse(payload)"),
        "libs/contracts/src/bar_payload.v1.ts":
          'import { z } from "zod";\nexport const BarPayloadV1 = z.object({ s: z.set(z.string()) });',
      });
      expect(r.errors).toHaveLength(0);
      expect(r.roots).toHaveLength(0);
    });
  });

  describe("plain-TS payload types (the type-level half of the unsafe set)", () => {
    it("flags Date/Map/bigint fields and Record keyed by non-string on a type-alias contract", () => {
      const constructs = constructsFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        [CONTRACT_PATH]:
          "export type FooInputV1 = { when: Date; m: Map<string, string>; n: bigint; r: Record<number, string> };",
      });
      expect(constructs).toEqual(
        expect.arrayContaining([
          "Date (TS type)",
          "Map (TS type)",
          "bigint (TS type)",
          "Record<number, …> non-string key (TS type)",
        ]),
      );
      expect(constructs).toHaveLength(4);
    });

    it("passes string-keyed Records and ISO-string instants on a type-alias contract", () => {
      expect(
        constructsFor({
          [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
          [CONTRACT_PATH]:
            'export type FooInputV1 = { when: string; r: Record<string, number>; lit: Record<"a" | "b", number> };',
        }),
      ).toHaveLength(0);
    });
  });

  describe("escape hatches (S23.AR.17 P-2 rotation discipline)", () => {
    it("suppresses a violation carrying an inline // json-safe:exempt marker on the preceding line", () => {
      const r = resultFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        [CONTRACT_PATH]: [
          'import { z } from "zod";',
          "export const FooInputV1 = z.object({",
          "  // json-safe:exempt reason=legacy-row-shape follow_up=S99.X-json-safe-cleanup",
          "  when: z.date(),",
          "}).strict();",
        ].join("\n"),
      });
      expect(r.errors).toHaveLength(0);
    });

    it("does NOT suppress without the marker (same fixture minus the comment)", () => {
      const r = resultFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        [CONTRACT_PATH]: [
          'import { z } from "zod";',
          "export const FooInputV1 = z.object({",
          "  when: z.date(),",
          "}).strict();",
        ].join("\n"),
      });
      expect(r.errors).toHaveLength(1);
    });
  });

  describe("walker robustness", () => {
    it("terminates on z.lazy self-recursive schemas (the JsonValue idiom) with zero findings", () => {
      const r = resultFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        [CONTRACT_PATH]: [
          'import { z } from "zod";',
          "type JsonValue = string | number | boolean | null | Array<JsonValue> | { [key: string]: JsonValue };",
          "const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>",
          "  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema)]),",
          ");",
          "export const FooInputV1 = z.object({ payload: z.record(JsonValueSchema) }).strict();",
        ].join("\n"),
      });
      expect(r.errors).toHaveLength(0);
      expect(r.warnings).toHaveLength(0);
    });

    it("dedupes a violation reachable from multiple dispatch roots", () => {
      const r = resultFor({
        [ACTIVITY_PATH]: activityUsing("FooInputV1", "foo_input.v1"),
        "apps/backend/src/activities/other.activity.ts": [
          'import type { FooInputV1 } from "#contracts/foo_input.v1.js";',
          "export async function otherActivity(input: FooInputV1): Promise<void> { void input; }",
        ].join("\n"),
        [CONTRACT_PATH]: contractWith("when: z.date()"),
      });
      expect(r.errors).toHaveLength(1);
    });
  });

  describe("main() against the real tree", () => {
    it("returns 0 (no dispatch-reachable contract is JSON-unsafe — the gate's steady-state invariant)", () => {
      expect(main()).toBe(0);
    });
  });
});
