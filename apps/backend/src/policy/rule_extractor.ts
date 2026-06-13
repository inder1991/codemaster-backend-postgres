// rule_extractor — heading-aware markdown parser (Sprint 25 / A-2).
//
// Consumes one `GuidelineFileV1` and emits zero-to-many `ExtractedRuleV1` instances.
//
// Parsing strategy (per the source module docstring):
//   1. Heading-tree walk — track the current heading stack (H1 → H2 → H3 → …); each leaf section
//      yields a (heading_path, section_body) pair. heading_path truncated to MAX_HEADING_PATH_DEPTH.
//   2. Rule splitting within a section — list-style (lines starting `-`/`*`/`N.`) → one rule per
//      item; otherwise paragraph-style → one rule per blank-line-separated paragraph.
//   3. Per-rule transformation — title (deepest heading, or first ~80 chars of body), category +
//      intent via rule_classifier, priority via DEFAULT_PRIORITY_BY_CATEGORY, rule_id +
//      normalized_hash via rule_id, provenance, oversized-rule truncation.
//
// Implementation notes:
//   - `text.split("\n")` includes the trailing "" element when the string ends in "\n".
//   - `strip()` / `rstrip()` / `lstrip(" \t")` are reproduced via anchored replaces over ASCII
//     whitespace; `normalizeText` uses per-line rstrip.
//   - R-33 CommonMark continuation logic: tab→4-space expansion, indent threshold = marker-indent + 2.
//   - Classifier-heading is the deepest heading if present, else the derived title.
//   - Output rules are validated through the Zod ExtractedRuleV1 contract.

import { inferCategory, inferIntent } from "./rule_classifier.js";
import { deriveNormalizedHash, deriveRuleId } from "./rule_id.js";

import {
  DEFAULT_PRIORITY_BY_CATEGORY,
  ExtractedRuleV1,
  MAX_HEADING_PATH_DEPTH,
  MAX_RULE_BODY_CHARS,
  type RuleCategory,
} from "#contracts/extracted_rules.v1.js";
import { type GuidelineFileV1 } from "#contracts/guideline_files.v1.js";

// Heading regex: 1-6 leading '#' chars + whitespace + text. Group 1 = '#' count (depth), group 2 =
// heading text. The non-greedy `(.+?)\s*$` trims trailing whitespace off the captured heading.
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

// List-item detector: optional leading whitespace, a marker (-, *, or N.), whitespace, then content.
const LIST_MARKER_RE = /^\s*(?:[-*]|\d+\.)\s+\S/;

// Marker-capture regex (used by list-item extraction): group 1 = leading whitespace, group 2 = the
// item content after the marker.
const MARKER_RE = /^(\s*)(?:[-*]|\d+\.)\s+(.+)$/;

// Max title length when derived from body (not heading).
const MAX_DERIVED_TITLE_CHARS = 80;

/** Strip trailing ASCII whitespace. */
function rstrip(s: string): string {
  return s.replace(/[\s]+$/, "");
}

/** Strip leading + trailing ASCII whitespace (`.trim()` for the ASCII/markdown inputs this parser consumes). */
function strip(s: string): string {
  return s.trim();
}

/** Tab-expanded length of `s` with tab stops of 4 (length only). */
function expandedLen(s: string): number {
  let col = 0;
  for (const ch of s) {
    if (ch === "\t") {
      col += 4 - (col % 4);
    } else {
      col += 1;
    }
  }
  return col;
}

/**
 * Collapse internal whitespace + strip; preserve newlines within multi-line list-item bodies. Per
 * line: rstrip; drop leading + trailing fully-blank lines; join with "\n".
 */
function normalizeText(text: string): string {
  const lines = text.split("\n").map((ln) => rstrip(ln));
  while (lines.length > 0 && strip(lines[0]!) === "") {
    lines.shift();
  }
  while (lines.length > 0 && strip(lines[lines.length - 1]!) === "") {
    lines.pop();
  }
  return lines.join("\n");
}

