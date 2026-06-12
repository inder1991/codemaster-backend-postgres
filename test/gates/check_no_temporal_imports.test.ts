// The PERMANENT LOCK on the Temporal teardown: once @temporalio is removed, no import may return.
// This gate scans the codebase for `@temporalio` import/require statements and the package.json
// dependency entries, failing CI if any reappear. (Prose mentions of "@temporalio" in comments are
// NOT flagged — only actual module references.)
import { describe, expect, it } from "vitest";

import {
  isTemporalModuleReference,
  scanRepoForTemporalReferences,
} from "../../scripts/gates/check_no_temporal_imports.js";

describe("isTemporalModuleReference — only real module references, never prose", () => {
  it.each([
    'import { ApplicationFailure } from "@temporalio/common";',
    "import { Context } from '@temporalio/activity';",
    'const { Client } = await import("@temporalio/client");',
    'require("@temporalio/worker")',
    '    "@temporalio/workflow": "^1.11.0",',
  ])("flags a real reference: %s", (line) => {
    expect(isTemporalModuleReference(line)).toBe(true);
  });

  it.each([
    "// the @temporalio worker was removed in the teardown",
    " * 1:1 with @temporalio/common's ApplicationFailure (historical note)",
    "const temporalish = 1; // not a module",
  ])("does NOT flag prose: %s", (line) => {
    expect(isTemporalModuleReference(line)).toBe(false);
  });
});

describe("scanRepoForTemporalReferences — the live lock", () => {
  it("finds ZERO @temporalio module references across apps/libs/scripts/test + package.json", () => {
    const hits = scanRepoForTemporalReferences();
    expect(hits, `@temporalio references must stay removed; found:\n${hits.join("\n")}`).toEqual([]);
  });
});
