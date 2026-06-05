// rule_classifier — 1:1 port of the frozen Python
// codemaster/policy/rule_classifier.py (Sprint 25 / A-2 category + intent inference).
//
// Pure deterministic helpers that classify a rule's category and intent from its heading + body
// text. Used by rule_extractor to populate ExtractedRuleV1.{category, intent}.
//
// Two layers per the A-2 plan body:
//   1. Heuristic keyword matching — first-match-wins against pre-defined keyword tables.
//      Default category is `style`; default intent is `recommend`.
//   2. Inline-marker overrides — HTML-comment markers (`<!-- codemaster:category=security -->` /
//      `<!-- codemaster:intent=require -->`) let the customer override the heuristic explicitly.
//      Markers win over heuristic; unknown values fall back to the heuristic.
//
// Byte-parity notes (vs the frozen Python re module):
//   - Substring containment (`keyword in blob` → `blob.includes(keyword)`) — NOT word-boundary; a
//     partial like "vulnerab" deliberately catches "vulnerable"/"vulnerability".
//   - The search blob is `(heading + " " + body[:500]).lower()` — JS `.toLowerCase()` matches
//     Python `.lower()` for the ASCII keyword set; the 500-char body slice is `body.slice(0, 500)`.
//   - Table ORDER is load-bearing (first-match-wins): forbid before require so "must not" beats
//     "must"; more-specific categories first.
//   - The inline-marker regex mirrors Python verbatim with the IGNORECASE flag; only the FIRST
//     marker of a given kind is honored (Python iterates `finditer` and returns on first match).
//   - Python's logging diagnostic (`_LOG.info(... unknown inline-marker ...)`) is intentionally NOT
//     reproduced: it is a side-effect with no return-value/wire impact, so it does not affect parity.

import { RuleCategory, RuleIntent } from "#contracts/extracted_rules.v1.js";

// Valid category + intent literal values, derived from the contract's enums. Used by inline-marker
// validation (the frozen Python derives these via `get_args(RuleCategory)` / `get_args(RuleIntent)`).
const VALID_CATEGORIES: ReadonlySet<string> = new Set(RuleCategory.options);
const VALID_INTENTS: ReadonlySet<string> = new Set(RuleIntent.options);

// Category keyword table. First category whose keywords match the (heading + first 500 chars of
// body) wins. Order matters: more-specific categories first. No `style` entry — it is the default
// fallback. Keywords matched case-insensitively (substring, not word-boundary).
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [RuleCategory, ReadonlyArray<string>]> = [
  ["security", ["security", "auth", "credential", "secret", "vulnerab", "crypto", "encrypt"]],
  ["architecture", ["architecture", "pattern", "layer", "module", "boundary", "design"]],
  ["testing", ["test", "coverage", "fixture", "assert", "mock"]],
  ["performance", ["performance", "latency", "throughput", "memory", "cpu", "benchmark"]],
];

// Intent keyword table. First intent whose keywords match the (lowercased) body wins. Order matters:
// `forbid` before `require` so "must not" beats "must". No `recommend` entry — default fallback.
const INTENT_KEYWORDS: ReadonlyArray<readonly [RuleIntent, ReadonlyArray<string>]> = [
  ["forbid", ["never", "do not", "must not", "forbid", "prohibit", "don't"]],
  ["require", ["must", "always", "required", "shall"]],
];

// Inline-marker regex. Matches `<!-- codemaster:category=security -->` /
// `<!-- codemaster:intent=require -->`. Whitespace around the value is permitted; value is
// case-insensitive at match time (lowered before lookup). `g` so `matchAll` can find each marker;
// `i` mirrors Python's `re.IGNORECASE`.
const INLINE_MARKER_RE = /<!--\s*codemaster:(category|intent)\s*=\s*([a-zA-Z_]+)\s*-->/gi;

// First 500 chars of body searched for category, matching the program plan spec. Keeps
// classification cheap on unusually long bodies.
const MAX_CATEGORY_SEARCH_CHARS = 500;

/**
 * Find an inline `<!-- codemaster:<kind>=<value> -->` marker. Returns the lowercased value if
 * present, else `null`. Only the FIRST marker of the given kind is honored.
 */
function findInlineMarker(body: string, kind: "category" | "intent"): string | null {
  // `String.prototype.matchAll` clones the regex internally and resets `lastIndex` to 0, so reusing
  // the module-level literal is stateless per call — equivalent to the source module's `finditer`.
  for (const match of body.matchAll(INLINE_MARKER_RE)) {
    const markerKind = match[1]?.toLowerCase();
    const markerValue = match[2]?.toLowerCase();
    if (markerKind === kind && markerValue !== undefined) {
      return markerValue;
    }
  }
  return null;
}

/**
 * Infer the rule's category from heading + body text.
 *
 * Priority:
 *   1. Inline marker `<!-- codemaster:category=X -->` in body (unknown values fall through).
 *   2. Keyword heuristic against (heading + first 500 chars of body), first match wins.
 *   3. Default `style`.
 */
export function inferCategory(args: { heading: string; body: string }): RuleCategory {
  const { heading, body } = args;

  // Layer 1: inline marker.
  const marker = findInlineMarker(body, "category");
  if (marker !== null && VALID_CATEGORIES.has(marker)) {
    return marker as RuleCategory;
  }

  // Layer 2: heuristic keyword match.
  const blob = (heading + " " + body.slice(0, MAX_CATEGORY_SEARCH_CHARS)).toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    for (const keyword of keywords) {
      if (blob.includes(keyword)) {
        return category;
      }
    }
  }

  // Layer 3: default.
  return "style";
}

/**
 * Infer the rule's intent from body text.
 *
 * Priority:
 *   1. Inline marker `<!-- codemaster:intent=X -->` in body (unknown values fall through).
 *   2. Keyword heuristic against the lowercased body, first match wins. `forbid` checked before
 *      `require` so "must not" beats "must".
 *   3. Default `recommend`.
 */
export function inferIntent(args: { body: string }): RuleIntent {
  const { body } = args;

  // Layer 1: inline marker.
  const marker = findInlineMarker(body, "intent");
  if (marker !== null && VALID_INTENTS.has(marker)) {
    return marker as RuleIntent;
  }

  // Layer 2: heuristic keyword match.
  const blob = body.toLowerCase();
  for (const [intent, keywords] of INTENT_KEYWORDS) {
    for (const keyword of keywords) {
      if (blob.includes(keyword)) {
        return intent;
      }
    }
  }

  // Layer 3: default.
  return "recommend";
}
