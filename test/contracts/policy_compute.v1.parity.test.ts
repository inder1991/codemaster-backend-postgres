import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  ComputePolicyRulesInputV1,
  ComputedPolicyRulesV1,
} from "../../libs/contracts/src/policy_compute.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 / resolved_guidance.v1
// template.
//
// ComputedPolicyRulesV1.bundles embeds the already-ported ResolvedGuidanceBundleV1 (transitively
// DedupedRuleV1 / ExtractedRuleV1). None carries a bare Python float / UUID / datetime, so the
// canonical diff is FULL byte-equality (no nested-column strip — unlike review_findings' `confidence`).
const PY = "contracts.policy_compute.v1";

// sha256-shaped hex strings (exactly 64 chars) for the nested ExtractedRuleV1 hashes.
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// A representative valid nested ExtractedRuleV1 payload (no float / UUID / datetime fields).
const RULE_SECURITY = {
  schema_version: 1,
  rule_id: "sec-src-no-eval-1a2b3c",
  normalized_hash: HASH_A,
  source_file: "src/CLAUDE.md",
  source_file_sha256: HASH_B,
  scope_dir: "src",
  heading_path: ["Security", "Input handling"],
  rule_index: 3,
  title: "No eval()",
  body: "Never call eval() on untrusted input.",
  category: "security",
  intent: "forbid",
  priority: 100,
  oversized_rule_warning: false,
} as const;

// A representative valid DedupedRuleV1 payload (canonical rule + single source).
const DEDUPED = {
  schema_version: 1,
  rule: RULE_SECURITY,
  sources: [RULE_SECURITY],
} as const;

// A representative valid ResolvedGuidanceBundleV1 payload keyed under a changed_path.
const BUNDLE = {
  schema_version: 1,
  changed_path: "src/app.py",
  applicable_rules: [DEDUPED],
  // ASCII-only explanation: the Python oracle's json.dumps defaults to ensure_ascii=True; keep both
  // dumps byte-identical with a plain hyphen rather than an em-dash glyph.
  resolution_explanation: [
    "Applied src/CLAUDE.md (Security > Input handling) - nearest-ancestor; category=security, intent=forbid, priority=100",
  ],
} as const;

describe("ComputePolicyRulesInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = {
      schema_version: 1,
      workspace_path: "/work/clone-abc123",
      custom_patterns: ["docs/**/*.md", "**/RULES.md"],
      knowledge_enabled: true,
      changed_paths: ["src/app.py", "README.md"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputePolicyRulesInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ComputePolicyRulesInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted", async () => {
    const payload = { workspace_path: "/work/clone-xyz" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputePolicyRulesInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(ComputePolicyRulesInputV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    // Defaults: schema_version=1, custom_patterns=[], knowledge_enabled=true, changed_paths=[].
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.custom_patterns).toEqual([]);
    expect(z.knowledge_enabled).toBe(true);
    expect(z.changed_paths).toEqual([]);
  }, 30_000);

  it("forwards knowledge_enabled=false on both sides", async () => {
    const payload = { workspace_path: "/work/clone-off", knowledge_enabled: false };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputePolicyRulesInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ComputePolicyRulesInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts a forward schema_version=2 on both sides (plain int, NOT Literal[1])", async () => {
    const payload = { schema_version: 2, workspace_path: "/work/clone-fwd" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputePolicyRulesInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ComputePolicyRulesInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an empty workspace_path (Field min_length=1 ↔ .min(1))", async () => {
    const bad = { workspace_path: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputePolicyRulesInputV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => ComputePolicyRulesInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (workspace_path)", async () => {
    const bad = { changed_paths: ["src/app.py"] };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputePolicyRulesInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ComputePolicyRulesInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { workspace_path: "/work/clone-abc", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputePolicyRulesInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ComputePolicyRulesInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ComputedPolicyRulesV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (one bundle per changed_path)", async () => {
    const payload = {
      schema_version: 1,
      bundles: {
        "src/app.py": BUNDLE,
        "README.md": { schema_version: 1, changed_path: "README.md", applicable_rules: [], resolution_explanation: [] },
      },
      truncated: false,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputedPolicyRulesV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ComputedPolicyRulesV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted (empty bundles, no-op output)", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputedPolicyRulesV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(ComputedPolicyRulesV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    // Defaults: schema_version=1, bundles={}, truncated=false.
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.bundles).toEqual({});
    expect(z.truncated).toBe(false);
  }, 30_000);

  it("forwards truncated=true on both sides (A-1 hit MAX_GUIDELINE_FILES_PER_REPO)", async () => {
    const payload = { bundles: { "src/app.py": BUNDLE }, truncated: true };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputedPolicyRulesV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ComputedPolicyRulesV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts a forward schema_version=2 on both sides (plain int, NOT Literal[1])", async () => {
    const payload = { schema_version: 2, bundles: {} };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputedPolicyRulesV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ComputedPolicyRulesV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an invalid nested bundle (changed_path over max_length=500 propagates)", async () => {
    const bad = {
      bundles: { "src/app.py": { changed_path: "x".repeat(501) } },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputedPolicyRulesV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError on nested model
    expect(() => ComputedPolicyRulesV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested bundle (missing required changed_path propagates)", async () => {
    const bad = {
      bundles: { "src/app.py": { applicable_rules: [DEDUPED] } },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputedPolicyRulesV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ComputedPolicyRulesV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { bundles: {}, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ComputedPolicyRulesV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ComputedPolicyRulesV1.parse(bad)).toThrow();
  }, 30_000);
});
