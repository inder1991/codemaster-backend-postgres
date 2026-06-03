import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  DedupedRuleV1,
  ResolvedGuidanceBundleV1,
} from "../../libs/contracts/src/resolved_guidance.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 / aggregated_findings.v1
// template.
//
// resolved_guidance embeds the already-ported ExtractedRuleV1 / DedupedRuleV1 contracts. Neither
// carries a bare Python float / UUID / datetime, so the canonical diff is FULL byte-equality (no
// nested-column strip — unlike review_findings' `confidence` float).
const PY = "contracts.resolved_guidance.v1";

// sha256-shaped hex strings (exactly 64 chars) for normalized_hash + source_file_sha256.
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

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

// A second nested rule (different normalized_hash) — used as an extra `sources` entry.
const RULE_SECURITY_ANCESTOR = {
  schema_version: 1,
  rule_id: "sec-root-no-eval-9z8y7x",
  normalized_hash: HASH_C,
  source_file: "CLAUDE.md",
  source_file_sha256: HASH_B,
  scope_dir: "",
  heading_path: ["Security"],
  rule_index: 0,
  title: "No eval()",
  body: "Never call eval() on untrusted input.",
  category: "security",
  intent: "forbid",
  priority: 100,
  oversized_rule_warning: false,
} as const;

// A representative valid DedupedRuleV1 payload (canonical rule + 2 sources).
const DEDUPED = {
  schema_version: 1,
  rule: RULE_SECURITY,
  sources: [RULE_SECURITY, RULE_SECURITY_ANCESTOR],
} as const;

describe("DedupedRuleV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (canonical rule + 2 sources)", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupedRuleV1", kwargs: DEDUPED });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DedupedRuleV1.parse(DEDUPED))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted, single source", async () => {
    const payload = { rule: RULE_SECURITY, sources: [RULE_SECURITY] };
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupedRuleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(DedupedRuleV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as { schema_version: number }).schema_version).toBe(1);
  }, 30_000);

  it("accepts a forward schema_version=2 on both sides (plain int, NOT Literal[1])", async () => {
    const payload = { schema_version: 2, rule: RULE_SECURITY, sources: [RULE_SECURITY] };
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupedRuleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DedupedRuleV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an empty sources tuple (Field min_length=1 ↔ .min(1))", async () => {
    const bad = { rule: RULE_SECURITY, sources: [] };
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupedRuleV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => DedupedRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (rule)", async () => {
    const bad = { sources: [RULE_SECURITY] };
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupedRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DedupedRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested rule (category outside enum propagates)", async () => {
    const bad = { rule: { ...RULE_SECURITY, category: "bogus" }, sources: [RULE_SECURITY] };
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupedRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DedupedRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested source (normalized_hash wrong length propagates)", async () => {
    const bad = {
      rule: RULE_SECURITY,
      sources: [{ ...RULE_SECURITY, normalized_hash: "a".repeat(63) }],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupedRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DedupedRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { rule: RULE_SECURITY, sources: [RULE_SECURITY], bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupedRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DedupedRuleV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ResolvedGuidanceBundleV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = {
      schema_version: 1,
      changed_path: "src/app.py",
      applicable_rules: [DEDUPED],
      // ASCII-only explanation string: the Python oracle's json.dumps defaults to ensure_ascii=True
      // (escaping non-ASCII like the em-dash to —) while JS JSON.stringify keeps the literal
      // glyph — a serialization-escaping artifact, NOT a contract divergence. The contract places no
      // constraint on this free-form str's content, so use a hyphen to keep both dumps byte-identical.
      resolution_explanation: [
        "Applied src/CLAUDE.md (Security > Input handling) - nearest-ancestor; category=security, intent=forbid, priority=100",
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ResolvedGuidanceBundleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ResolvedGuidanceBundleV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted (empty rules + explanation)", async () => {
    const payload = { changed_path: "README.md" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ResolvedGuidanceBundleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(ResolvedGuidanceBundleV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    // Defaults: schema_version=1, applicable_rules=[], resolution_explanation=[].
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.applicable_rules).toEqual([]);
    expect(z.resolution_explanation).toEqual([]);
  }, 30_000);

  it("accepts a forward schema_version (int default, NOT z.literal)", async () => {
    const payload = { schema_version: 2, changed_path: "src/app.py" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ResolvedGuidanceBundleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ResolvedGuidanceBundleV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an empty changed_path (Field min_length=1 ↔ .min(1))", async () => {
    const bad = { changed_path: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ResolvedGuidanceBundleV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => ResolvedGuidanceBundleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a changed_path over the bound (max_length=500)", async () => {
    const bad = { changed_path: "x".repeat(501) };
    const r = await pyRef({ pyModule: PY, pyCallable: "ResolvedGuidanceBundleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ResolvedGuidanceBundleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (changed_path)", async () => {
    const bad = { applicable_rules: [DEDUPED] };
    const r = await pyRef({ pyModule: PY, pyCallable: "ResolvedGuidanceBundleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ResolvedGuidanceBundleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested DedupedRuleV1 (empty sources propagates)", async () => {
    const bad = {
      changed_path: "src/app.py",
      applicable_rules: [{ rule: RULE_SECURITY, sources: [] }],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ResolvedGuidanceBundleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ResolvedGuidanceBundleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { changed_path: "src/app.py", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ResolvedGuidanceBundleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ResolvedGuidanceBundleV1.parse(bad)).toThrow();
  }, 30_000);
});
