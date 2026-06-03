// Span-level redaction of secret-shaped strings in LLM output.
//
// 1:1 port of the frozen Python codemaster/security/output_redaction.py::redact_text. Pure function:
// takes the original LLM text + the secret-finding spans and returns a redacted copy with each
// merged span replaced by `[REDACTED]`.
//
// Properties (mirrored exactly from the source-of-truth, parity-proven in
// test/parity/redact_redactor.parity.test.ts):
//  - Pure: no I/O, no side effects; the caller's input string is never mutated.
//  - Findings may arrive in any order; internally sorted by (start, end).
//  - Overlapping / adjacent spans are unioned and redacted once.
//  - Zero-width spans (end == start) are dropped.
//  - Empty (or all-dropped) findings → the input text returned unchanged with spansRedacted = 0.
//
// The Python `RedactionResult` is a frozen `@dataclass(slots=True)` with a `__post_init__` that
// rejects a negative `spans_redacted`; the `spansRedacted` factory guard below reproduces that
// invariant on the TS side (redactText itself can only ever produce a non-negative count).

/** Result of a {@link redactText} call: the rewritten text + how many merged spans were redacted. */
export type RedactionResult = {
  readonly redactedText: string;
  readonly spansRedacted: number;
};

// Sprint 1 v2 (R6 simplification) — the token is the simple `[REDACTED]` without kind or hash.
const REDACTION_TOKEN = "[REDACTED]";

/** A redaction span: the offsets are all that redact_text consumes from a finding. */
type Span = { readonly start_offset: number; readonly end_offset: number };

/**
 * Construct a {@link RedactionResult}, reproducing the frozen dataclass `__post_init__` invariant:
 * `spansRedacted` must be non-negative.
 */
function makeRedactionResult(redactedText: string, spansRedacted: number): RedactionResult {
  if (spansRedacted < 0) {
    throw new Error(`spansRedacted must be non-negative; got ${spansRedacted}`);
  }
  return { redactedText, spansRedacted };
}

/** Sort by (start, end); merge overlapping/adjacent spans into one. Mirrors `_merge_overlapping`. */
function mergeOverlapping(spans: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  if (spans.length === 0) {
    return [];
  }
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const first = sorted[0]!;
  const merged: Array<[number, number]> = [[first[0], first[1]]];
  for (const [start, end] of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * Replace every secret-finding span in `text` with `[REDACTED]`.
 *
 * Pure: `text` is not mutated. Findings may be in any order (internally sorted by offset);
 * overlapping findings are unioned and redacted once; zero-width spans (`end == start`) are ignored.
 * Empty / all-dropped findings return `text` unchanged with `spansRedacted = 0`.
 */
export function redactText(text: string, findings: ReadonlyArray<Span>): RedactionResult {
  const spans: Array<readonly [number, number]> = [];
  for (const f of findings) {
    if (f.end_offset > f.start_offset) {
      spans.push([f.start_offset, f.end_offset]);
    }
  }
  const merged = mergeOverlapping(spans);
  if (merged.length === 0) {
    return makeRedactionResult(text, 0);
  }

  const parts: Array<string> = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) {
      parts.push(text.slice(cursor, start));
    }
    parts.push(REDACTION_TOKEN);
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return makeRedactionResult(parts.join(""), merged.length);
}