/**
 * Walk the markdown body and return a list of (heading_path, section_body) pairs. heading_path is
 * truncated to MAX_HEADING_PATH_DEPTH. Pre-heading content yields an empty heading_path.
 */
function splitIntoSections(body: string): Array<{ path: Array<string>; body: string }> {
  const sections: Array<{ path: Array<string>; body: string }> = [];
  const headingStack: Array<{ depth: number; text: string }> = [];
  let currentBodyLines: Array<string> = [];

  const flushSection = (): void => {
    if (currentBodyLines.length === 0) {
      return;
    }
    const bodyText = normalizeText(currentBodyLines.join("\n"));
    if (bodyText === "") {
      return;
    }
    const path = headingStack.slice(0, MAX_HEADING_PATH_DEPTH).map((h) => h.text);
    sections.push({ path, body: bodyText });
  };

  for (const line of body.split("\n")) {
    const match = HEADING_RE.exec(line);
    if (match === null) {
      currentBodyLines.push(line);
      continue;
    }

    // Heading line — flush the section we just finished, then update the stack.
    flushSection();
    currentBodyLines = [];

    const depth = match[1]!.length;
    const headingText = match[2]!;
    while (
      headingStack.length > 0 &&
      headingStack[headingStack.length - 1]!.depth >= depth
    ) {
      headingStack.pop();
    }
    headingStack.push({ depth, text: headingText });
  }

  flushSection();
  return sections;
}

/**
 * Split a section body into list-item bodies (one entry per item). Multi-line list items
 * (continuation lines indented under the marker per CommonMark / R-33) are preserved as one entry.
 */
function extractListItems(body: string): Array<string> {
  const items: Array<string> = [];
  let current: Array<string> = [];
  // Indent threshold for the active list item; null when no item is open.
  let minContinuationIndent: number | null = null;

  const flush = (): void => {
    if (current.length > 0) {
      const joined = strip(current.join("\n"));
      if (joined !== "") {
        items.push(joined);
      }
    }
  };

  for (const line of body.split("\n")) {
    const markerMatch = MARKER_RE.exec(line);
    if (markerMatch !== null) {
      // New list item starts; flush previous.
      flush();
      const indentChars = markerMatch[1]!;
      current = [markerMatch[2]!];
      // Continuation indent threshold: marker-line indent (tab-expanded) + 2.
      minContinuationIndent = expandedLen(indentChars) + 2;
    } else if (current.length > 0 && strip(line) === "") {
      // Blank line — neutral; preserve the open item.
      current.push("");
    } else if (current.length > 0 && minContinuationIndent !== null) {
      // Measure THIS line's leading indent (tab-expanded); accept as continuation iff ≥ threshold.
      const leading = line.length - lstripWs(line).length;
      const lineIndent = leading > 0 ? expandedLen(line.slice(0, leading)) : 0;
      if (lineIndent >= minContinuationIndent) {
        current.push(strip(line));
      } else {
        // Outdented line — interrupts the list.
        flush();
        current = [];
        minContinuationIndent = null;
      }
    } else {
      // Non-list line interrupting a list (no active item).
      flush();
      current = [];
      minContinuationIndent = null;
    }
  }

  flush();
  return items;
}

/** Strip leading spaces + tabs only. */
function lstripWs(s: string): string {
  return s.replace(/^[ \t]+/, "");
}

/** Split a section body into paragraphs (blank-line-separated). */
function extractParagraphs(body: string): Array<string> {
  const paragraphs: Array<string> = [];
  let current: Array<string> = [];

  const flush = (): void => {
    if (current.length > 0) {
      const joined = strip(current.join("\n"));
      if (joined !== "") {
        paragraphs.push(joined);
      }
    }
  };

  for (const line of body.split("\n")) {
    if (strip(line) === "") {
      flush();
      current = [];
    } else {
      current.push(line);
    }
  }
  flush();
  return paragraphs;
}

