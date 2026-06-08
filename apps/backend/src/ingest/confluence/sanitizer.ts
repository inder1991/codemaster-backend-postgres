// Confluence body sanitization — 1:1 port of the frozen Python
// vendor/codemaster-py/codemaster/ingest/confluence/sanitizer.py.
//
// Three-step pipeline:
//   1. Strip Confluence macros (<ac:structured-macro>, <ac:layout>, etc.) — unwrap the envelope,
//      preserve inner text.
//   2. HTML sanitize via an allowlist (`bleach`-equivalent: sanitize-html) with restrictive allowlist.
//   3. Detect lexical injection patterns -> injection_flags.
//
// Per ADR-0057: this module returns the sanitized body WITHOUT the trust wrapper. The downstream
// redactor (`redactChunk`) adds `<doc trust="untrusted">...</doc>` after sanitization. Chain order:
//     sanitizePage(page, { lastModifiedAt }) -> SanitizedPageV1.body (no wrapper)
//       -> redactChunk(sanitized.body) -> final chunk body (with wrapper)
//
// PURE: no I/O, no clock, no random. `lastModifiedAt` is caller-provided so the sanitizer remains
// pure (no clock dependency for replay safety in activities), exactly mirroring the Python signature.
//
// bleach -> sanitize-html parity (VERIFIED byte-for-byte against the live frozen Python over the
// allowlist + macro + idempotency corpus):
//   - bleach `strip=True` (drop disallowed tags, keep inner text) -> `disallowedTagsMode: 'discard'`.
//   - bleach KEEPS the text content of disallowed tags including <script>/<style> -> `nonTextTags: []`
//     (sanitize-html's default would discard <script>/<style> text; we override to match bleach).
//   - bleach `strip_comments=True` -> sanitize-html drops comments by default.
//   - bleach protocol allowlist (http/https/mailto on <a href>) -> allowedSchemes +
//     allowedSchemesAppliedToAttributes.
//   - bleach decodes/normalizes entities -> `parser: { decodeEntities: true }`.

import sanitizeHtml from "sanitize-html";

import { type ConfluencePageV1 } from "#contracts/confluence_sync.v1.js";
import { SanitizedPageV1 } from "#contracts/sanitized_page.v1.js";

import { PATTERN_SET_VERSION, detectInjectionFlags } from "./injection_patterns.js";

// Allowlist — mirrors sanitizer.py `_ALLOWED_TAGS` exactly.
const ALLOWED_TAGS: ReadonlyArray<string> = [
  "p",
  "br",
  "div",
  "span",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "code",
  "pre",
  "blockquote",
  "a",
  "em",
  "strong",
  "b",
  "i",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
];

// sanitizer.py `_ALLOWED_ATTRS`.
const ALLOWED_ATTRIBUTES: Record<string, Array<string>> = {
  a: ["href"],
  code: ["class"],
};

// sanitizer.py `_ALLOWED_PROTOCOLS`.
const ALLOWED_SCHEMES: ReadonlyArray<string> = ["http", "https", "mailto"];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedSchemes: [...ALLOWED_SCHEMES],
  allowedSchemesAppliedToAttributes: ["href"],
  disallowedTagsMode: "discard",
  // Match bleach: keep the text content of disallowed tags (including <script>/<style>).
  nonTextTags: [],
  parser: { decodeEntities: true },
};

// Confluence macro tags — strip the tag envelope; preserve inner text. Mirrors sanitizer.py
// `_AC_TAG_RE = re.compile(r"<(/?)ac:[^>]*?>", re.IGNORECASE | re.DOTALL)`:
//   - "i" = re.IGNORECASE
//   - "s" = re.DOTALL (so `.` matches newlines inside the tag)
//   - "g" = replace-all (re.sub replaces every match)
const AC_TAG_RE = /<(\/?)ac:[^>]*?>/gis;

/** Unwrap Confluence <ac:*> tags. Preserves inner text; drops the macro envelope. */
function stripConfluenceMacros(body: string): string {
  return body.replace(AC_TAG_RE, "");
}

/**
 * Sanitize one Confluence page -> SanitizedPageV1.
 *
 * Per ADR-0057, the returned `body` does NOT include `<doc trust="untrusted">`; the downstream
 * redactor adds the wrapper.
 *
 * Idempotent: sanitizePage(sanitizePage(x).body) yields the same body. The macro-strip + sanitize
 * pipeline converges after one pass.
 *
 * @param page Raw ConfluencePage v2 from the Confluence client (the parsed ConfluencePageV1 shape).
 * @param lastModifiedAt tz-aware instant; caller-provided so the sanitizer stays pure.
 */
export function sanitizePage(
  page: ConfluencePageV1,
  { lastModifiedAt }: { lastModifiedAt: Date },
): SanitizedPageV1 {
  let body = stripConfluenceMacros(page.body_html);
  body = sanitizeHtml(body, SANITIZE_OPTIONS);
  const flags = detectInjectionFlags(body);

  return SanitizedPageV1.parse({
    schema_version: 1,
    page_id: page.page_id,
    space_key: page.space_key,
    version: page.version,
    title: page.title,
    body,
    labels: page.labels,
    injection_flags: [...flags],
    status: page.status,
    last_modified_at: lastModifiedAt.toISOString(),
    pattern_set_version: PATTERN_SET_VERSION,
  });
}
