// doc_kind derivation heuristic — 1:1 port of the frozen Python
// vendor/codemaster-py/codemaster/policy/doc_kind_heuristic.py (Sprint 26 / B-1).
//
// Pure function `deriveDocKind(relativePath) -> KnowledgeDocKind`. Path-first; falls back to `other`
// when no pattern matches.
//
// Pattern precedence (first match wins per the program plan):
//   1. `docs/adr/**` OR filename matches `adr-NNNN-*.md` → adr
//   2. `docs/rfc/**` OR filename matches `rfc-*.md` → rfc
//   3. `docs/architecture/**` OR `ARCHITECTURE.md` (root or nested) → architecture
//   4. `docs/runbooks/**` OR `runbooks/**` OR `RUNBOOK*.md` → runbook
//   5. Default → other
//
// PURE: no I/O, no clock, no random. Called from `discoverKnowledgeDocs` + `embedDocChunks` (both run
// in the Node runtime, never the workflow sandbox).

import type { KnowledgeDocKind } from "#contracts/knowledge_chunks.v1.js";

// 1:1 with the Python `re.compile(r"^adr-\d+", re.IGNORECASE)` etc. The `^` anchors to the start of the
// FILENAME (not the full path); the JS `i` flag mirrors `re.IGNORECASE`.
const ADR_FILENAME_RE = /^adr-\d+/i;
const RFC_FILENAME_RE = /^rfc-/i;
const RUNBOOK_FILENAME_RE = /^runbook/i;

/**
 * Return True iff `first` immediately precedes `second` somewhere in the path. Matches "docs/adr/..."
 * OR "any/docs/adr/...". 1:1 with the Python `_path_has_segment_pair`.
 */
function pathHasSegmentPair(segments: ReadonlyArray<string>, first: string, second: string): boolean {
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i] === first && segments[i + 1] === second) {
      return true;
    }
  }
  return false;
}

/**
 * Return the `doc_kind` for the given path per the program-plan first-match-wins table. 1:1 with the
 * frozen Python `derive_doc_kind`.
 *
 * Pure function — no I/O. Empty path → `other`.
 */
export function deriveDocKind(relativePath: string): KnowledgeDocKind {
  if (!relativePath) {
    return "other";
  }

  const segments = relativePath.split("/");
  // `segments` is always non-empty after `.split` (a string with no "/" yields a 1-element array), so the
  // last element is defined; the `?? ""` keeps noUncheckedIndexedAccess satisfied without changing behaviour.
  const filename = segments[segments.length - 1] ?? "";

  // ── Row 1: ADR ─────────────────────────────────────────────────────────────────────────────────
  if (pathHasSegmentPair(segments, "docs", "adr")) {
    return "adr";
  }
  if (ADR_FILENAME_RE.test(filename)) {
    return "adr";
  }

  // ── Row 2: RFC ─────────────────────────────────────────────────────────────────────────────────
  if (pathHasSegmentPair(segments, "docs", "rfc")) {
    return "rfc";
  }
  if (RFC_FILENAME_RE.test(filename)) {
    return "rfc";
  }

  // ── Row 3: Architecture ────────────────────────────────────────────────────────────────────────
  if (pathHasSegmentPair(segments, "docs", "architecture")) {
    return "architecture";
  }
  if (filename === "ARCHITECTURE.md") {
    return "architecture";
  }

  // ── Row 4: Runbook ─────────────────────────────────────────────────────────────────────────────
  if (pathHasSegmentPair(segments, "docs", "runbooks")) {
    return "runbook";
  }
  if (segments[0] === "runbooks") {
    return "runbook";
  }
  if (RUNBOOK_FILENAME_RE.test(filename)) {
    return "runbook";
  }

  // ── Row 5: Default ─────────────────────────────────────────────────────────────────────────────
  return "other";
}
