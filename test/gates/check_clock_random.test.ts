import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";

import {
  EXEMPTED,
  findClockRandomViolations,
  main,
  productionSourceFiles,
  type Violation,
} from "../../scripts/gates/check_clock_random.js";

// Build an in-memory project from a {path: code} map and run the gate over it. Mirrors the frozen
// Python gate's tests (test_no_wall_clock.py) using in-memory TS snippets rather than real files —
// the same banned-construct contract expressed as deterministic AST fixtures.
function violationsFor(files: Record<string, string>): Array<Violation> {
  const p = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, code] of Object.entries(files)) {
    p.createSourceFile(filePath, code);
  }
  return findClockRandomViolations(p);
}

function constructsFor(files: Record<string, string>): Array<string> {
  return violationsFor(files).map((v) => v.construct);
}

describe("clock/random seam gate", () => {
  it("should export an empty EXEMPTED dict at landing (gate is permanent)", () => {
    expect(EXEMPTED).toEqual({});
  });

  describe("flags banned constructs in production source", () => {
    it("should flag Date.now() in a libs source file", () => {
      const v = violationsFor({ "libs/foo/src/bar.ts": "const t = Date.now();" });
      expect(v).toHaveLength(1);
      expect(v[0]!.construct).toBe("Date.now()");
      expect(v[0]!.file).toBe("libs/foo/src/bar.ts");
      expect(v[0]!.line).toBe(1);
    });

    it("should flag Date.now() in an apps source file (apps/<app>/src/** is in scope)", () => {
      const v = violationsFor({
        "apps/backend/src/backend/redact/secret_detector.ts": "const t = Date.now();",
      });
      expect(v).toHaveLength(1);
      expect(v[0]!.construct).toBe("Date.now()");
      expect(v[0]!.file).toBe("apps/backend/src/backend/redact/secret_detector.ts");
    });

    it("should flag new Date() with zero arguments", () => {
      expect(constructsFor({ "libs/foo/src/bar.ts": "const d = new Date();" })).toEqual([
        "new Date()",
      ]);
    });

    it("should flag Math.random()", () => {
      expect(constructsFor({ "libs/foo/src/bar.ts": "const r = Math.random();" })).toEqual([
        "Math.random()",
      ]);
    });

    it("should flag performance.now()", () => {
      expect(constructsFor({ "libs/foo/src/bar.ts": "const t = performance.now();" })).toEqual([
        "performance.now()",
      ]);
    });

    it("should flag a bare randomBytes() call (node:crypto named import)", () => {
      const code = ['import { randomBytes } from "node:crypto";', "const b = randomBytes(16);"].join(
        "\n",
      );
      expect(constructsFor({ "libs/foo/src/bar.ts": code })).toEqual(["randomBytes()"]);
    });

    it("should flag process.hrtime() and process.hrtime.bigint()", () => {
      const code = ["const a = process.hrtime();", "const b = process.hrtime.bigint();"].join("\n");
      expect(constructsFor({ "libs/foo/src/bar.ts": code })).toEqual([
        "process.hrtime()",
        "process.hrtime.bigint()",
      ]);
    });

    it("should flag crypto.randomUUID() member access", () => {
      expect(constructsFor({ "libs/foo/src/bar.ts": "const id = crypto.randomUUID();" })).toEqual([
        "crypto.randomUUID()",
      ]);
    });
  });

  describe("allows legitimate usage", () => {
    it("should allow new Date(arg) with an argument (parsing a known instant)", () => {
      expect(
        violationsFor({ "libs/foo/src/bar.ts": "const d = new Date(1700000000000);" }),
      ).toHaveLength(0);
    });

    it("should allow Date.now() and new Date() inside the clock seam", () => {
      const code = ["const t = Date.now();", "const d = new Date();", "const p = performance.now();"].join(
        "\n",
      );
      expect(violationsFor({ "libs/platform/src/clock.ts": code })).toHaveLength(0);
    });

    it("should allow process.hrtime() inside the clock seam", () => {
      const code = ["const a = process.hrtime();", "const b = process.hrtime.bigint();"].join("\n");
      expect(violationsFor({ "libs/platform/src/clock.ts": code })).toHaveLength(0);
    });

    it("should allow randomBytes() inside the randomness seam", () => {
      const code = ['import { randomBytes } from "node:crypto";', "const b = randomBytes(16);"].join(
        "\n",
      );
      expect(violationsFor({ "libs/platform/src/randomness.ts": code })).toHaveLength(0);
    });

    it("should ban Math.random() even inside the clock seam (no seam may use it)", () => {
      expect(constructsFor({ "libs/platform/src/clock.ts": "const r = Math.random();" })).toEqual([
        "Math.random()",
      ]);
    });

    it("should ban Date.now() inside the randomness seam (wrong seam for the clock family)", () => {
      expect(constructsFor({ "libs/platform/src/randomness.ts": "const t = Date.now();" })).toEqual([
        "Date.now()",
      ]);
    });

    it("should not flag banned tokens that appear only in comments or strings", () => {
      const code = [
        "// Date.now() and Math.random() must not match here",
        'const s = "Date.now() new Date() randomBytes(16)";',
      ].join("\n");
      expect(violationsFor({ "libs/foo/src/bar.ts": code })).toHaveLength(0);
    });
  });

  describe("scopes to production source only", () => {
    it("should ignore *.test.ts files under libs", () => {
      expect(
        violationsFor({ "libs/foo/src/bar.test.ts": "const t = Date.now();" }),
      ).toHaveLength(0);
    });

    it("should ignore files outside any libs/<lib>/src tree (scripts, tools, migrations)", () => {
      expect(
        violationsFor({
          "scripts/gates/some_gate.ts": "const t = Date.now();",
          "tools/parity/run.ts": "const r = Math.random();",
          "migrations/0001_init.ts": "const d = new Date();",
        }),
      ).toHaveLength(0);
    });
  });

  describe("main() return code", () => {
    it("should return 0 against the real tree (no banned usage outside the seams)", () => {
      // The real libs/ production source must be clean: this is the gate's steady-state invariant.
      expect(main()).toBe(0);
    });

    it("should report a non-empty finding set when a violation is present (the input to main()'s 1)", () => {
      // main() returns 1 iff findClockRandomViolations is non-empty; drive that branch in-memory
      // since main() walks the real tsconfig project (which is clean by invariant above).
      const v = violationsFor({ "libs/foo/src/bad.ts": "const t = Date.now();" });
      expect(v.length).toBeGreaterThan(0);
    });

    it("should report zero findings on a clean in-memory tree (the input to main()'s 0)", () => {
      expect(violationsFor({ "libs/foo/src/good.ts": "export const x = 1;" })).toHaveLength(0);
    });
  });

  describe("productionSourceFiles selector", () => {
    it("should select only libs/<lib>/src non-test .ts files", () => {
      const p = new Project({ useInMemoryFileSystem: true });
      p.createSourceFile("libs/foo/src/a.ts", "export const a = 1;");
      p.createSourceFile("libs/foo/src/a.test.ts", "export const b = 1;");
      p.createSourceFile("scripts/gates/g.ts", "export const c = 1;");
      const selected = productionSourceFiles(p).map((sf) => sf.getFilePath());
      expect(selected.some((f) => f.endsWith("libs/foo/src/a.ts"))).toBe(true);
      expect(selected.some((f) => f.endsWith("a.test.ts"))).toBe(false);
      expect(selected.some((f) => f.endsWith("scripts/gates/g.ts"))).toBe(false);
    });
  });
});
