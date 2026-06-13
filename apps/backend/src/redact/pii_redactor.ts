// RegexPiiRedactor — TypeScript implementation of the PII redactor.
//
// Replaces PII spans in arbitrary text with stable `[REDACTED:<kind>]` placeholders. Intentionally
// conservative: matches only kinds detectable with high precision so the Langfuse exporter, the
// Bedrock payload archive, and the prompt-context builder don't smuggle identifiers downstream.
//
// OFFSET SEMANTICS: start/end_offset are UTF-16 code units (`match.index`), whereas Python `re`
// reports CODE POINTS. Identical across the BMP — including every char of the adversarial pii corpus
// (verified: zero non-BMP) — and self-consistent in production (detect + rewrite both in UTF-16);
// they diverge only when comparing offsets cross-impl on astral-plane input. Same note as
// secret_detector.ts; convert via code-point iteration here if non-BMP fidelity is ever required.
//
// Kinds (Sprint 7 set):
//   - email             — RFC-5322-ish; the simple-but-broad shape
//   - us_ssn            — NNN-NN-NNNN with the conventional prefixes excluded
//   - credit_card       — Luhn-validated 13–19 digit sequences (optional spaces / dashes)
//   - us_phone          — North-American number formats
//   - iban              — country-code + check digits + 11–30 alphanumerics
//   - aws_access_key_id — AKIA + 16 base32 chars
//   - github_pat        — ghp_ + 36+ chars
//   - github_app_token  — ghs_ + 36+ chars
//
// Specific kinds take precedence; later passes don't re-match offsets already claimed by an earlier
// finding (mirrors the Python `_claim` overlap reservation).
//
// Python→JS regex translation notes (all VERIFIED against the live Python driver, not assumed):
//   - `\b` (ASCII word boundary), `(?!…)` negative lookahead and `(?<!…)` negative lookbehind are all
//     supported identically in Node 22's RegExp engine — no flag needed.
//   - Python `re.finditer` ↔ `String.prototype.matchAll(/…/g)`; offsets come from `match.index`.
//   - None of these patterns use re.MULTILINE / re.DOTALL, so no /m or /s flag is required; `\d` and
//     `\s` are ASCII-equivalent across both engines for the corpus inputs.

import { type PiiFindingV1 } from "#contracts/pii_redaction.v1.js";

// ─── Pattern set ─────────────────────────────────────────────────────────────

// `\-` from the Python source is written here as a class-trailing literal `-` (equivalent: inside a
// character class a `-` immediately before `]` is unambiguously literal, so no escape is needed in
// JS) to satisfy `no-useless-escape` while preserving byte-identical matching — verified against the
// frozen Python over the full corpus.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// US SSN: 3-2-4 digits with hyphens. Excludes 000/666/9xx area numbers (per SSA's never-issued
// ranges) to drop the worst false positives (UPC codes, IPs, etc.).
const US_SSN_RE = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

// Credit card: 13–19 digits, optionally separated by spaces/dashes. Luhn-validated below before we
// accept the match. The `(?:\d[ -]?){12,18}` quantifier-over-class shape mirrors the frozen Python
// pattern verbatim; the inner `[ -]?` matches a single char (no overlap) so it is not ReDoS-prone.
// eslint-disable-next-line security/detect-unsafe-regex -- 1:1 port of the frozen Pydantic-era regex; inner `[ -]?` consumes a single bounded char (no ambiguous/nested backtracking), the `{12,18}` repeat is bounded, and the surrounding lookaround anchors the span
const CREDIT_CARD_RE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;

// North-American phone: optional +1, area + exchange + line. We accept the common formatted shapes;
// raw 10-digit strings are excluded because they collide with order numbers, IDs, etc.
// eslint-disable-next-line security/detect-unsafe-regex -- 1:1 port of the frozen regex; every group is a single bounded char class with no overlapping/ambiguous quantifiers
const US_PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;

// IBAN: 2-letter country code + 2 check digits + 11..30 alphanumerics. Real IBANs are commonly
// written in groups of 4 separated by spaces; we accept that variant too.
// eslint-disable-next-line security/detect-unsafe-regex -- 1:1 port of the frozen regex; the `(?:\s?[A-Z0-9]){10,29}` body has a bounded repeat and each iteration consumes ≥1 char, so no catastrophic backtracking
const IBAN_RE = /\b[A-Z]{2}\d{2}\s?[A-Z0-9](?:\s?[A-Z0-9]){10,29}\b/g;

