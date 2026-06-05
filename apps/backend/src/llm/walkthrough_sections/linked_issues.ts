/**
 * Linked-issues walkthrough section — 1:1 TS port of the frozen Python
 * `codemaster/llm/walkthrough_sections/linked_issues.py` (Sprint 22 / S22.DM.16).
 *
 * Pure assembler. Maps parser output ({@link IssueLink} triples) → the walkthrough's
 * {@link LinkedIssueV1} envelope tuple, layering a `(title, state)` resolver on top.
 *
 * Display order (per spec, ported exactly):
 *   - auto-closing kinds first (`closes` > `fixes` > `resolves`), issue number ASC within a kind,
 *   - `mentioned` links last, issue number ASC.
 *
 * Failure mode: when the GitHub lookup failed (rate-limited, not-found, …) the resolver has no entry
 * for that issue number; the assembled `LinkedIssueV1` carries `title=null, state=null` so the
 * renderer falls back to `#42 — (title unavailable)`.
 *
 * The frozen Python's `format_linked_issues_md` renderer is NOT ported here — it is a walkthrough-
 * rendering concern owned by a different module; this port covers ONLY the activity-consumed assembler
 * (`assemble_linked_issues`), 1:1 with the Python function the activity calls.
 */

import type { IssueLink, LinkageKind } from "#contracts/issue_link.v1.js";
import type { LinkedIssueV1 } from "#contracts/walkthrough.v1.js";

/**
 * Display ordering for `linkage_kind`. `closes` > `fixes` > `resolves` > `mentioned`. Within each
 * band, sort by issue number ascending so reviewers see #1 before #5 — deterministic regardless of
 * parse order. 1:1 with the Python `_KIND_RANK` dict.
 */
const KIND_RANK: Readonly<Record<LinkageKind, number>> = {
  closes: 0,
  fixes: 1,
  resolves: 2,
  mentioned: 3,
};

/** Lower rank wins (sorts first). Unknown kinds fall back to 99 (mirrors the Python `.get(..., 99)`). */
function rankOf(kind: string): number {
  return Object.prototype.hasOwnProperty.call(KIND_RANK, kind)
    ? KIND_RANK[kind as LinkageKind]
    : 99;
}

function sortKey(link: LinkedIssueV1): readonly [number, number] {
  return [rankOf(link.linkage_kind), link.issue_number];
}

/** A `(title, state)` resolver entry — `null` parts encode an unresolved GitHub lookup. */
export type TitleStateEntry = readonly [string | null, "open" | "closed" | null];

/**
 * Map parser output → walkthrough envelope, with title + state populated from the resolver. 1:1 with
 * the Python `assemble_linked_issues`.
 *
 * The resolver maps `issue_number` → `(title, state)`. Missing keys produce
 * `{ title: null, state: null }` — graceful degradation.
 *
 * Cross-source dedup: an issue mentioned in BOTH description AND title produces ONE walkthrough entry,
 * not two. The strongest linkage kind wins (`closes` ranks BELOW `mentioned` in `KIND_RANK` = HIGHER
 * priority); within equal-rank ties, first-seen wins (preserves source-file ordering — JS `Map`
 * preserves insertion order, matching the Python dict-insertion-order semantics).
 */
export function assembleLinkedIssues(args: {
  parsed: ReadonlyArray<IssueLink>;
  titleResolver?: ReadonlyMap<number, TitleStateEntry>;
}): Array<LinkedIssueV1> {
  const { parsed } = args;
  if (parsed.length === 0) {
    return [];
  }

  const resolver = args.titleResolver ?? new Map<number, TitleStateEntry>();

  // Cross-source dedup: keep the strongest linkage kind per issue number. Insertion order preserved
  // so an equal-rank tie keeps the first-seen entry (the Python `dict` insertion-order semantics).
  const byIssue = new Map<number, LinkedIssueV1>();
  for (const link of parsed) {
    // IssueLink's field is `github_issue_number`; the walkthrough envelope uses the shorter
    // `issue_number` for display contexts. Bridge here, exactly as the Python does.
    const n = link.github_issue_number;
    const entry = resolver.get(n) ?? ([null, null] as const);
    const candidate: LinkedIssueV1 = {
      issue_number: n,
      linkage_kind: link.linkage_kind,
      title: entry[0],
      state: entry[1],
    };
    const existing = byIssue.get(n);
    if (existing === undefined || rankOf(candidate.linkage_kind) < rankOf(existing.linkage_kind)) {
      byIssue.set(n, candidate);
    }
  }

  return [...byIssue.values()].sort((a, b) => {
    const [ar, an] = sortKey(a);
    const [br, bn] = sortKey(b);
    return ar - br || an - bn;
  });
}
