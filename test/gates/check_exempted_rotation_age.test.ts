import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";

import {
  PERMANENT_PREFIX,
  STALENESS_THRESHOLD_DAYS,
  collectExemptedEntries,
  findRotationViolations,
  type BlameOracle,
} from "../../scripts/gates/check_exempted_rotation_age.js";

// Build an in-memory project under scripts/gates/ (the path the gate walks) from a snippet.
// Mirrors the frozen Python gate's tests (test_check_exempted_rotation_age.py) using in-memory TS
// snippets + an injected blame oracle, rather than real git / wall-clock — the same per-line-blame
// contract the Python test exercised directly, expressed as a deterministic fake.
function gateProject(code: string, filename = "scripts/gates/_fake_gate.ts"): Project {
  const p = new Project({ useInMemoryFileSystem: true });
  p.createSourceFile(filename, code);
  return p;
}

/** Oracle that returns a fixed age for every line. */
const constantBlame =
  (ageDays: number | null): BlameOracle =>
  () =>
    ageDays;

describe("EXEMPTED rotation-age gate", () => {
  it("exposes the frozen threshold and permanent-prefix constants", () => {
    // Mirrors the Python test's symbol assertions (_STALENESS_THRESHOLD_DAYS / _PERMANENT_PREFIX).
    expect(STALENESS_THRESHOLD_DAYS).toBe(14);
    expect(PERMANENT_PREFIX).toBe("PERMANENT-EXEMPTION-");
  });

  it("passes a fresh entry (age <= threshold is not flagged)", () => {
    const code = `
      export const EXEMPTED: Record<string, { reason: string; follow_up_story: string }> = {
        "fresh_entry": { reason: "x", follow_up_story: "S99.A.1" },
      };`;
    // Exactly at the threshold is still fresh (<= threshold).
    expect(
      findRotationViolations(gateProject(code), constantBlame(STALENESS_THRESHOLD_DAYS)),
    ).toHaveLength(0);
  });

  it("flags a stale, non-permanent entry (age > threshold)", () => {
    const code = `
      export const EXEMPTED: Record<string, { reason: string; follow_up_story: string }> = {
        "old_entry_key": { reason: "x", follow_up_story: "S99.X-old" },
      };`;
    const v = findRotationViolations(gateProject(code), constantBlame(30));
    expect(v).toHaveLength(1);
    expect(v[0]!.key).toBe("old_entry_key");
    expect(v[0]!.follow_up_story).toBe("S99.X-old");
    expect(v[0]!.ageDays).toBe(30);
  });

  it("skips PERMANENT-EXEMPTION-* entries even when stale", () => {
    const code = `
      export const EXEMPTED: Record<string, { reason: string; follow_up_story: string }> = {
        "permanent_entry": { reason: "x", follow_up_story: "PERMANENT-EXEMPTION-migration-test-fixtures" },
      };`;
    expect(findRotationViolations(gateProject(code), constantBlame(365))).toHaveLength(0);
  });

  it("does not flag when the blame oracle is absent (null age — git missing / uncommitted)", () => {
    // Analogue of the Python missing-git fallback: a null oracle result means no staleness signal,
    // so nothing is flagged (the CLI surfaces a [WARN] and exits 0 when git is wholly absent).
    const code = `
      export const EXEMPTED: Record<string, { reason: string; follow_up_story: string }> = {
        "uncommitted_entry": { reason: "x", follow_up_story: "S99.A.1" },
      };`;
    expect(findRotationViolations(gateProject(code), constantBlame(null))).toHaveLength(0);
  });

  it("queries blame on the dict-key line, independent of unrelated edits elsewhere in the file", () => {
    // R1 regression mirror: the oracle is per-LINE. An unrelated comment above the entry shifts the
    // dict-key to line 4, and the gate must consult blame for THAT line (not line 1, not the file).
    // We assert by capturing the line number the oracle is asked about.
    const code = [
      "// unrelated comment edit (would reset a per-file mtime oracle, but not per-line blame)",
      "export const EXEMPTED: Record<string, { reason: string; follow_up_story: string }> = {",
      '  "old_entry_key": { reason: "x", follow_up_story: "S99.X-old" },',
      "};",
    ].join("\n");
    const asked: Array<number> = [];
    const recordingBlame: BlameOracle = (_file, line) => {
      asked.push(line);
      return 30; // simulate the 30-day-old commit still owning that exact line
    };
    const v = findRotationViolations(gateProject(code), recordingBlame);
    expect(asked).toEqual([3]); // dict-key property is the 3rd source line (1-based)
    expect(v).toHaveLength(1);
    expect(v[0]!.line).toBe(3);
  });

  it("collects key + follow_up_story + line for each EXEMPTED entry (AST extraction)", () => {
    const code = [
      "export const EXEMPTED = {",
      '  "a": { reason: "r1", follow_up_story: "S1.A.1" },',
      '  "b": { reason: "r2", follow_up_story: "PERMANENT-EXEMPTION-x" },',
      "};",
    ].join("\n");
    const sf = gateProject(code).getSourceFileOrThrow("scripts/gates/_fake_gate.ts");
    const entries = collectExemptedEntries(sf);
    expect(entries).toEqual([
      { key: "a", follow_up_story: "S1.A.1", line: 2 },
      { key: "b", follow_up_story: "PERMANENT-EXEMPTION-x", line: 3 },
    ]);
  });

  it("treats an empty EXEMPTED dict as zero entries (day-one landing state)", () => {
    const code = "export const EXEMPTED: Record<string, never> = {};";
    const sf = gateProject(code).getSourceFileOrThrow("scripts/gates/_fake_gate.ts");
    expect(collectExemptedEntries(sf)).toHaveLength(0);
    expect(findRotationViolations(gateProject(code), constantBlame(999))).toHaveLength(0);
  });

  it("ignores gate test files and non-gate files (only scripts/gates/*.ts gates are walked)", () => {
    const code = `
      export const EXEMPTED = { "k": { reason: "x", follow_up_story: "S1.A.1" } };`;
    // A *.test.ts sibling must be skipped even with a stale entry.
    expect(
      findRotationViolations(
        gateProject(code, "scripts/gates/something.test.ts"),
        constantBlame(99),
      ),
    ).toHaveLength(0);
    // A file outside scripts/gates/ must be skipped.
    expect(
      findRotationViolations(gateProject(code, "libs/foo/EXEMPTED.ts"), constantBlame(99)),
    ).toHaveLength(0);
  });
});