// AWS access keys + GitHub tokens: same shape as in the secret detector (PII-like surface — we redact
// in payloads regardless of who owns them).
const AWS_ACCESS_KEY_RE = /\b(AKIA[0-9A-Z]{16})\b/g;
const GITHUB_PAT_RE = /\b(ghp_[A-Za-z0-9]{36,})\b/g;
const GITHUB_APP_TOKEN_RE = /\b(ghs_[A-Za-z0-9]{36,})\b/g;

/** True iff `digits` (a digit-only string) passes the Luhn check. Mirrors `_luhn_ok`. */
function luhnOk(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  let total = 0;
  const parity = digits.length % 2;
  for (let i = 0; i < digits.length; i += 1) {
    let d = digits.charCodeAt(i) - 48;
    if (i % 2 === parity) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    total += d;
  }
  return total % 10 === 0;
}

/** Mirrors `_strip_separators`: drop spaces and hyphens. */
function stripSeparators(s: string): string {
  return s.replaceAll(" ", "").replaceAll("-", "");
}

/** True iff every character of `s` is an ASCII digit. Mirrors Python `str.isdigit()` for our inputs. */
function isAllDigits(s: string): boolean {
  if (s.length === 0) {
    return false;
  }
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) {
      return false;
    }
  }
  return true;
}

// ─── Implementation ──────────────────────────────────────────────────────────

// (kind, regex, confidence). Order matters: specific kinds claim offsets first; later passes skip
// overlapping ranges. Mirrors Python `_PATTERNS`.
const PATTERNS: ReadonlyArray<readonly [string, RegExp, number]> = [
  ["aws_access_key_id", AWS_ACCESS_KEY_RE, 0.99],
  ["github_pat", GITHUB_PAT_RE, 0.99],
  ["github_app_token", GITHUB_APP_TOKEN_RE, 0.99],
  ["us_ssn", US_SSN_RE, 0.95],
  ["iban", IBAN_RE, 0.85],
  ["email", EMAIL_RE, 0.95],
  ["us_phone", US_PHONE_RE, 0.85],
];

type SpanFinding = { readonly start: number; readonly end: number; readonly finding: PiiFindingV1 };

/**
 * Replace every detected PII span in `text` with `[REDACTED:<kind>]` and return the rewritten text +
 * the ordered findings. 1:1 port of `RegexPiiRedactor.redact`: specific kinds claim offsets first; a
 * credit-card pass (Luhn-validated) runs last; overlapping ranges are skipped; findings are emitted
 * sorted by start offset; offsets point at the match inside the *original* text.
 */
export function redactPii(text: string): { rewritten: string; findings: Array<PiiFindingV1> } {
  if (!text) {
    return { rewritten: text, findings: [] };
  }

  const findings: Array<SpanFinding> = [];
  const claimed: Array<readonly [number, number]> = [];

  // Reserve [start, end) iff it doesn't overlap an earlier claim. Mirrors `_claim`.
  const claim = (start: number, end: number): boolean => {
    for (const [s, e] of claimed) {
      if (start < e && end > s) {
        return false;
      }
    }
    claimed.push([start, end]);
    return true;
  };

  // Pass 1: high-precision, fixed-shape kinds.
  for (const [kind, regex, confidence] of PATTERNS) {
    for (const m of text.matchAll(regex)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!claim(start, end)) {
        continue;
      }
      findings.push({
        start,
        end,
        finding: {
          schema_version: 1,
          kind,
          replacement: `[REDACTED:${kind}]`,
          start_offset: start,
          end_offset: end,
          confidence,
        },
      });
    }
  }

  // Pass 2: credit cards (Luhn-validated; rejects formatted SSNs that happen to digit-match).
  for (const m of text.matchAll(CREDIT_CARD_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    const digits = stripSeparators(m[0]);
    if (!isAllDigits(digits) || !luhnOk(digits)) {
      continue;
    }
    if (!claim(start, end)) {
      continue;
    }
    findings.push({
      start,
      end,
      finding: {
        schema_version: 1,
        kind: "credit_card",
        replacement: "[REDACTED:credit_card]",
        start_offset: start,
        end_offset: end,
        confidence: 0.95,
      },
    });
  }

  if (findings.length === 0) {
    return { rewritten: text, findings: [] };
  }

  // Stable sort by start offset (mirrors Python `findings.sort(key=lambda f: f[0])`, which is stable).
  findings.sort((a, b) => a.start - b.start);

  const out: Array<string> = [];
  let cursor = 0;
  for (const { start, end, finding } of findings) {
    if (start > cursor) {
      out.push(text.slice(cursor, start));
    }
    out.push(finding.replacement);
    cursor = end;
  }
  if (cursor < text.length) {
    out.push(text.slice(cursor));
  }

  return { rewritten: out.join(""), findings: findings.map((f) => f.finding) };
}
