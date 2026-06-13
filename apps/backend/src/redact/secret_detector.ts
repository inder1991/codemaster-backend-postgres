// PatternSecretDetector — regex-based secret detector.
//
// Regex-based secret detector targeting the documented kinds:
//   - aws_access_key_id     (AKIA + 16 upper-hex)
//   - github_pat            (ghp_<36+ base62>)
//   - github_app_token      (ghs_<36+ base62>)
//   - vault_token           (hvs.<20+ token chars>)
//   - aws_secret_access_key (40-char base64-ish, context-anchored)
//   - generic_high_entropy  (32+ char [A-Za-z0-9_-], Shannon-entropy-gated)
//
// Every detection carries the redacted snippet (first/last 4 chars) so operators can identify which
// credential leaked without exposing the full value to logs / Langfuse traces.
//
//
// Python→JS regex notes (handled below):
//   - `\b` is identical in both engines.
//   - The AWS-secret pattern uses a NON-capturing context prefix `(?:…)` then captures group 1; the
//     Python code reports `m.start(1)`/`m.end(1)` (the captured value's offset, NOT the whole match),
//     so we compute the group-1 offset from the full-match index + the captured value's position.
//   - `re.IGNORECASE` → /i. No re.MULTILINE / re.DOTALL is used by any pattern.
//   - `re.finditer` → `text.matchAll(/…/g)`; offsets come from `match.index`.
//   - OFFSET SEMANTICS: start/end_offset are UTF-16 code units (`match.index`), whereas Python `re`
//     reports CODE POINTS. Identical across the whole BMP — including every char of the adversarial
//     corpora (verified: zero non-BMP) — and self-consistent in production (this detector and the
//     redactor both slice in UTF-16). They diverge only when comparing offsets cross-impl on
//     astral-plane input (emoji etc.); the parity test catches any in-corpus drift. If code-point
//     offset fidelity is ever needed for non-BMP input, convert via code-point iteration here.

import { type SecretFindingV1 } from "#contracts/secret_detection.v1.js";

// ─── Allowlist (Sprint 1 v2 — Output Safety) ─────────────────────────────────────────────────────
// AWS's official published synthetic test key. Matches the AWS-access-key regex but cannot be a real
// credential (GitHub push-protection allowlists it for the same reason). Mirrors the frozen Python
// `_SYNTHETIC_TEST_KEY_ALLOWLIST` (single-entry frozenset).
const SYNTHETIC_TEST_KEY_ALLOWLIST: ReadonlySet<string> = new Set(["AKIAIOSFODNN7EXAMPLE"]);

// ─── Pattern set ─────────────────────────────────────────────────────────────────────────────────
// Each `g`-flagged RegExp drives `matchAll`; group 1 is the captured secret. These mirror the frozen
// Python `re.compile` patterns verbatim (same character classes, same quantifiers, same anchors).

const AWS_ACCESS_KEY_RE = /\b(AKIA[0-9A-Z]{16})\b/g;
const GITHUB_PAT_RE = /\b(ghp_[A-Za-z0-9]{36,})\b/g;
const GITHUB_APP_TOKEN_RE = /\b(ghs_[A-Za-z0-9]{36,})\b/g;
const VAULT_TOKEN_RE = /\b(hvs\.[A-Za-z0-9_-]{20,})\b/g;
// AWS secret keys: 40 chars from [A-Za-z0-9/+=] — noisy on their own, so anchored on a context word
// (`secret`, `aws`, …). The leading `(?:…)` group is non-capturing; group 1 is the 40-char value.
const AWS_SECRET_RE =
  /(?:aws[_-]?secret|secret[_-]?access[_-]?key|aws_secret_access_key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})/gi;

const GENERIC_HIGH_ENTROPY_MIN_LEN = 32;
const GENERIC_HIGH_ENTROPY_MIN_BITS = 4.0; // bits/char
const GENERIC_TOKEN_RE = /\b([A-Za-z0-9_-]{32,})\b/g;

