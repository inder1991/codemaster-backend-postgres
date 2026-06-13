// Confluence chunk redactor — wraps the Sprint-7 PII / secret redactor with a thin Confluence-specific
// layer that adds extra masks for content patterns common in team docs but not in PR diffs.
//
// Locked behaviour:
//   * The chunk goes through the Sprint-7 redactor first (the already-ported redactPii, the analogue
//     of the Python `_apply_sprint7_redactor`'s `RegexPiiRedactor().redact()` — its `rewritten` field
//     is the Python `result[0]`).
//   * Confluence-specific mask: bearer-style API tokens that show up in runbooks (e.g.
//     `token: abcdef123456`) are masked even when Sprint-7 wouldn't flag them.
//   * The final text is wrapped in `<doc trust="untrusted">...</doc>` per the trust-tier rule so the
//     LLM downstream treats it as untrusted content.
//   * Returns a RedactionResult with the redacted text + a `redaction_applied` flag.
//
// PURE: no I/O, no clock, no random. The Sprint-7 redactor (redactPii) is itself pure regex masking.
//
// Python→JS regex translation notes:
//   - Python inline flag `(?im)` -> JS `i` + `m` flags. The `^` anchor in the line regex matches at
//     each line start under `m` (mirroring re.MULTILINE).
//   - Python `re.sub(regex, fn, text)` applies the replacement function left-to-right over all
//     non-overlapping matches -> JS `String.prototype.replace(/.../g, fn)` with the global flag.
//   - Both the line mask and the inline mask are applied in sequence over the FULL text (the inline
//     mask sees the output of the line mask), exactly as the Python does.

import { redactPii } from "#backend/redact/pii_redactor.js";

// Confluence-specific masks. The Sprint-7 redactor covers the generic universe (emails, SSNs, credit
// cards, AWS keys); these are the patterns observed in team-runbook copy specifically.
//
// (?im)^\s*(?:bearer|token|api[_-]?key|password)\s*[:=]\s*\S+  -- whole token-bearing line.
const TOKEN_LINE_RE = /^\s*(?:bearer|token|api[_-]?key|password)\s*[:=]\s*\S+/gim;
// (?i)(bearer|token|api[_-]?key)[:=]\s*\S+  -- inline token=value.
const INLINE_TOKEN_RE = /(bearer|token|api[_-]?key)[:=]\s*\S+/gi;

const TRUST_OPEN = '<doc trust="untrusted">';
const TRUST_CLOSE = "</doc>";

/**
 * Output of `redactChunk`. `text` is the wrapped + redacted chunk ready for embedding;
 * `redaction_applied` is True iff at least one mask matched.
 */
export type RedactionResult = {
  readonly text: string;
  readonly redaction_applied: boolean;
};

/**
 * Apply Sprint-7 PII redaction + Confluence masks; wrap the result in the trust-tier tag.
 */
export function redactChunk(text: string): RedactionResult {
  let redactionApplied = false;
  let working = text;

  // Sprint-7 redactor pass (the analogue of `_apply_sprint7_redactor`). The TS port has the redactor
  // wired (unlike the Python stub-aggressive `None` path), so it always runs.
  const sprint7Redacted = redactPii(working).rewritten;
  if (sprint7Redacted !== working) {
    redactionApplied = true;
  }
  working = sprint7Redacted;

  // Line mask: replace each token-bearing line with `<prefix>: <REDACTED>`, where <prefix> is the
  // text up to the first ":" (Python: `m.group(0).split(":")[0] + ": <REDACTED>"`).
  const maskedTokenLines = working.replace(
    TOKEN_LINE_RE,
    (match) => `${match.split(":")[0]}: <REDACTED>`,
  );
  if (maskedTokenLines !== working) {
    redactionApplied = true;
    working = maskedTokenLines;
  }

  // Inline mask: replace `<kw>=<value>` / `<kw>:<value>` with `<kw>=<REDACTED>` (Python:
  // `f"{m.group(1)}=<REDACTED>"`).
  const maskedInlineTokens = working.replace(
    INLINE_TOKEN_RE,
    (_match, kw: string) => `${kw}=<REDACTED>`,
  );
  if (maskedInlineTokens !== working) {
    redactionApplied = true;
    working = maskedInlineTokens;
  }

  const wrapped = `${TRUST_OPEN}${working}${TRUST_CLOSE}`;
  return { text: wrapped, redaction_applied: redactionApplied };
}
