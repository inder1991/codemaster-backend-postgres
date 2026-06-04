import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { load as yamlLoad } from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import { pyRef, shutdownRef } from "./oracle.js";
import {
  pyExtractRules,
  shutdownPolicyRef,
  type GuidelineFileInput,
  type RuleDict,
} from "./policy_oracle.js";
import { inferCategory, inferIntent } from "#backend/policy/rule_classifier.js";
import { extractRules } from "#backend/policy/rule_extractor.js";
import { GuidelineFileV1 } from "#contracts/guideline_files.v1.js";

afterAll(() => {
  shutdownRef();
  shutdownPolicyRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Policy-subsystem parity: prove the TS port of the frozen Python policy heuristics is byte-equal to
// the source-of-truth (vendor/codemaster-py/codemaster/policy/{rule_classifier,rule_extractor}.py).
//
//  - Classifier (infer_category / infer_intent): MODULE-LEVEL pure functions returning bare enum
//    strings → the GENERIC oracle (pyRef) suffices. Driven over the committed 30-fixture ground-
//    truth corpus AND a hand-written marker / edge-case set.
//  - extract_rules: takes a CONSTRUCTED GuidelineFileV1 (Pydantic instance, not a kwargs dict) →
//    DEDICATED driver (run_policy_ref.py + policy_oracle.ts), mirroring the redact subsystem.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/test/parity
const REPO_ROOT = join(HERE, "..", "..");
const CLASSIFIER_PY = "codemaster.policy.rule_classifier";

// ─── Classifier corpus ──────────────────────────────────────────────────────────────────────────

type ClassifierFixture = {
  readonly id: string;
  readonly heading: string;
  readonly body: string;
  readonly expected_category: string;
  readonly expected_intent: string;
};

function loadClassifierCorpus(): Array<ClassifierFixture> {
  // The committed ground-truth corpus pinning infer_category(heading, body) + infer_intent(body).
  const path = join(
    REPO_ROOT,
    "vendor",
    "codemaster-py",
    "tests",
    "corpora",
    "policy_engine_classifier",
    "fixtures.yaml",
  );
  const doc = yamlLoad(readFileSync(path, "utf8")) as { fixtures: Array<ClassifierFixture> };
  return doc.fixtures;
}

const CLASSIFIER_CORPUS = loadClassifierCorpus();

// Hand-written cases beyond the corpus: inline-marker overrides (valid + invalid-falls-through),
// ordering (forbid-before-require), substring matching (vulnerab), empty body, default fallbacks,
// and case-insensitive markers. These exercise branches the 30-fixture corpus does not.
const EXTRA_CLASSIFIER_CASES: ReadonlyArray<{ heading: string; body: string }> = [
  // Inline category marker wins over heuristic.
  { heading: "Naming", body: "Use snake_case <!-- codemaster:category=security -->" },
  // Inline intent marker wins over heuristic.
  { heading: "Style", body: "Prefer composition <!-- codemaster:intent=forbid -->" },
  // Unknown marker value falls through to heuristic (category).
  { heading: "Auth", body: "always validate <!-- codemaster:category=bogus -->" },
  // Unknown marker value falls through to heuristic (intent).
  { heading: "Auth", body: "you must always validate <!-- codemaster:intent=bogus -->" },
  // Case-insensitive marker matching + whitespace tolerance.
  { heading: "x", body: "<!--   CODEMASTER:Category = Performance   -->" },
  // Substring (not word-boundary) match: 'vulnerab' catches 'vulnerability'.
  { heading: "Risks", body: "Address every vulnerability promptly" },
  // forbid-before-require ordering: 'must not' must beat 'must'.
  { heading: "Limits", body: "You must not exceed the cap" },
  // 'do not' → forbid.
  { heading: "Secrets", body: "Do not commit credentials" },
  // Empty heading + empty-ish body → defaults (style / recommend).
  { heading: "", body: "x" },
  // Only first marker of a kind honored when multiple present.
  {
    heading: "h",
    body: "<!-- codemaster:intent=require --> text <!-- codemaster:intent=forbid -->",
  },
  // Heading-driven category (keyword in heading, not body).
  { heading: "Performance budget", body: "Stay under the line" },
  // Body-only category beyond 500 chars is NOT searched (keyword past slice → default style).
  { heading: "h", body: "a".repeat(520) + " security" },
];

describe("policy rule_classifier parity (Pydantic ↔ TS)", () => {
  it.each(CLASSIFIER_CORPUS)(
    "infer_category matches the frozen Python for $id",
    async (fx) => {
      const r = await pyRef({
        pyModule: CLASSIFIER_PY,
        pyCallable: "infer_category",
        kwargs: { heading: fx.heading, body: fx.body },
      });
      expect(r.ok, r.err).toBe(true);
      const ts = inferCategory({ heading: fx.heading, body: fx.body });
      // Byte-parity against the live Python AND against the committed ground-truth.
      expect(canonicalize(ts)).toBe(r.out);
      expect(ts).toBe(fx.expected_category);
    },
    30_000,
  );

  it.each(CLASSIFIER_CORPUS)(
    "infer_intent matches the frozen Python for $id",
    async (fx) => {
      const r = await pyRef({
        pyModule: CLASSIFIER_PY,
        pyCallable: "infer_intent",
        kwargs: { body: fx.body },
      });
      expect(r.ok, r.err).toBe(true);
      const ts = inferIntent({ body: fx.body });
      expect(canonicalize(ts)).toBe(r.out);
      expect(ts).toBe(fx.expected_intent);
    },
    30_000,
  );

  it.each(EXTRA_CLASSIFIER_CASES)(
    "infer_category matches the frozen Python for edge case #%#",
    async (c) => {
      const r = await pyRef({
        pyModule: CLASSIFIER_PY,
        pyCallable: "infer_category",
        kwargs: { heading: c.heading, body: c.body },
      });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(inferCategory(c))).toBe(r.out);
    },
    30_000,
  );

  it.each(EXTRA_CLASSIFIER_CASES)(
    "infer_intent matches the frozen Python for edge case #%#",
    async (c) => {
      const r = await pyRef({
        pyModule: CLASSIFIER_PY,
        pyCallable: "infer_intent",
        kwargs: { body: c.body },
      });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(inferIntent({ body: c.body }))).toBe(r.out);
    },
    30_000,
  );
});

