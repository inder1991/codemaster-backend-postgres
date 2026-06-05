// rule_id — 1:1 port of the frozen Python codemaster/policy/rule_id.py
// (Sprint 25 / A-2 stable rule_id + normalized_hash).
//
// Two pure deterministic helpers:
//   - deriveRuleId(...)        → `<CAT>-<scope-slug>-<title-slug>-<short-hash>`
//   - deriveNormalizedHash(...)→ sha256 over normalized (title + body) for dedup-equivalence.
//
// rule_extractor depends on both. Kept in its own module so it is testable in isolation and reused
// across consumers (matches the source layout).
//
// Byte-parity notes (vs the frozen Python re/hashlib):
//   - hashlib.sha256(s.encode("utf-8")).hexdigest() → createHash("sha256").update(s,"utf8").digest("hex").
//     `createHash` is a deterministic hash (NOT randomness) — outside the clock/random gate's scope.
//   - The slug/markdown-strip regexes mirror the Python `re.compile` patterns verbatim. Python flags
//     map: re.MULTILINE → /m, re.DOTALL → /s. `re.sub` global replace → /g on every pattern.
//   - The punctuation-collapse class `[.,;:'\"!?\\-‐‑‒–—―]+` carries the same Unicode dash variants
//     (U+2010..U+2015) verbatim; JS character classes treat them identically.
//   - `_slugify` truncates to max_len with `s.slice(0, max_len)` then `.rstrip("-")` →
//     trailing-hyphen strip via a right-anchored replace. Python `str.strip("-")` strips BOTH ends;
//     `_NON_SLUG_CHARS_RE`/`_MULTI_HYPHEN_RE` already collapse runs, so only end-trim remains.
//   - `.lower()` → `.toLowerCase()` (ASCII-equivalent for the slug/normalize char domain).

import { createHash } from "node:crypto";

import { type RuleCategory } from "#contracts/extracted_rules.v1.js";

// Category → 3-char uppercase shortcode for the rule_id prefix.
const CATEGORY_SHORTCODES: Readonly<Record<RuleCategory, string>> = {
  security: "SEC",
  architecture: "ARC",
  testing: "TES",
  performance: "PER",
  style: "STY",
};

// Length cap on each slug component.
const MAX_SLUG_LEN = 40;

// Length of the short-hash suffix. 8 hex chars = 32 bits of entropy.
const SHORT_HASH_LEN = 8;

// Anything not lowercase-alphanumeric or hyphen → replaced with a hyphen.
const NON_SLUG_CHARS_RE = /[^a-z0-9-]+/g;

// Run of multiple hyphens → single hyphen.
const MULTI_HYPHEN_RE = /-+/g;

