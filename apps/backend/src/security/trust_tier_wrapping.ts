// SECURITY-CRITICAL prompt-injection input-wrapping subsystem (Sprint 7 / S7.4.1).
//
// Untrusted PR/diff/manifest content is sanitized + wrapped here before it reaches any LLM
// prompt. Two primitives:
//
//   1. `stripPrivilegedTags(content)` — html.unescape the content (so `&lt;diff&gt;` is caught
//      alongside the literal `<diff>`), then drop any opening/closing privileged tag markers in
//      ANY case with arbitrary attributes. The *content* between tags is preserved as plain text.
//   2. `wrapUntrusted(content)` / `wrapUntrustedManifest(content)` — strip privileged tags, then
//      wrap in `<diff trust="untrusted"> … </diff trust="untrusted">` (resp. `manifest`). The
//      closing tag repeats the attribute string verbatim so a literal `</diff>` inside the body
//      can never close the wrapper via a permissive HTML parser.

import { htmlUnescape } from "./html_unescape.js";

// Tags the system-prompt template treats as privileged. Any of these appearing in untrusted
// content MUST be stripped before wrapping.
export const STRIPPED_TAGS: ReadonlyArray<string> = [
  "diff",
  "trusted",
  "untrusted",
  "system",
  "knowledge",
  "instructions",
  "tool",
  "tool_use",
  "tool_call",
  // FOLLOW-UP-manifest-prompt-rendering — so an attacker can't embed a literal
  // `<manifest trust="untrusted">` opener inside their PR diff (or manifest body) and break out
  // of the wrapping. The manifest wrapper is a privileged tag like `<diff trust="untrusted">`.
  "manifest",
];

export const OPEN_TRUSTED_PREFIX = '<diff trust="untrusted">';
export const CLOSE_TRUSTED_SUFFIX = '</diff trust="untrusted">';

// FOLLOW-UP-manifest-prompt-rendering — sibling wrapper for manifest content. Same repeated-
// attribute closing tag protocol so a literal `</manifest>` inside the body can never close the
// wrapper via a permissive HTML parser.
export const OPEN_MANIFEST_PREFIX = '<manifest trust="untrusted">';
export const CLOSE_MANIFEST_SUFFIX = '</manifest trust="untrusted">';

// Escape a tag name for safe regex-literal embedding (all STRIPPED_TAGS are `[a-z_]+` so this is a
// no-op in practice, but kept for construction parity).
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Port of Python `_build_tag_stripper`:
//   name_alt = "|".join(re.escape(t) for t in STRIPPED_TAGS)
//   pattern  = rf"</?\s*(?:{name_alt})\b[^<>]*/?\s*>"
//   re.compile(pattern, re.IGNORECASE)
//
// `<` + optional `/` + optional whitespace + tag-name (alternation) + word-boundary + optional
// arbitrary attribute string (no `<`/`>`) + optional `/` (self-close) + optional whitespace + `>`.
// Flags: `gi` — global so `re.sub` replaces ALL matches; case-insensitive per re.IGNORECASE.
function buildTagStripper(): RegExp {
  const nameAlt = STRIPPED_TAGS.map(reEscape).join("|");
  const pattern = `</?\\s*(?:${nameAlt})\\b[^<>]*/?\\s*>`;
  // Pattern built from a fixed, code-defined STRIPPED_TAGS allowlist (no user input).
  // detect-non-literal-regexp must be silenced on the construction line:
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(pattern, "gi");
}

const STRIP_RE = buildTagStripper();

/**
 * Remove any privileged tag markers from `content` (byte-exact port of `strip_privileged_tags`).
 *
 * Performs a one-shot HTML-entity decode first so encoded variants (`&lt;diff&gt;`) are caught
 * alongside the literal form. The *content* between tags is preserved as plain text.
 */
export function stripPrivilegedTags(content: string): string {
  if (!content) {
    return content;
  }
  const decoded = htmlUnescape(content);
  return decoded.replace(STRIP_RE, "");
}

/**
 * Strip privileged tags from `content`, then wrap as untrusted (byte-exact port of
 * `wrap_untrusted`).
 *
 *     <diff trust="untrusted">{content}</diff trust="untrusted">
 *
 * The closing tag repeats the attribute string verbatim so a literal `</diff>` inside the body can
 * never close the wrapper. Empty content still produces an empty wrapper.
 */
export function wrapUntrusted(content: string): string {
  const sanitized = stripPrivilegedTags(content);
  return `${OPEN_TRUSTED_PREFIX}${sanitized}${CLOSE_TRUSTED_SUFFIX}`;
}

/**
 * Manifest-flavor sibling of `wrapUntrusted` (byte-exact port of `wrap_untrusted_manifest`).
 *
 * Wraps repository-manifest content (package.json scripts, Dockerfile RUN commands, Gradle Kotlin
 * DSL, etc.) in `<manifest trust="untrusted">`. Same privileged-tag stripping + repeated-attribute
 * closing-tag protocol as `wrapUntrusted`.
 */
export function wrapUntrustedManifest(content: string): string {
  const sanitized = stripPrivilegedTags(content);
  return `${OPEN_MANIFEST_PREFIX}${sanitized}${CLOSE_MANIFEST_SUFFIX}`;
}
