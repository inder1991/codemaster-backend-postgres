/**
 * `updatePrDescriptionSummary` activity — GET-modify-PATCHes the PR DESCRIPTION (a metadata field —
 * CLAUDE.md invariant 9: the bot
 * edits the description, NOT the review event; it stays advisory, never APPROVE/REQUEST_CHANGES):
 *
 *   1. GET the current PR body via the GitHub API.
 *   2. Strip any existing codemaster summary block (HTML-comment-delimited).
 *   3. Compose a new summary block from the AggregatedFindingsV1.
 *   4. PATCH the PR body with the original-author content + the new summary block appended.
 *
 * ## Idempotency via HTML-comment markers
 *
 * The {@link SUMMARY_START} / {@link SUMMARY_END} markers make the operation idempotent — re-runs (a
 * Temporal retry) strip the prior block in place via {@link SUMMARY_BLOCK_RE} (DOTALL, non-greedy) and
 * re-emit cleanly rather than duplicating the section. The marker delimiter strings are pinned by the
 * Tier-1 parity oracle so a body written by any worker version strips correctly.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The single positional input is the {@link UpdatePrDescriptionInputV1} envelope (closes the
 * invariant-11 violation of the prior four positional arguments).
 *
 * ## Pure logic vs. real wiring (the stub-vs-real test split)
 *
 * {@link stripExistingSummary} / {@link buildSummaryMarkdown} / {@link composeNewBody} are the pure
 * helpers — the Tier-1 parity oracle drives them so the strip+recompose + summary RENDER are
 * byte-verifiable WITHOUT any real GitHub round-trip. {@link doUpdatePrDescriptionSummary} is the pure
 * GET-modify-PATCH choreography with the {@link GhPrDescriptionClient} INJECTED. {@link updatePrDescriptionSummary}
 * is the registered activity that constructs the REAL {@link GitHubApiPrDescriptionClient} over a
 * {@link GitHubApiClient} (Vault token provider + env installation id).
 *
 * ## Failure semantics
 *
 * Per the frozen activity's AC3, a failure here does NOT fail the workflow — the workflow body's
 * `stage_outcome` wrapper logs + swallows (the already-posted review is the value; the description
 * appendage is polish). That wrapping lives in the workflow body (the Workflow phase wires this activity
 * in), NOT here: this activity raises on a GitHub error and the caller decides
 * the workflow-liveness posture.
 */

import { FetchGitHubHttpClient, GitHubApiClient } from "#backend/integrations/github/api_client.js";
import {
  GitHubApiPrDescriptionClient,
  type GhPrDescriptionClient,
} from "#backend/integrations/github/pr_description_client.js";
import { GitHubAppTokenProvider } from "#backend/integrations/github/token_provider.js";
import { VaultHttpPort } from "#backend/adapters/vault_http.js";

import { WallClock } from "#platform/clock.js";

import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import type { UpdatePrDescriptionInputV1 } from "#contracts/update_pr_description.v1.js";

// ─── Marker delimiters ────────────────────────────────────────────────────────────────────────────

/** HTML-comment markers delimiting the codemaster summary block. Pinned by the Tier-1 parity oracle. */
export const SUMMARY_START = "<!-- codemaster-summary-start -->";
export const SUMMARY_END = "<!-- codemaster-summary-end -->";

/**
 * Match the markers + everything between them; DOTALL (`s` flag) so newlines are captured, non-greedy
 * (`.*?`) so a body with two stray blocks strips each independently. Used to strip the prior summary so
 * we re-emit cleanly. The marker strings contain no regex metacharacters once `?`/`!`/`-` are
 * considered, but the markers are embedded via escaped literals for safety (the `-`/`!`/`?` inside
 * `<!-- ... -->` are not special outside a class, so the escaped + un-escaped forms compile identically;
 * the test pins the strip behaviour regardless).
 */
