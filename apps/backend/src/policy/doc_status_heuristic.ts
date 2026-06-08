// doc_status derivation heuristic — 1:1 port of the frozen Python
// vendor/codemaster-py/codemaster/policy/doc_status_heuristic.py (Sprint 26 / B-1).
//
// Pure function `deriveDocStatus(relativePath, body) -> KnowledgeDocStatus`. Applied by B-3's
// refresh workflow before persisting each chunk; also re-usable by tests + the operator-triage helper.
//
// Precedence (highest → lowest):
//   1. Front-matter `status:` field — superseded / deprecated / draft / active. Also: `draft: true`
//      yields `draft`.
//   2. Path patterns: `**/superseded/**` or `**/archive/**` → superseded; `**/deprecated/**` → deprecated.
//   3. Filename suffixes: `-superseded.md` / `-archived.md` → superseded; `-deprecated.md` → deprecated;
//      `-draft.md` → draft.
//   4. Default: active.
//
// Unknown `status:` values (e.g. `status: review`) fall through to the lower-precedence rules — defensive
// against typos. (The Python notes callers emit a structured INFO log on the unknown value; this function
// stays pure — see the metrics-emit divergence in refresh_semantic_docs.activity.ts.)
//
// PURE: no I/O, no logging.

import type { KnowledgeDocStatus } from "#contracts/knowledge_chunks.v1.js";

// Front-matter is YAML between two `---` lines at the top of the file. We don't pull in a YAML parser —
// narrow regex parsing is sufficient for the tiny `key: value` shape we care about.
//
// 1:1 with the Python `re.compile(r"^---\s*\n(?P<body>.*?)\n---\s*(?:\n|$)", re.DOTALL)`. JS: the `s`
// flag is `re.DOTALL`; the named group `(?<body>...)` mirrors `(?P<body>...)`.
const FRONTMATTER_RE = /^---\s*\n(?<body>[\s\S]*?)\n---\s*(?:\n|$)/;
// 1:1 with `re.compile(r"^\s*(?P<key>[A-Za-z_]+)\s*:\s*(?P<value>\S+)\s*$", re.MULTILINE)`. JS: the `m`
// flag is `re.MULTILINE`; `g` is required to iterate matches (the Python uses `finditer`).
const FRONTMATTER_KV_RE = /^\s*(?<key>[A-Za-z_]+)\s*:\s*(?<value>\S+)\s*$/gm;

// 1:1 with the Python `_KNOWN_STATUS_VALUES` dict.
const KNOWN_STATUS_VALUES: ReadonlyMap<string, KnowledgeDocStatus> = new Map([
  ["active", "active"],
  ["deprecated", "deprecated"],
  ["superseded", "superseded"],
  ["draft", "draft"],
]);

/**
 * Return the `doc_status` for the given (path, body) per the program-plan precedence table. 1:1 with the
 * frozen Python `derive_doc_status`.
 *
 * Pure function — no I/O, no logging.
 */
export function deriveDocStatus(relativePath: string, body: string): KnowledgeDocStatus {
  // ── Precedence 1: front-matter ───────────────────────────────────────────────────────────────────
  const fmStatus = parseFrontmatterStatus(body);
  if (fmStatus !== null) {
    return fmStatus;
  }

  // ── Precedence 2: path segments ──────────────────────────────────────────────────────────────────
  const segments = relativePath.split("/");
  if (segments.includes("superseded") || segments.includes("archive")) {
    return "superseded";
  }
  if (segments.includes("deprecated")) {
    return "deprecated";
  }

  // ── Precedence 3: filename suffixes ──────────────────────────────────────────────────────────────
  const filename = segments.length > 0 ? (segments[segments.length - 1] ?? "") : "";
  const base = removeSuffix(filename, ".md");
  if (base.endsWith("-superseded") || base.endsWith("-archived")) {
    return "superseded";
  }
  if (base.endsWith("-deprecated")) {
    return "deprecated";
  }
  if (base.endsWith("-draft")) {
    return "draft";
  }

  // ── Precedence 4: default ────────────────────────────────────────────────────────────────────────
  return "active";
}

/**
 * Return the front-matter-derived status, or `null` if no signal. 1:1 with the Python
 * `_parse_frontmatter_status`.
 *
 * Recognized signals:
 *   - `status: <known-value>` — direct lookup.
 *   - `draft: true` — yields `draft` (alternate way to mark a draft).
 */
function parseFrontmatterStatus(body: string): KnowledgeDocStatus | null {
  const fmMatch = FRONTMATTER_RE.exec(body);
  if (fmMatch === null) {
    return null;
  }
  const fmBody = fmMatch.groups?.["body"] ?? "";
  const found = new Map<string, string>();
  // `g`-flagged regex carries lastIndex state; reset it so repeated calls start from the top (the Python
  // `finditer` is stateless per call).
  FRONTMATTER_KV_RE.lastIndex = 0;
  let kv: RegExpExecArray | null = FRONTMATTER_KV_RE.exec(fmBody);
  while (kv !== null) {
    const key = (kv.groups?.["key"] ?? "").toLowerCase();
    const value = (kv.groups?.["value"] ?? "").toLowerCase();
    found.set(key, value);
    kv = FRONTMATTER_KV_RE.exec(fmBody);
  }

  const statusValue = found.get("status");
  if (statusValue !== undefined) {
    const known = KNOWN_STATUS_VALUES.get(statusValue);
    if (known !== undefined) {
      return known;
    }
    // Unknown status value — fall through to lower-precedence rules (the Python comment notes the caller
    // emits a structured INFO log; this function stays pure).
  }

  if (found.get("draft") === "true") {
    return "draft";
  }

  return null;
}

/** Python `str.removesuffix` analogue — strips `suffix` from the end of `s` iff present. */
function removeSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s;
}
