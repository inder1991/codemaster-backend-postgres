/**
 * Confluence label canonicalization — 1:1 TypeScript port of the frozen Python
 * `vendor/codemaster-py/codemaster/retrieval/label_taxonomy.py` (Sub-spec A Task 1).
 *
 * Ported as a dependency of {@link ../domain/repos/confluence_chunks_repo.ts}'s `upsertChunks`, which
 * canonicalizes each raw Confluence label before persisting it (the `confluence_chunks_labels_canonical`
 * CHECK constraint requires canonical forms). Pure function over a static RECOGNITION_MAP — no wiring.
 */

/** bumped from Sub-spec 0 stub's 0 (Python TAXONOMY_VERSION). */
export const TAXONOMY_VERSION = 1 as const;

/** Python `CANONICAL_LABEL_REGEX`. */
const CANONICAL_LABEL_REGEX =
  /^(default|(lang|framework|infra|topic|org|version|unrecognized):[a-z][a-z0-9_-]*)$/;

/**
 * Python `RECOGNITION_MAP` — raw label → canonical form. A `Map` (not a plain object) so the
 * untrusted-key lookup in {@link canonicalize} is not a prototype-pollution object-injection sink.
 */
const RECOGNITION_MAP: ReadonlyMap<string, string> = new Map([
  // Languages
  ["python", "lang:python"],
  ["py", "lang:python"],
  ["typescript", "lang:typescript"],
  ["ts", "lang:typescript"],
  ["javascript", "lang:javascript"],
  ["js", "lang:javascript"],
  ["go", "lang:go"],
  ["golang", "lang:go"],
  ["rust", "lang:rust"],
  ["java", "lang:java"],
  ["kotlin", "lang:kotlin"],
  ["kt", "lang:kotlin"],
  ["ruby", "lang:ruby"],
  ["scala", "lang:scala"],
  // Frameworks
  ["fastapi", "framework:fastapi"],
  ["django", "framework:django"],
  ["flask", "framework:flask"],
  ["react", "framework:react"],
  ["nextjs", "framework:nextjs"],
  ["next", "framework:nextjs"],
  ["preact", "framework:preact"],
  ["solid", "framework:solid"],
  ["spring", "framework:spring"],
  ["springboot", "framework:spring"],
  // Infrastructure
  ["terraform", "infra:terraform"],
  ["tf", "infra:terraform"],
  ["helm", "infra:helm"],
  ["kubernetes", "infra:kubernetes"],
  ["k8s", "infra:kubernetes"],
  ["docker", "infra:docker"],
  ["argocd", "infra:argocd"],
  // Topics
  ["security", "topic:security"],
  ["security_policy", "topic:security_policy"],
  ["securitypolicy", "topic:security_policy"],
  ["performance", "topic:performance"],
  ["accessibility", "topic:accessibility"],
  ["a11y", "topic:accessibility"],
  ["observability", "topic:observability"],
  ["compliance", "topic:compliance"],
  // Sentinel
  ["default", "default"],
]);

/** Python `_KNOWN_CANONICAL = frozenset(RECOGNITION_MAP.values())`. */
const KNOWN_CANONICAL: ReadonlySet<string> = new Set(RECOGNITION_MAP.values());

/**
 * Confluence raw label → canonical form (1:1 with the Python `canonicalize`).
 *
 * Lookup order:
 *   1. Empty / whitespace-only → 'unrecognized:empty'
 *   2. Already-canonical (in RECOGNITION_MAP values, or matches CANONICAL_LABEL_REGEX) → passthrough
 *   3. Known raw key in RECOGNITION_MAP → mapped value
 *   4. Version heuristic ('pythonv1', 'k8s_v1', etc.) → 'version:<lowered>'
 *   5. Anything else → 'unrecognized:<sanitized>'
 */
export function canonicalize(rawLabel: string | null | undefined): string {
  if (rawLabel === null || rawLabel === undefined || rawLabel.trim() === "") {
    return "unrecognized:empty";
  }
  const lowered = rawLabel.trim().toLowerCase();
  if (KNOWN_CANONICAL.has(lowered) || CANONICAL_LABEL_REGEX.test(lowered)) {
    return lowered;
  }
  const mapped = RECOGNITION_MAP.get(lowered);
  if (mapped !== undefined) {
    return mapped;
  }
  // Python: re.match(r"^([a-z][a-z0-9_]*?)v(\d+)$", lowered) — anchored at the start (match, not search).
  if (/^[a-z][a-z0-9_]*?v\d+$/.test(lowered)) {
    return `version:${lowered}`;
  }
  let safe = lowered.replace(/[^a-z0-9_-]/g, "_");
  // Python: `if not safe or not safe[0].isalpha()` — first char must be an ASCII letter.
  if (safe === "" || !/^[a-z]/.test(safe)) {
    safe = safe !== "" ? `x_${safe}` : "x";
  }
  return `unrecognized:${safe}`;
}
