import { rmSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import {
  pyComputePolicyRules,
  shutdownPolicyComputeRef,
  type ComputeRequest,
} from "./policy_compute_oracle.js";
import { computePolicyChain } from "#backend/activities/compute_policy_rules.activity.js";
import { ComputePolicyRulesInputV1 } from "#contracts/policy_compute.v1.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// compute_policy_rules chain parity: prove the TS port of the frozen Python A-1 → A-2 → A-3 chain is
// byte-equal to the source-of-truth (vendor/codemaster-py/codemaster/activities/compute_policy_rules.py
// + discover_repo_docs.py::discover_guideline_files + policy/scope_resolver.py::resolve_guidance).
//
// The Python driver materializes a FIXTURE workspace on disk, runs the REAL frozen activity coroutine
// over it, and returns the resulting ComputedPolicyRulesV1 PLUS the abs temp-dir path. The TS side then
// runs `computePolicyChain` over the SAME on-disk workspace and asserts the canonicalized envelopes
// match byte-for-byte. ResolvedGuidanceBundleV1 (transitively ExtractedRuleV1) carries NO bare float /
// UUID / datetime field, so the generic canonicalizer accepts every field.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// Temp workspaces the Python driver created; cleaned up after the suite.
const createdWorkspaces: Array<string> = [];

afterAll(() => {
  shutdownPolicyComputeRef();
  for (const ws of createdWorkspaces) {
    rmSync(ws, { recursive: true, force: true });
  }
});

/** Run BOTH impls over the same materialized workspace; return the two canonicalized envelopes. */
async function bothImpls(req: ComputeRequest): Promise<{ py: string; ts: string; workspace: string }> {
  const { result, workspace } = await pyComputePolicyRules(req);
  createdWorkspaces.push(workspace);
  // Build the typed input the activity takes, pointing at the SAME on-disk workspace the driver wrote.
  const input = ComputePolicyRulesInputV1.parse({
    schema_version: 1,
    workspace_path: workspace,
    custom_patterns: [...(req.custom_patterns ?? [])],
    knowledge_enabled: req.knowledge_enabled ?? true,
    changed_paths: [...req.changed_paths],
  });
  const ts = computePolicyChain(input);
  return {
    py: canonicalize(result),
    ts: canonicalize(ts as unknown),
    workspace,
  };
}

const CLAUDE_ROOT = `# Conventions

## Security

- Use bcrypt for password hashing
- Never log credentials

## Style

- Prefer snake_case for identifiers
`;

const CLAUDE_NESTED = `# Payments rules

## Security

- Validate all monetary inputs

## Architecture

- Isolate the gateway adapter at the boundary
`;

const AGENTS_ROOT = `# Agent guidance

- Always cite evidence for findings
`;

const DOCS_CONVENTIONS = `# Naming conventions

- Use kebab-case for file names
`;

describe("compute_policy_rules chain parity (Pydantic ↔ TS)", () => {
  it("discovery + extraction + per-path bundles byte-match the frozen Python", async () => {
    const req: ComputeRequest = {
      files: [
        { path: "CLAUDE.md", content: CLAUDE_ROOT },
        { path: "AGENTS.md", content: AGENTS_ROOT },
        { path: "services/payments/CLAUDE.md", content: CLAUDE_NESTED },
        { path: "docs/conventions/naming.md", content: DOCS_CONVENTIONS },
        // A non-matching file that must NOT enter the result set.
        { path: "src/app.py", content: "print('hi')\n" },
      ],
      changed_paths: [
        "services/payments/gateway.py", // nearest-ancestor nested rules + root rules
        "src/app.py", // root-only rules
        "docs/conventions/naming.md", // a docs path
      ],
    };
    const { py, ts } = await bothImpls(req);
    expect(ts).toBe(py);
  }, 30_000);

  it("custom-pattern match pulls in a non-default policy file", async () => {
    const req: ComputeRequest = {
      files: [
        { path: "CLAUDE.md", content: CLAUDE_ROOT },
        // Matched ONLY by the custom pattern below (not any default pattern).
        { path: "docs/team/playbook.md", content: "# Team\n\n- Review within one business day\n" },
      ],
      custom_patterns: ["docs/team/*.md"],
      changed_paths: ["docs/team/playbook.md", "anything.py"],
    };
    const { py, ts } = await bothImpls(req);
    expect(ts).toBe(py);
  }, 30_000);

  it("knowledge_enabled=false short-circuits to empty bundles (no walk)", async () => {
    const req: ComputeRequest = {
      files: [
        // These WOULD match if the walk ran — the short-circuit must skip them entirely.
        { path: "CLAUDE.md", content: CLAUDE_ROOT },
        { path: "services/payments/CLAUDE.md", content: CLAUDE_NESTED },
      ],
      knowledge_enabled: false,
      changed_paths: ["services/payments/gateway.py", "src/app.py"],
    };
    const { py, ts } = await bothImpls(req);
    expect(ts).toBe(py);
    // Both impls must return empty bundles + truncated=false.
    const parsed = JSON.parse(ts) as { bundles: Record<string, unknown>; truncated: boolean };
    expect(Object.keys(parsed.bundles)).toHaveLength(0);
    expect(parsed.truncated).toBe(false);
  }, 30_000);

  it("file cap → truncated=true with deterministic survivor ordering", async () => {
    // 201 root CLAUDE-style files at distinct paths all match the default "CLAUDE.md" basename pattern;
    // the cap (MAX_GUIDELINE_FILES_PER_REPO=200) drops the lexicographically-last candidate. Files live
    // at dNNN/CLAUDE.md so the basename pattern matches every one and the sort order is well-defined.
    const files = Array.from({ length: 201 }, (_unused, idx) => {
      const dir = String(idx).padStart(3, "0");
      return { path: `d${dir}/CLAUDE.md`, content: `# D${dir}\n\n- Rule for ${dir}\n` };
    });
    const req: ComputeRequest = {
      files,
      changed_paths: ["d000/x.py", "d200/x.py"], // the kept first dir + the dropped last dir
    };
    const { py, ts } = await bothImpls(req);
    expect(ts).toBe(py);
    const parsed = JSON.parse(ts) as { truncated: boolean };
    expect(parsed.truncated).toBe(true);
  }, 60_000);

  it("changed_path with no applicable rules → empty bundle (present, zero rules)", async () => {
    const req: ComputeRequest = {
      files: [
        // Rules scoped to services/payments only; a root-disjoint changed path sees nothing here…
        { path: "services/payments/CLAUDE.md", content: CLAUDE_NESTED },
      ],
      changed_paths: ["frontend/app.tsx"], // disjoint subtree → no nested rules apply (no root file)
    };
    const { py, ts } = await bothImpls(req);
    expect(ts).toBe(py);
    const parsed = JSON.parse(ts) as {
      bundles: Record<string, { applicable_rules: Array<unknown> }>;
    };
    // The bundle is PRESENT for the changed path, but carries zero applicable rules.
    expect(Object.keys(parsed.bundles)).toEqual(["frontend/app.tsx"]);
    expect(parsed.bundles["frontend/app.tsx"]!.applicable_rules).toHaveLength(0);
  }, 30_000);

  it("symlink escaping the workspace is rejected; in-workspace symlink is kept", async () => {
    const req: ComputeRequest = {
      files: [
        { path: "CLAUDE.md", content: CLAUDE_ROOT },
        // A real in-workspace target the symlink will point at.
        { path: "real/STANDARDS.md", content: "# Standards\n\n- Keep functions small\n" },
      ],
      symlinks: [
        // Escapes the workspace → MUST be rejected by the realpath-containment guard.
        { path: "ESCAPE.md", target: "/etc/hosts" },
        // Resolves INSIDE the workspace → kept (matches the STANDARDS.md default basename pattern).
        { path: "AGENTS.md", target: "real/STANDARDS.md" },
      ],
      changed_paths: ["anything.py"],
    };
    const { py, ts } = await bothImpls(req);
    expect(ts).toBe(py);
  }, 30_000);

  it("fnmatch edge patterns (?, [seq], [!seq]) match identically to Python fnmatch", async () => {
    const req: ComputeRequest = {
      files: [
        { path: "docs/policy/a1.md", content: "# A1\n\n- rule a1\n" }, // matches docs/policy/?1.md
        { path: "docs/policy/zz.md", content: "# ZZ\n\n- rule zz\n" }, // matches [a-z][a-z] basename glob
        { path: "docs/policy/9x.md", content: "# 9X\n\n- rule 9x\n" }, // excluded by [!0-9] class
        { path: "docs/policy/keep.md", content: "# KEEP\n\n- rule keep\n" }, // default docs/policy/*.md
      ],
      custom_patterns: [
        "docs/policy/?1.md", // '?' single-char wildcard
        "[a-z][a-z].md", // basename character-class range
        "[!0-9]?.md", // basename negated class — must NOT match 9x.md
      ],
      changed_paths: ["docs/policy/keep.md", "x.py"],
    };
    const { py, ts } = await bothImpls(req);
    expect(ts).toBe(py);
  }, 30_000);

  it("fnmatch leading-']' character classes ([]a], [!]a], []]) match Python re (JS-compat fix)", async () => {
    // Regression guard for the fnmatch bracket divergence the adversarial verifier caught: CPython/POSIX
    // allow a literal ']' as the first class member; JS RegExp reads `[]` as an empty class. The fix
    // escapes a leading ']'. []a] matches ']'|'a'; [!]a] negates; []] matches ']'.
    const req: ComputeRequest = {
      files: [
        { path: "a.md", content: "# A\n\n- rule a\n" }, // matches []a]  (']' or 'a')
        { path: "].md", content: "# RB\n\n- rule rb\n" }, // matches []a] and []]
        { path: "x.md", content: "# X\n\n- rule x\n" }, // matches [!]a]  (not ']'/'a')
      ],
      custom_patterns: ["[]a].md", "[!]a].md", "[]].md"],
      changed_paths: ["a.md", "].md", "x.md"],
    };
    const { py, ts } = await bothImpls(req);
    expect(ts).toBe(py);
  }, 30_000);
});
