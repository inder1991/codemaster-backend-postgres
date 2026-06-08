// Issue-link parser — 1:1 port of the frozen Python
// `vendor/codemaster-py/codemaster/ingest/issue_link_parser.py::parse_issue_links` (Sprint 21 / S21.DM.10).
//
// Pure function. Extracts `(github_issue_number, linkage_kind, source)` triples from PR text (description,
// title, branch name, commit message). No I/O. The webhook handler invokes this on every PR-open / PR-edit
// event; results land in `core.pr_issue_links` via the producer `replaceLinks`.
//
// The `IssueLink` / `LinkageKind` / `LinkageSource` types live in `#contracts/issue_link.v1.js` (the Zod
// port of the frozen `@dataclass`); we reuse them here rather than redefining.
//
// Trust-boundary: this is a PRE-LLM step. The parser does NOT skip text wrapped in
// `<diff trust="untrusted">…</diff>` — extraction is a structural action, not an LLM action. An adversarial
// `Closes #999` inside a trust-tagged block still produces the link record; the LLM-side clause refuses to
// ACT on it (faithful to the Python module docstring).

import type { IssueLink, LinkageKind, LinkageSource } from "#contracts/issue_link.v1.js";

// GitHub treats these as auto-closing keywords on PR merge. Any variation (`closes`, `Closed`, `CLOSES`,
// `close`) maps to the same `closes` linkage_kind for our purposes. 1:1 with Python `_KEYWORD_TO_KIND`.
// A `Map` (vs a plain object) keeps the dynamic `.get(keyword)` lookup off the object-injection sink.
const KEYWORD_TO_KIND: ReadonlyMap<string, LinkageKind> = new Map<string, LinkageKind>([
  ["close", "closes"],
  ["closes", "closes"],
  ["closed", "closes"],
  ["fix", "fixes"],
  ["fixes", "fixes"],
  ["fixed", "fixes"],
  ["resolve", "resolves"],
  ["resolves", "resolves"],
  ["resolved", "resolves"],
]);

// Keyword-prefixed reference, e.g. `Closes #5`, `Fixes: #5`, `resolved#5`. Case-insensitive; `g` so we can
// iterate every match (Python `finditer`). 1:1 with Python `_KEYWORD_RE`.
const KEYWORD_RE = /\b(close[ds]?|fix(?:es|ed)?|resolve[ds]?)\s*[:\s]?\s*#(\d{1,9})\b/gi;

// Bare `#N` mention. The `(?<![\w/])` negative lookbehind rejects `#9` that immediately follows a word char
// or a slash (so `owner/repo#9` and `word#5` do NOT match). 1:1 with Python `_BARE_HASH_RE`.
const BARE_HASH_RE = /(?<![\w/])#(\d{1,9})\b/g;

/**
 * Extract distinct issue links from `text`. 1:1 with the frozen Python `parse_issue_links`.
 *
 * Two-pass dedup, EXACTLY as Python:
 *   - Pass 1: keyword-prefixed links (closes / fixes / resolves), deduped on the `(n, kind)` tuple via
 *     keep-first (Python `dict.setdefault`).
 *   - Pass 2: bare `#N` → `mentioned`, but SKIP any issue number already captured by a keyword in pass 1
 *     (auto-closing wins over a bare mention).
 *
 * Empty text → []. `n <= 0` is ignored. Insertion order is preserved (the `Map` keyed on the `(n, kind)`
 * tuple mirrors Python's `tuple(seen.values())`).
 *
 * Cross-SOURCE dedup is the caller's job — `replaceLinks`'s natural key
 * `(pr_id, github_issue_number, linkage_kind, source)` keeps the `source` axis distinct by design.
 */
export function parseIssueLinks(args: { text: string; source: LinkageSource }): Array<IssueLink> {
  const { text, source } = args;
  if (!text) {
    return [];
  }

  // Keyed on the `${n}|${kind}` tuple-string; a Map preserves insertion order like Python's dict.
  const seen = new Map<string, IssueLink>();

  // Pass 1 — keyword-prefixed extractions.
  KEYWORD_RE.lastIndex = 0;
  for (let m = KEYWORD_RE.exec(text); m !== null; m = KEYWORD_RE.exec(text)) {
    const keyword = m[1]!.toLowerCase();
    const kind = KEYWORD_TO_KIND.get(keyword);
    if (kind === undefined) {
      continue;
    }
    const n = Number.parseInt(m[2]!, 10);
    if (n <= 0) {
      continue;
    }
    const key = `${n}|${kind}`;
    if (!seen.has(key)) {
      seen.set(key, { github_issue_number: n, linkage_kind: kind, source });
    }
  }

  // Pass 2 — bare `#N` mentions. Skip when pass 1 already produced a stronger link for the same issue.
  const keywordIssues = new Set<number>();
  for (const link of seen.values()) {
    keywordIssues.add(link.github_issue_number);
  }
  BARE_HASH_RE.lastIndex = 0;
  for (let m = BARE_HASH_RE.exec(text); m !== null; m = BARE_HASH_RE.exec(text)) {
    const n = Number.parseInt(m[1]!, 10);
    if (n <= 0) {
      continue;
    }
    if (keywordIssues.has(n)) {
      continue;
    }
    const key = `${n}|mentioned`;
    if (!seen.has(key)) {
      seen.set(key, { github_issue_number: n, linkage_kind: "mentioned", source });
    }
  }

  return [...seen.values()];
}
