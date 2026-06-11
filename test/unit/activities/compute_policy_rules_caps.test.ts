/**
 * W4.4 [M9] + [H6 — cooperative-yield slice] over the policy compute chain.
 *
 * M9: resolution was unbounded O(changed_paths × total_rules) — the A-1 cap bounds FILES (200), not
 * RULES, and `changed_paths` had no cap at all. A pathological monorepo PR (many guideline docs ×
 * hundreds of changed paths) pinned a shared worker in one synchronous burst. The chain now carries
 * MAX_TOTAL_RULES + MAX_CHANGED_PATHS, surfacing either cap through the envelope's existing
 * `truncated` flag (a TS hardening divergence — the frozen Python has no rule/path caps; the parity
 * corpus sits far below them).
 *
 * H6 (the yield slice; the worker_threads offload is the L-effort follow-up): the REGISTERED
 * activity must not hold the event loop for the whole burst — `computePolicyRules` yields to the
 * MACROTASK queue between files/path-batches so the runner's heartbeat timers can fire. The pure
 * sync `computePolicyChain` stays for the byte-parity oracle.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  computePolicyChain,
  computePolicyRules,
  MAX_CHANGED_PATHS,
  MAX_TOTAL_RULES,
} from "#backend/activities/compute_policy_rules.activity.js";
import { ComputePolicyRulesInputV1 } from "#contracts/policy_compute.v1.js";

const workspaces: Array<string> = [];
afterAll(() => {
  for (const ws of workspaces) rmSync(ws, { recursive: true, force: true });
});

/** A workspace with `n` small guideline docs, each contributing a handful of list-style rules. */
function workspaceWithDocs(n: number, linesPerDoc = 3): string {
  const ws = mkdtempSync(join(tmpdir(), "m9-policy-"));
  workspaces.push(ws);
  for (let i = 0; i < n; i += 1) {
    const dir = join(ws, "docs", `area${i}`);
    mkdirSync(dir, { recursive: true });
    const lines = ["# Conventions", "", "## Rules", ""];
    for (let j = 0; j < linesPerDoc; j += 1) {
      lines.push(`- Always do the thing number ${j} in area ${i}.`);
    }
    writeFileSync(join(dir, "CLAUDE.md"), lines.join("\n"), "utf-8");
  }
  return ws;
}

function inputFor(ws: string, changedPaths: ReadonlyArray<string>): ComputePolicyRulesInputV1 {
  return ComputePolicyRulesInputV1.parse({
    schema_version: 1,
    workspace_path: ws,
    custom_patterns: [],
    knowledge_enabled: true,
    changed_paths: [...changedPaths],
  });
}

describe("computePolicyChain — M9 caps", () => {
  it("caps changed_paths at MAX_CHANGED_PATHS (first-N, deterministic) and flags truncated", () => {
    const ws = workspaceWithDocs(1);
    const paths = Array.from({ length: MAX_CHANGED_PATHS + 25 }, (_, i) => `src/f${i}.ts`);
    const out = computePolicyChain(inputFor(ws, paths));
    expect(Object.keys(out.bundles)).toHaveLength(MAX_CHANGED_PATHS);
    expect(Object.keys(out.bundles)[0]).toBe("src/f0.ts"); // first-N slice, not arbitrary
    expect(out.truncated).toBe(true);
  });

  it("caps total extracted rules at MAX_TOTAL_RULES and flags truncated", () => {
    // ONE doc whose section mints far more rules than the cap (list-style: one rule per line).
    const ws = mkdtempSync(join(tmpdir(), "m9-rules-"));
    workspaces.push(ws);
    const lines = ["# Conventions", "", "## Rules", ""];
    for (let j = 0; j < MAX_TOTAL_RULES + 200; j += 1) {
      lines.push(`- Always handle case number ${j} explicitly.`);
    }
    writeFileSync(join(ws, "CLAUDE.md"), lines.join("\n"), "utf-8");
    const out = computePolicyChain(inputFor(ws, ["src/a.ts"]));
    expect(out.truncated).toBe(true);
  });

  it("stays untruncated (and bundles complete) below both caps", () => {
    const ws = workspaceWithDocs(2);
    const out = computePolicyChain(inputFor(ws, ["src/a.ts", "docs/area0/x.md"]));
    expect(Object.keys(out.bundles).sort()).toEqual(["docs/area0/x.md", "src/a.ts"]);
    expect(out.truncated).toBe(false);
  });
});

describe("computePolicyRules — H6 cooperative yield", () => {
  it("returns the SAME envelope as the sync chain", async () => {
    const ws = workspaceWithDocs(3);
    const input = inputFor(ws, ["src/a.ts", "docs/area1/y.md"]);
    expect(await computePolicyRules(input)).toEqual(computePolicyChain(input));
  });

  it("yields to the MACROTASK queue mid-compute (heartbeat timers can fire during the burst)", async () => {
    const ws = workspaceWithDocs(4); // ≥2 files ⇒ at least one inter-file yield
    const input = inputFor(ws, ["src/a.ts"]);
    const order: Array<string> = [];
    const run = computePolicyRules(input).then(() => {
      order.push("activity_done");
    });
    setImmediate(() => order.push("macrotask_tick"));
    await run;
    // Without a yield the activity settles in the microtask queue BEFORE any macrotask can run.
    expect(order[0]).toBe("macrotask_tick");
  });
});