/** Bits-per-character Shannon entropy. Empty string → 0. Mirrors `_shannon_entropy`. */
function shannonEntropy(s: string): number {
  if (s.length === 0) {
    return 0.0;
  }
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const n = s.length;
  let acc = 0.0;
  for (const c of counts.values()) {
    const p = c / n;
    acc += p * Math.log2(p);
  }
  return -acc;
}

/** Show first/last 4 chars; mask the middle. Mirrors `_redact` (the ellipsis is U+2026 `…`). */
function redact(secret: string): string {
  if (secret.length <= 8) {
    return "…".repeat(secret.length);
  }
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/**
 * Group-1 match: the captured secret plus its [start, end) offset within `text`.
 *
 * Every pattern in this module ENDS with the capture group — group 1's text is the suffix of the
 * full match. So group 1's offset is exactly `match.index + match[0].length - value.length`,
 * independent of whether a non-capturing context prefix precedes it (AWS-secret pattern) or the
 * capture spans the whole match (the other patterns). This is byte-exact: it reproduces Python's
 * `m.start(1)` / `m.end(1)` without substring-search heuristics.
 */
type GroupMatch = { readonly value: string; readonly start: number; readonly end: number };

function* iterGroup1(re: RegExp, text: string): Generator<GroupMatch> {
  for (const m of text.matchAll(re)) {
    const value = m[1];
    if (value === undefined || m.index === undefined) {
      continue;
    }
    const start = m.index + m[0].length - value.length;
    yield { value, start, end: start + value.length };
  }
}

function makeFinding(kind: string, gm: GroupMatch, confidence: number): SecretFindingV1 {
  return {
    schema_version: 1,
    kind,
    snippet_redacted: redact(gm.value),
    start_offset: gm.start,
    end_offset: gm.end,
    confidence,
  };
}

const SPECIFIC_PATTERNS: ReadonlyArray<readonly [string, RegExp, number]> = [
  ["aws_access_key_id", AWS_ACCESS_KEY_RE, 0.99],
  ["github_pat", GITHUB_PAT_RE, 0.99],
  ["github_app_token", GITHUB_APP_TOKEN_RE, 0.99],
  ["vault_token", VAULT_TOKEN_RE, 0.95],
  ["aws_secret_access_key", AWS_SECRET_RE, 0.95],
];

/**
 * Detect secrets in `text`. Specific kinds run first (their matches take precedence over the generic
 * catch-all); the generic high-entropy pass emits only where no specific finding already covers the
 * offset range. Order of returned findings mirrors the frozen Python: specific kinds in declaration
 * order, then generic.
 */
export function detectSecrets(text: string): Array<SecretFindingV1> {
  const findings: Array<SecretFindingV1> = [];
  const seenOffsets = new Set<string>();

  for (const [kind, regex, conf] of SPECIFIC_PATTERNS) {
    for (const gm of iterGroup1(regex, text)) {
      const key = `${gm.start}:${gm.end}`;
      if (seenOffsets.has(key)) {
        continue;
      }
      seenOffsets.add(key);
      // Sprint 1 v2 tactical allowlist: skip AWS-published synthetic test patterns.
      if (kind === "aws_access_key_id" && SYNTHETIC_TEST_KEY_ALLOWLIST.has(gm.value)) {
        continue;
      }
      findings.push(makeFinding(kind, gm, conf));
    }
  }

  // Generic high-entropy catch-all. Emit only if no specific finding already covers the same range.
  const seenRanges: Array<readonly [number, number]> = [...seenOffsets].map((k) => {
    const [s, e] = k.split(":");
    return [Number(s), Number(e)] as const;
  });
  for (const gm of iterGroup1(GENERIC_TOKEN_RE, text)) {
    const covered = seenRanges.some(([s, e]) => gm.start >= s && gm.end <= e);
    if (covered) {
      continue;
    }
    if (gm.value.length < GENERIC_HIGH_ENTROPY_MIN_LEN) {
      continue;
    }
    if (shannonEntropy(gm.value) < GENERIC_HIGH_ENTROPY_MIN_BITS) {
      continue;
    }
    findings.push(makeFinding("generic_high_entropy", gm, 0.6));
  }

  return findings;
}