// Both operands are re.escape'd module constants (no user input); the pattern is anchored on fixed
// literal markers + a single bounded `.*?`, so there is no ReDoS surface. Derived from the constants
// (not duplicated) to keep the strip regex in lock-step with the delimiter strings.
export const SUMMARY_BLOCK_RE =
  // eslint-disable-next-line security/detect-non-literal-regexp -- see note above (escaped constants only)
  new RegExp(`${escapeRegExp(SUMMARY_START)}.*?${escapeRegExp(SUMMARY_END)}`, "gs");

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(literal: string): string {
  // Escape every ASCII regex metacharacter (conservative: all non word/space chars). The `g` flag on
  // SUMMARY_BLOCK_RE makes `.replace` strip ALL blocks, so the non-greedy + global combination strips
  // every summary block from the body.
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Pure helpers (testable without GitHub) ───────────────────────────────────────────────────────

/**
 * Remove any prior codemaster summary block in-place.
 *
 * Pure helper; safe to call when no block exists (returns `body` with trailing whitespace trimmed).
 * Trims trailing whitespace introduced by the removal so re-emitted blocks don't accumulate blank lines
 * on repeated runs.
 */
export function stripExistingSummary(body: string): string {
  const cleaned = body.replace(SUMMARY_BLOCK_RE, "");
  // Drop trailing whitespace the strip introduced so re-emitted blocks don't accumulate blank lines.
  // The `u`-aware `\s` class covers space/tab/newline/CR/FF/VT + the Unicode space separators, which is
  // the full trailing-whitespace set for the bodies this sees (markdown text).
  return rstrip(cleaned);
}

/** Strip trailing whitespace per the Unicode whitespace set. */
function rstrip(value: string): string {
  return value.replace(/\s+$/u, "");
}

/**
 * Render the markdown summary block from the aggregated findings.
 *
 * Sections are grouped by `finding.category` and counts are sorted descending so the most-frequent
 * category leads; ties break by FIRST-ENCOUNTERED order in the findings tuple (insertion-order-stable
 * via {@link mostCommon}). When `findings` is empty the summary still renders — visibility that the bot
 * ran is itself signal.
 */
export function buildSummaryMarkdown(findings: ReadonlyArray<ReviewFindingV1>): string {
  const byCategory = counter(findings.map((f) => f.category));

  const lines: Array<string> = [SUMMARY_START, "", "## 🤖 Summary by codemaster", ""];
  if (findings.length === 0) {
    lines.push("_No findings — looks good!_");
  } else {
    lines.push(`**${findings.length} finding(s) detected.** Breakdown:`);
    lines.push("");
    for (const [category, count] of mostCommon(byCategory)) {
      lines.push(`- **${pyTitle(category)}**: ${count}`);
    }
  }
  lines.push("", SUMMARY_END);
  return lines.join("\n");
}

/**
 * Compose the PATCH'd PR body: original-author content + summary. `originalBody` is what the developer
 * wrote — preserved verbatim above the markers. Existing summary blocks (from prior runs) are stripped
 * first so the appendage stays in place rather than accumulating duplicates. GitHub returns the body as
 * null when the developer left it blank; the GhPrDescriptionClient collapses that to "" upstream.
 */
export function composeNewBody({
  originalBody,
  summaryMarkdown,
}: {
  originalBody: string;
  summaryMarkdown: string;
}): string {
  // `originalBody` is already a string here (the client collapses null → ""); an empty string strips to
  // an empty string, so no null-coalescing guard is needed on this typed surface.
  let base = stripExistingSummary(originalBody);
  if (base !== "" && !base.endsWith("\n")) {
    base = `${base}\n`;
  }
  return `${base}\n${summaryMarkdown}\n`;
}

// ─── counting / ranking / title-casing helpers ────────────────────────────────────────────────────

/**
 * Count occurrences, preserving FIRST-INSERTION order of keys (a JS `Map` is insertion-ordered).
 */
function counter(values: ReadonlyArray<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

/**
 * Return [key, count] pairs sorted by count DESCENDING, ties broken by FIRST-INSERTION order. A stable
 * sort by `-count` over the Map's insertion-ordered entries gives that tie-break for free.
 */
function mostCommon(counts: Map<string, number>): Array<[string, number]> {
  const entries = [...counts.entries()];
  // Array.prototype.sort is stable (ECMAScript 2019+), so entries with equal counts keep their
  // insertion order — that IS the tie-break.
  entries.sort((a, b) => b[1] - a[1]);
  return entries;
}

/**
 * Title-case: uppercase the first CASED character of each "word" and lowercase the rest, where a word
 * boundary is any non-cased (non-alphabetic, per Unicode) character. For the constrained `Category`
 * enum (all-lowercase ASCII letters + `_`) the only boundary is `_`, so e.g.
 * `context_breaks_consumer` → `Context_Breaks_Consumer`. The general algorithm is kept so the render
 * stays correct if the category vocabulary ever widens.
 */
export function pyTitle(value: string): string {
  let previousIsCased = false;
  let out = "";
  for (const ch of value) {
    if (isCased(ch)) {
      out += previousIsCased ? ch.toLowerCase() : ch.toUpperCase();
      previousIsCased = true;
    } else {
      out += ch;
      previousIsCased = false;
    }
  }
  return out;
}

/**
 * Whether a single-codepoint string has a distinct upper- and lower-case form (boundary predicate for
 * {@link pyTitle}). Caseless letters (e.g. CJK) and non-letters (digits, `_`, space, punctuation) are
 * NOT cased and act as word separators.
 */
function isCased(ch: string): boolean {
  return ch.toUpperCase() !== ch.toLowerCase();
}

// ─── GET-modify-PATCH choreography (pure; client INJECTED) ────────────────────────────────────────

/**
 * GET-modify-PATCH choreography with the {@link GhPrDescriptionClient} INJECTED so the activity's
 * read-modify-write LOGIC is testable against a recording stub / cassette transport without a real
 * GitHub round-trip. `installationId` is threaded into both client calls.
 */
export async function doUpdatePrDescriptionSummary({
  owner,
  repo,
  prNumber,
  aggregated,
  ghClient,
  installationId,
}: {
  owner: string;
  repo: string;
  prNumber: number;
  aggregated: UpdatePrDescriptionInputV1["aggregated"];
  ghClient: GhPrDescriptionClient;
  installationId: number;
}): Promise<void> {
  const originalBody = await ghClient.getPullRequestBody({
    installationId,
    owner,
    repo,
    prNumber,
  });
  const summary = buildSummaryMarkdown(aggregated.findings);
  const newBody = composeNewBody({ originalBody, summaryMarkdown: summary });
  await ghClient.patchPullRequestBody({
    installationId,
    owner,
    repo,
    prNumber,
    body: newBody,
  });
}

// ─── Env wiring + registered activity ─────────────────────────────────────────────────────────────

/**
 * The registered activity. Takes the single typed {@link UpdatePrDescriptionInputV1} envelope
 * (invariant 11), constructs the REAL {@link GitHubApiPrDescriptionClient} over a {@link GitHubApiClient}
 * (Vault token provider + the per-review numeric installation id from the input), and delegates to
 * {@link doUpdatePrDescriptionSummary}.
 */
export async function updatePrDescriptionSummary(input: UpdatePrDescriptionInputV1): Promise<void> {
  // Per-review routing: the numeric installation id comes from the input. Defensive null guard — the
  // PR-description update runs only after a successful review (post-clone), so this should never fire.
  const installationId = input.github_installation_id;
  if (installationId === null) {
    throw new Error(
      "github_installation_id is null in the update_pr_description_summary input — cannot patch the PR " +
        "description without a per-review installation id (per-review routing).",
    );
  }
  const clock = new WallClock();
  // One GitHub HTTP transport shared by the token-provider's JWT→installation-token mint AND the
  // GitHubApiClient's PR GET/PATCH calls. Vault is read via its own env-built transport.
  const githubHttp = new FetchGitHubHttpClient({});
  const vault = VaultHttpPort.fromEnv();
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({
    vault,
    http: githubHttp,
    clock,
  });
  const api = new GitHubApiClient({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
    http: githubHttp,
    clock,
  });
  const ghClient = new GitHubApiPrDescriptionClient({ api, installationId });

  await doUpdatePrDescriptionSummary({
    owner: input.owner,
    repo: input.repo,
    prNumber: input.pr_number,
    aggregated: input.aggregated,
    ghClient,
    installationId,
  });
}