// ─── extract_rules ──────────────────────────────────────────────────────────────────────────────

function buildFile(args: {
  body: string;
  relative_path?: string;
  scope_dir?: string;
  source_pattern?: string;
}): GuidelineFileInput {
  const body = args.body;
  return {
    relative_path: args.relative_path ?? "CLAUDE.md",
    scope_dir: args.scope_dir ?? "",
    source_pattern: args.source_pattern ?? "CLAUDE.md",
    body,
    content_sha256: createHash("sha256").update(body, "utf8").digest("hex"),
  };
}

// Representative inputs exercising: empty/whitespace, headings-only, list-vs-paragraph split,
// per-section category inference, heading-path depth truncation, multi-line list continuations
// (R-33), pre-heading content, derived titles (no heading), oversized truncation, nested scope_dir,
// and inline markers flowing through the classifier.
const EXTRACT_CASES: ReadonlyArray<{ name: string; file: GuidelineFileInput }> = [
  { name: "whitespace-only body → no rules", file: buildFile({ body: " " }) },
  { name: "headings only → no rules", file: buildFile({ body: "# H1\n## H2\n### H3\n" }) },
  {
    name: "3 sections × 3 list items",
    file: buildFile({
      body: `
# Conventions

## Security

- Use bcrypt for password hashing
- Never log credentials
- Always validate input

## Testing

- Every public function needs a test
- Use pytest for unit tests
- Coverage must exceed 80%

## Architecture

- Prefer hexagonal architecture
- Isolate adapters at the boundary
- Keep modules focused
`,
    }),
  },
  {
    name: "paragraph-style section (no list markers)",
    file: buildFile({
      body: `# Overview

This is the first paragraph that must be validated carefully.

This is a second paragraph; do not skip it.
`,
    }),
  },
  {
    name: "deep heading nesting truncated to depth 3",
    file: buildFile({
      body: `# A

## B

### C

#### D

- A rule under H4 — heading_path truncates to (A, B, C)
`,
    }),
  },
  {
    name: "multi-line list-item continuation (R-33 CommonMark)",
    file: buildFile({
      body: `# Rules

- First item line
  continues here under the marker
- Second item
    deeper continuation
`,
    }),
  },
  {
    name: "pre-heading content yields empty heading_path + derived title",
    file: buildFile({
      body: `Some leading prose before any heading describes the overall intent of the file at length.

# Later heading

- A list rule here
`,
    }),
  },
  {
    name: "ordered-list markers + mixed markdown formatting",
    file: buildFile({
      body: `# Style

1. **Always** use \`snake_case\` for identifiers
2. Prefer absolute imports over relative imports
`,
    }),
  },
  {
    name: "nested scope_dir flows into rule_id",
    file: buildFile({
      body: `# Payments

- Use bcrypt for password hashing
`,
      relative_path: "services/payments/CLAUDE.md",
      scope_dir: "services/payments",
    }),
  },
  {
    name: "oversized body truncated + flagged",
    file: buildFile({
      body: "# Big\n\n- " + "x".repeat(5000),
    }),
  },
  {
    name: "inline-marker overrides flow through classifier",
    file: buildFile({
      body: `# Misc

- Prefer composition <!-- codemaster:category=security --> <!-- codemaster:intent=forbid -->
`,
    }),
  },
];

/** Canonicalize a list of rule dicts for byte-comparison (key-sorted, order-preserving). */
function canonRules(rules: ReadonlyArray<RuleDict>): string {
  return canonicalize([...rules]);
}

describe("policy rule_extractor parity (Pydantic ↔ TS)", () => {
  it.each(EXTRACT_CASES)("extract_rules byte-matches the frozen Python: $name", async (c) => {
    const py = await pyExtractRules(c.file);
    // Parse the input through the contract first — mirrors the driver's `GuidelineFileV1(**dict)`,
    // adding the schema_version default before extract_rules consumes it.
    const ts = extractRules(GuidelineFileV1.parse(c.file));
    // priority is an int (DEFAULT_PRIORITY_BY_CATEGORY) — no bare floats, so the generic
    // canonicalizer accepts every field. Compare the full rule objects byte-for-byte, in order.
    expect(canonRules(ts as unknown as Array<RuleDict>)).toBe(canonRules(py));
  }, 30_000);

  it("emits zero rules for empty extractable content (both impls)", async () => {
    const file = buildFile({ body: " " });
    const py = await pyExtractRules(file);
    const ts = extractRules(GuidelineFileV1.parse(file));
    expect(py).toHaveLength(0);
    expect(ts).toHaveLength(0);
  }, 30_000);
});