// Markdown formatting patterns stripped during normalization. ORDER matters: longer / more-specific
// patterns first (mirrors the Python tuple order exactly). `$1` reproduces Python's `\1` backref.
const MARKDOWN_STRIP_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Code fences (triple-backtick); strip fence markers, keep the body. Non-greedy.
  [/```[a-zA-Z0-9]*\n/gm, ""],
  [/```/gm, ""],
  // Inline code spans: `code` → code
  [/`([^`]*)`/g, "$1"],
  // Bold / italic: **x**, *x*, __x__, _x_ → x
  [/\*\*([^*]+)\*\*/g, "$1"],
  [/\*([^*]+)\*/g, "$1"],
  [/__([^_]+)__/g, "$1"],
  [/_([^_]+)_/g, "$1"],
  // Links: [text](url) → text
  [/\[([^\]]+)\]\([^)]+\)/g, "$1"],
  // Heading prefix: # foo → foo
  [/^#+\s*/gm, ""],
  // List markers: -, * at start of line
  [/^\s*[-*]\s+/gm, ""],
  // Ordered list markers: 1. at start of line
  [/^\s*\d+\.\s+/gm, ""],
  // HTML-style comments: <!-- foo --> (DOTALL so it spans newlines).
  [/<!--[\s\S]*?-->/g, ""],
  // Generic punctuation collapsed to a single space — periods, commas, colons, semicolons, quotes,
  // exclamation, question mark, and the ASCII + Unicode dash variants (U+2010..U+2015).
  [/[.,;:'"!?\-‐‑‒–—―]+/g, " "],
];

// Whitespace collapse — \s in JS matches the same ASCII whitespace class Python's `\s` does for the
// in-domain inputs. Global so every run collapses.
const WHITESPACE_RE = /\s+/g;

/** sha256 hex digest over the UTF-8 bytes of `s`. Deterministic — no randomness seam needed. */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Convert arbitrary text to a hyphen-slug. Lowercase → non-alphanumeric → hyphen → collapse runs →
 * strip ends → truncate. Returns `"unnamed"` for empty inputs.
 */
function slugify(text: string, maxLen: number = MAX_SLUG_LEN): string {
  if (!text) {
    return "unnamed";
  }
  let s = text.toLowerCase();
  s = s.replace(NON_SLUG_CHARS_RE, "-");
  s = s.replace(MULTI_HYPHEN_RE, "-");
  s = stripHyphens(s); // Python str.strip("-") — both ends.
  if (!s) {
    return "unnamed";
  }
  // Truncate then right-strip a trailing hyphen the cut may have left (Python `[:max].rstrip("-")`).
  return rstripHyphens(s.slice(0, maxLen));
}

/** Strip leading + trailing '-' (Python str.strip("-")). */
function stripHyphens(s: string): string {
  return s.replace(/^-+/, "").replace(/-+$/, "");
}

/** Strip trailing '-' only (Python str.rstrip("-")). */
function rstripHyphens(s: string): string {
  return s.replace(/-+$/, "");
}

/**
 * Produce a stable, human-readable rule_id of the form `<CAT>-<scope-slug>-<title-slug>-<short-hash>`.
 *
 * Stability: same inputs → byte-identical rule_id across runs. Hash material includes
 * `normalizedHash` so two rules with identical (source_file, heading_path, rule_index) but different
 * bodies produce different rule_ids (T-14).
 */
export function deriveRuleId(args: {
  category: RuleCategory;
  scope_dir: string;
  title: string;
  source_file: string;
  heading_path: ReadonlyArray<string>;
  rule_index: number;
  normalized_hash?: string;
}): string {
  const { category, scope_dir, title, source_file, heading_path, rule_index } = args;
  const normalizedHash = args.normalized_hash ?? "";

  // eslint-disable-next-line security/detect-object-injection -- read-only lookup in a frozen const map keyed by the RuleCategory enum (5 fixed values), not user input
  const cat = CATEGORY_SHORTCODES[category];
  // Python: `_slugify(scope_dir.replace("/", "-")) if scope_dir else "root"`. Note Python
  // `str.replace("/", "-")` replaces ALL occurrences → JS `replaceAll`.
  const scopeSlug = scope_dir ? slugify(scope_dir.replaceAll("/", "-")) : "root";
  const titleSlug = slugify(title);
  // Stable hash material: source_file + "/"-joined heading_path + rule_index + normalized_hash.
  const hashMaterial = `${source_file}\n${heading_path.join("/")}\n${rule_index}\n${normalizedHash}`;
  const shortHash = sha256Hex(hashMaterial).slice(0, SHORT_HASH_LEN);
  return `${cat}-${scopeSlug}-${titleSlug}-${shortHash}`;
}

/**
 * Normalize text for dedup-hash comparison. Lowercases, strips markdown formatting, collapses
 * whitespace, strips most punctuation. Two semantically-equivalent rules differing only in
 * formatting produce identical normalized text.
 */
function normalizeForHash(text: string): string {
  let s = text.toLowerCase();
  for (const [pattern, replacement] of MARKDOWN_STRIP_PATTERNS) {
    s = s.replace(pattern, replacement);
  }
  // Collapse all whitespace to single space, then strip ends (Python `.strip()`).
  s = s.replace(WHITESPACE_RE, " ");
  return s.trim();
}

/**
 * Produce a sha256 hash of normalized (title + body) for dedup-equivalence detection. Hash material
 * is `normalize(title) + "\n" + normalize(body)`.
 */
export function deriveNormalizedHash(args: { title: string; body: string }): string {
  const normalizedTitle = normalizeForHash(args.title);
  const normalizedBody = normalizeForHash(args.body);
  const material = `${normalizedTitle}\n${normalizedBody}`;
  return sha256Hex(material);
}
