import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";

import { findExemptedListsViolations } from "../../scripts/gates/check_exempted_lists_pointed.js";

// Build an in-memory TS project from a snippet and run the gate over it.
// The frozen Python gate (scripts/check_exempted_lists_pointed.py) has no dedicated test in
// vendor/codemaster-py; these cases mirror its own _validate_entry_value / _STORY_ID_RE logic:
//   - a well-formed `follow_up_story` (each story-id variant) passes;
//   - a missing key, a non-string value, or a non-matching pattern is a violation;
//   - an empty EXEMPTED or a file with no EXEMPTED export yields no violations.
function violations(code: string) {
  const p = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { experimentalDecorators: true },
  });
  p.createSourceFile("x.ts", code);
  return findExemptedListsViolations(p);
}

describe("exempted-lists-pointed gate", () => {
  it("passes an entry with a sprint-aligned multi-letter follow_up_story", () => {
    expect(
      violations(
        `export const EXEMPTED = {
          "core.foo": { reason: "by design", follow_up_story: "S23.AR.17" },
        };`,
      ),
    ).toHaveLength(0);
  });

  it("passes an entry with a single-letter sprint-aligned follow_up_story (S16.A.1)", () => {
    expect(
      violations(
        `export const EXEMPTED = {
          "core.foo": { reason: "r", follow_up_story: "S16.A.1" },
        };`,
      ),
    ).toHaveLength(0);
  });

  it("passes an entry with a short-form sprint follow_up_story (S15.H)", () => {
    expect(
      violations(
        `export const EXEMPTED = {
          "core.foo": { reason: "r", follow_up_story: "S15.H" },
        };`,
      ),
    ).toHaveLength(0);
  });

  it("passes an entry with a hotfix follow_up_story (S15.X-token-provider)", () => {
    expect(
      violations(
        `export const EXEMPTED = {
          "core.foo": { reason: "r", follow_up_story: "S15.X-token-provider" },
        };`,
      ),
    ).toHaveLength(0);
  });

  it("passes an entry with a PERMANENT-EXEMPTION follow_up_story", () => {
    expect(
      violations(
        `export const EXEMPTED = {
          "core.foo": { reason: "r", follow_up_story: "PERMANENT-EXEMPTION-migration-test-fixtures-need-raw-sql" },
        };`,
      ),
    ).toHaveLength(0);
  });

  it("flags an entry missing the follow_up_story key", () => {
    const v = violations(
      `export const EXEMPTED = {
        "core.foo": { reason: "no follow-up" },
      };`,
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.key).toBe("core.foo");
    expect(v[0]!.message).toContain("missing `follow_up_story` key");
  });

  it("flags an entry whose follow_up_story is not a string literal", () => {
    const v = violations(
      `const STORY = "S16.A.1";
       export const EXEMPTED = {
        "core.foo": { reason: "r", follow_up_story: STORY },
      };`,
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.key).toBe("core.foo");
    expect(v[0]!.message).toContain("not a string literal");
  });

  it("flags an entry whose follow_up_story doesn't match the story-id pattern", () => {
    const v = violations(
      `export const EXEMPTED = {
        "core.foo": { reason: "r", follow_up_story: "TODO-later" },
      };`,
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.key).toBe("core.foo");
    expect(v[0]!.message).toContain("doesn't match the");
  });

  it("flags an entry whose value is not an object literal", () => {
    const v = violations(
      `export const EXEMPTED = {
        "core.foo": "S16.A.1",
      };`,
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.key).toBe("core.foo");
    expect(v[0]!.message).toContain("value is not an object literal");
  });

  it("reports one violation per malformed entry across a multi-entry EXEMPTED", () => {
    const v = violations(
      `export const EXEMPTED = {
        "core.ok": { reason: "r", follow_up_story: "S16.A.1" },
        "core.missing": { reason: "r" },
        "core.bad": { reason: "r", follow_up_story: "nope" },
      };`,
    );
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.key).sort()).toEqual(["core.bad", "core.missing"]);
  });

  it("passes an empty EXEMPTED object (the day-one landing state)", () => {
    expect(violations("export const EXEMPTED = {};")).toHaveLength(0);
  });

  it("ignores a file with no EXEMPTED export (different exclusion mechanism)", () => {
    expect(
      violations("export const TENANT_SCOPED_TABLES = new Set(['core.repositories']);"),
    ).toHaveLength(0);
  });

  it("supports an identifier (unquoted) entry key", () => {
    const v = violations(
      `export const EXEMPTED = {
        coreFoo: { reason: "r" },
      };`,
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.key).toBe("coreFoo");
  });
});
