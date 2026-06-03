import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { AssembledPromptV1 } from "#contracts/assembled_prompt.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `AssembledPromptV1(**payload).model_dump(mode="json")`) and through Zod (`AssembledPromptV1.parse(payload)`),
// then diff canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 /
// resolved_guidance.v1 / knowledge_chunks.v1 template.
//
// AssembledPromptV1 embeds two already-ported sibling contracts:
//  - DedupedRuleV1 (policy_blocks / dropped_policy_rules / forced_rules) — NO bare float / UUID /
//    datetime inside, so those tuples byte-round-trip fully.
//  - ScoredKnowledgeChunkV1 (knowledge_blocks) — carries a BARE float `score` AND a nested
//    KnowledgeChunkV1.age_days bare float. The repo canonicalizer (test/parity/canonical.ts) REJECTS
//    bare floats (Python emits `0.0` / `0.875`; JS emits `0` / `0.875` divergently for integral
//    values), so the `knowledge_blocks[*].score` + `knowledge_blocks[*].chunk.age_days` columns are
//    stripped before the canonical diff, then asserted structurally separately.
const PY = "contracts.assembled_prompt.v1";

type Rec = Record<string, unknown>;

// Lowercase UUIDs — Pydantic dumps UUIDs lowercase, so the nested-chunk payloads must be lowercase for
// a byte-equal canonical compare.
const CID = "00000000-0000-0000-0000-000000000001";
const IID = "00000000-0000-0000-0000-000000000002";
const RID = "00000000-0000-0000-0000-000000000003";

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

// A representative valid DedupedRuleV1 payload (canonical rule + 2 sources). No bare floats.
const DEDUPED = {
  schema_version: 1,
  rule: RULE_SECURITY,
  sources: [RULE_SECURITY, RULE_SECURITY_ANCESTOR],
} as const;

// A representative valid nested KnowledgeChunkV1 payload (carries the age_days bare float, stripped
// from the canonical diff).
const CHUNK = {
  chunk_id: CID,
  installation_id: IID,
  repo_id: RID,
  relative_path: "docs/adr/0001.md",
  chunk_index: 0,
  body: "We will use Postgres.",
  doc_kind: "adr",
} as const;

// A representative valid ScoredKnowledgeChunkV1 payload (score bare float + nested chunk).
const SCORED = { schema_version: 1, chunk: CHUNK, score: 0.875, stage: "rrf" } as const;

// Strip the bare-float columns that ride inside each knowledge_blocks ScoredKnowledgeChunkV1 entry:
// the top-level `score` and the nested `chunk.age_days`. Both sides run through the identical strip so
// only the byte-round-trippable columns survive into the canonical diff.
function stripScored(scored: unknown): unknown {
  if (scored && typeof scored === "object") {
    const s = { ...(scored as Rec) };
    delete s.score;
    if (s.chunk && typeof s.chunk === "object") {
      const c = { ...(s.chunk as Rec) };
      delete c.age_days;
      s.chunk = c;
    }
    return s;
  }
  return scored;
}

// Re-canonicalize an AssembledPromptV1 object after dropping every nested float column. Only the
// knowledge_blocks tuple carries floats; policy_blocks / dropped_policy_rules / forced_rules
// (DedupedRuleV1) are float-free.
function stripFloats(o: unknown): string {
  const obj = { ...(o as Rec) };
  if (Array.isArray(obj.knowledge_blocks)) obj.knowledge_blocks = obj.knowledge_blocks.map(stripScored);
  return canonicalize(obj);
}

describe("AssembledPromptV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (nested score + age_days floats excepted)", async () => {
    const payload = {
      schema_version: 1,
      policy_blocks: [DEDUPED],
      knowledge_blocks: [SCORED],
      dropped_policy_rules: [DEDUPED],
      dropped_policy_count: 1,
      knowledge_dropped_count: 2,
      forced_include_count: 1,
      forced_rules: [DEDUPED],
      policy_tokens: 1200,
      knowledge_tokens: 800,
      total_tokens: 2000,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AssembledPromptV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = AssembledPromptV1.parse(payload);
    expect(stripFloats(parsed)).toBe(stripFloats(JSON.parse(r.out ?? "{}")));
    // The stripped float column round-trips structurally on the Zod side.
    expect(parsed.knowledge_blocks[0]?.score).toBe(0.875);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted (empty everything)", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "AssembledPromptV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = AssembledPromptV1.parse(payload);
    // No nested floats when knowledge_blocks is empty — full byte-equality holds.
    expect(canonicalize(parsed)).toBe(r.out);
    // Defaults: schema_version=1, all tuples [], all counters 0.
    expect(parsed.schema_version).toBe(1);
    expect(parsed.policy_blocks).toEqual([]);
    expect(parsed.knowledge_blocks).toEqual([]);
    expect(parsed.dropped_policy_rules).toEqual([]);
    expect(parsed.dropped_policy_count).toBe(0);
    expect(parsed.knowledge_dropped_count).toBe(0);
    expect(parsed.forced_include_count).toBe(0);
    expect(parsed.forced_rules).toEqual([]);
    expect(parsed.policy_tokens).toBe(0);
    expect(parsed.knowledge_tokens).toBe(0);
    expect(parsed.total_tokens).toBe(0);
  }, 30_000);

  it("accepts a forward schema_version (int default, NOT z.literal)", async () => {
    const payload = { schema_version: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: "AssembledPromptV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(AssembledPromptV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a negative dropped_policy_count (ge=0 range guard)", async () => {
    const bad = { dropped_policy_count: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "AssembledPromptV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => AssembledPromptV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a negative forced_include_count (ge=0 range guard)", async () => {
    const bad = { forced_include_count: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "AssembledPromptV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AssembledPromptV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a negative total_tokens (ge=0 range guard)", async () => {
    const bad = { total_tokens: -5 };
    const r = await pyRef({ pyModule: PY, pyCallable: "AssembledPromptV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AssembledPromptV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested policy block (empty sources propagates from DedupedRuleV1)", async () => {
    const bad = { policy_blocks: [{ rule: RULE_SECURITY, sources: [] }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "AssembledPromptV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AssembledPromptV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested knowledge block (bad stage propagates from ScoredKnowledgeChunkV1)", async () => {
    const bad = { knowledge_blocks: [{ chunk: CHUNK, score: 0.5, stage: "bogus_stage" }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "AssembledPromptV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AssembledPromptV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { total_tokens: 0, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "AssembledPromptV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AssembledPromptV1.parse(bad)).toThrow();
  }, 30_000);
});