/** True iff the section body contains at least one list marker (-, *, or N.) at line start. */
function sectionHasListItems(body: string): boolean {
  for (const line of body.split("\n")) {
    if (LIST_MARKER_RE.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Derive a title from the heading path (deepest heading wins) or fall back to the first ~80 chars of
 * body if no heading exists.
 */
function deriveTitle(headingPath: ReadonlyArray<string>, body: string): string {
  if (headingPath.length > 0) {
    return headingPath[headingPath.length - 1]!;
  }
  // No heading: use leading body content. Python: body.strip().replace("\n", " ") then trim to 80
  // and rstrip; `or "unnamed"` fallback.
  let snippet = strip(body).replaceAll("\n", " ");
  if (snippet.length > MAX_DERIVED_TITLE_CHARS) {
    snippet = rstrip(snippet.slice(0, MAX_DERIVED_TITLE_CHARS));
  }
  return snippet || "unnamed";
}

/** Truncate body to MAX_RULE_BODY_CHARS if needed. Returns [possibly-truncated-body, was_truncated]. */
function truncateBody(body: string): readonly [string, boolean] {
  if (body.length <= MAX_RULE_BODY_CHARS) {
    return [body, false];
  }
  return [body.slice(0, MAX_RULE_BODY_CHARS), true];
}

/**
 * Parse a guideline file into typed rules. Returns an empty array if the file body has no
 * extractable rules. Output objects are validated through the Zod ExtractedRuleV1 contract.
 */
export function extractRules(guidelineFile: GuidelineFileV1): Array<ExtractedRuleV1> {
  const sections = splitIntoSections(guidelineFile.body);
  const rules: Array<ExtractedRuleV1> = [];
  let ruleIndex = 0;

  for (const { path: headingPath, body: sectionBody } of sections) {
    if (strip(sectionBody) === "") {
      continue;
    }

    const ruleBodies = sectionHasListItems(sectionBody)
      ? extractListItems(sectionBody)
      : extractParagraphs(sectionBody);

    for (const ruleBodyRaw of ruleBodies) {
      const ruleBody = strip(ruleBodyRaw);
      if (ruleBody === "") {
        continue;
      }

      const [body, wasTruncated] = truncateBody(ruleBody);
      // (Python emits an INFO log on truncation; no return-value/wire impact — intentionally omitted.)

      const title = deriveTitle(headingPath, body);
      // Use the deepest heading for the classifier; falls back to title if no heading.
      const classifierHeading = headingPath.length > 0 ? headingPath[headingPath.length - 1]! : title;
      const category: RuleCategory = inferCategory({ heading: classifierHeading, body });
      const intent = inferIntent({ body });
      // eslint-disable-next-line security/detect-object-injection -- read-only lookup in a frozen const map keyed by the RuleCategory enum returned by inferCategory, not user input
      const priority = DEFAULT_PRIORITY_BY_CATEGORY[category];
      const nhash = deriveNormalizedHash({ title, body });
      const rid = deriveRuleId({
        category,
        scope_dir: guidelineFile.scope_dir,
        title,
        source_file: guidelineFile.relative_path,
        heading_path: headingPath,
        rule_index: ruleIndex,
        normalized_hash: nhash,
      });

      rules.push(
        ExtractedRuleV1.parse({
          rule_id: rid,
          normalized_hash: nhash,
          source_file: guidelineFile.relative_path,
          source_file_sha256: guidelineFile.content_sha256,
          scope_dir: guidelineFile.scope_dir,
          heading_path: headingPath,
          rule_index: ruleIndex,
          title,
          body,
          category,
          intent,
          priority,
          oversized_rule_warning: wasTruncated,
        }),
      );
      ruleIndex += 1;
    }
  }

  return rules;
}
