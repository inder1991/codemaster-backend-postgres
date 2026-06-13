/**
 * CODEOWNERS parser — pure function. Parses GitHub's `CODEOWNERS` file format into rules of
 * `(path_pattern, owner_logins,
 * line_number)`.
 *
 * Spec: https://docs.github.com/en/repositories/managing-your-repositories-settings-and-features/customizing-your-repository/about-code-owners
 *
 * Format (per GitHub spec):
 *  - One rule per line: `<pattern> <owner1> <owner2> ...`.
 *  - Patterns are gitignore-style globs (NOT shell globs — `*` does NOT cross `/`; `**` matches across
 *    path segments). The parser does not interpret the glob; it stores the raw pattern token verbatim.
 *  - Owners are `@user` or `@org/team` references. The leading `@` is preserved in the parsed output so
 *    consumers can distinguish individuals from teams via the slash.
 *  - Lines beginning with `#` are comments + ignored; `#` anywhere strips the inline remainder.
 *  - Blank lines + whitespace-only lines are ignored.
 *  - The LAST matching rule for a file wins (per GitHub semantics); the parser returns rules in
 *    source-file order so the consumer reverses + first-match wins to honour this.
 *
 * The parser does NOT validate that the named users / teams actually exist — that is a separate concern
 * handled by the suggested-reviewer router (which falls back to "no suggestion" on missing users).
 *
 * The `CodeOwnerRule` output shape is REUSED from `#backend/domain/repos/code_owners_repo.js` (the same
 * type the repo's `listRulesForRepository` returns and the `rank_suggested_reviewers` ranker consumes).
 */

import type { CodeOwnerRule } from "#backend/domain/repos/code_owners_repo.js";

export type { CodeOwnerRule };

// Owner reference: must start with `@`. Captures user (`@name`) or team (`@org/team`). Permissive on the
// right side because GitHub's username/team grammar allows letters, digits, hyphens, underscores, slashes,
// dots. Permissive on the right side to cover GitHub's username/team grammar.
const OWNER_RE = /^@[A-Za-z0-9_./-]+$/;

/**
 * Parse a CODEOWNERS file body. Returns rules in source-file order.
 *
 * Malformed lines (no owners, owners with invalid `@` form, fewer than 2 tokens) are silently dropped —
 * GitHub's own behaviour.
 */
export function parseCodeowners(text: string): ReadonlyArray<CodeOwnerRule> {
  if (!text) {
    return [];
  }

  const rules: Array<CodeOwnerRule> = [];
  // Python `str.splitlines()` splits on \n, \r\n, \r and DROPS a trailing line terminator (no empty final
  // element). `split(/\r\n|\r|\n/)` matches that universe of line boundaries; the per-line `.trim()` +
  // empty-skip below absorbs the one shape that differs (a trailing newline → trailing "" element), so
  // the rule set is identical to Python's.
  const lines = text.split(/\r\n|\r|\n/);
  for (const [i, raw] of lines.entries()) {
    // Strip inline comments. CODEOWNERS treats `#` as a comment marker anywhere on the line.
    const commentStart = raw.indexOf("#");
    const line = (commentStart >= 0 ? raw.slice(0, commentStart) : raw).trim();
    if (line === "") {
      continue;
    }

    // A valid CODEOWNERS line is `<pattern> <owner> [<owner>...]`; at least pattern + one owner. Python
    // `line.split()` splits on ANY run of whitespace and drops empties, so split on /\s+/ over the trimmed
    // line (already free of leading/trailing whitespace) yields the same token list.
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) {
      continue;
    }

    const pattern = tokens[0]!;
    const owners: Array<string> = [];
    for (const tok of tokens.slice(1)) {
      if (OWNER_RE.test(tok)) {
        owners.push(tok);
      }
    }
    if (owners.length === 0) {
      continue;
    }

    rules.push({
      path_pattern: pattern,
      owner_logins: owners,
      line_number: i + 1, // 1-indexed source-file line for diagnostics
    });
  }

  return rules;
}
