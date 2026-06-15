/**
 * `generateFixPrompt` activity — builds a copy-pasteable Claude-Code fix prompt from the aggregated
 * findings — a DETERMINISTIC primary
 * section (`buildFixPromptDeterministic`) PLUS an ADDITIVE best-effort LLM theme-synthesis (the
 * `## Cross-cutting patterns` section); on any LLM failure the deterministic section still ships. Persists
 * the prompt via the ported `FixPromptRepo` and posts it as an advisory PR conversation-tab comment.
 *
 * ## Bound-method holder
 *
 * A {@link FixPromptActivities} class holds the injected collaborators, exposing `generateFixPrompt` as
 * an arrow property so it stays bound when the worker bootstrap destructures it into the activities map
 * (Temporal registers the function value directly, losing `this`). The Workflow phase wires the
 * construction in `build_activities.ts` (NOT this file — HARD RULE).
 *
 * ## Single typed input — CLAUDE.md invariant 11 / ADR-0047
 *
 * The single positional input is a {@link GenerateFixPromptInputV1} envelope (review identity + tenant + PR
 * coordinates + the aggregated findings). The Temporal DataConverter validates it through the Zod contract
 * on the wire, so the body never re-validates a raw dict.
 *
 * ## Runtime context
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. The LLM client, the
 * `pg.Pool` the repo opens (ADR-0062 shared seam), the GitHub HTTP client, and the wall clock all live
 * here, exactly like `generateWalkthrough`.
 *
 * ## Fail-open posture
 *
 *   - Empty findings → short-circuit, return `{ generated: false, generation_mode: "", comment_posted: false }`.
 *   - The LLM theme-synthesis is best-effort INSIDE `buildFixPrompt` (degrades to the deterministic base).
 *   - The PR comment POST is best-effort: a post failure is caught and `comment_posted=false` is returned;
 *     the review is NEVER failed (the persisted record still serves the API/UI). The comment is RENDERED
 *     before the try so a render bug propagates rather than masquerading as a GitHub-post failure.
 */

import { type Clock } from "#platform/clock.js";
import { uuid4 } from "#platform/randomness.js";

import type { FixPromptRepo } from "#backend/domain/repos/fix_prompt_repo.js";
import { recordFixPromptGenerated } from "#backend/observability/fix_prompt_metrics.js";
import {
  type LlmClientCacheLike,
  buildFixPrompt,
  renderFixPromptComment,
} from "#backend/review/fix_prompt/fix_prompt_theme_activity.js";
import type { PurposeModelResolverLike } from "#backend/llm/purpose_model_resolver.js";

import { FixPromptActivityResultV1 } from "#contracts/fix_prompt_activity_result.v1.js";
import type { GenerateFixPromptInputV1 } from "#contracts/generate_fix_prompt.v1.js";

/**
 * The GitHub issue-comment surface the activity needs — the slice of `GhReviewClient` it uses
 * (`createIssueComment` + `listIssueComments`). Kept loosely-typed (structural subset) so the activity
 * depends only on the two methods, keeping `gh_client` loosely typed to avoid
 * import weight. `listIssueComments` is the W3.3 operational-marker recovery oracle (F2): it lets a re-run
 * recover the id of a comment that was posted right before a crash (post succeeded, record crashed).
 */
export type FixPromptIssueCommentClient = {
  createIssueComment(args: {
    // Per-review routing: the numeric GitHub installation id the advisory comment posts under (per-call,
    // NOT bound at construction). DISTINCT from payload.installation_id (the internal UUID used for persist).
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<number>;
  // GET the PR conversation-tab (issue) comments; the marker filter happens here in the activity. Returns
  // the raw GitHub comment objects (each carries `id` + `body`) so the marker scan can recover a posted id.
  listIssueComments(args: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<Array<Record<string, unknown>>>;
};

/**
 * The hidden HTML-comment marker embedded in the fix-prompt PR comment body, keyed by `review_id`. It is
 * OPERATIONAL (W3.3 / F2): the recovery oracle for the "createIssueComment succeeded, crash before
 * recordCommentPosted" window. A re-run scans `listIssueComments` for this exact token; if found, it
 * recovers the comment id and records it instead of double-posting. Mirrors the review-body `markerFor`
 * convention (`<!-- codemaster:review-marker:{pr_id} -->`, post_review_results.activity.ts).
 */
export function fixPromptMarkerFor(reviewId: string): string {
  return `<!-- codemaster:fix-prompt-marker:${reviewId} -->`;
}

/**
 * Per-invocation tuning seam for the recoverable post claim. `claimTtlSeconds` defaults to the production
 * 120s (the claim TTL > the GitHub-post worst case, so the rare claim-expiry-mid-post double-post is
 * bounded — and even that is caught by the marker scan on the next run). Tests inject a tiny TTL (0s) to
 * exercise the expiry/reclaim path without a real-time sleep; production callers pass nothing.
 */
export type GenerateFixPromptOpts = {
  claimTtlSeconds?: number;
};

/** Production claim TTL: the in-flight GitHub-comment post lease lives this long before it is reclaimable
 *  by a re-run. > the GitHub-post worst case, so the rare claim-expiry-mid-post window is bounded. */
const DEFAULT_CLAIM_TTL_SECONDS = 120;

/**
 * Bound-method holder for the generate_fix_prompt activity. The worker bootstrap constructs it with
 * the shared ledger-wired {@link LlmClientCacheLike} (the fix_prompt purpose resolves to sonnet via the
 * central seed), the ported {@link FixPromptRepo}, the installation-bound issue-comment client, and the
 * shared clock; it registers the `generateFixPrompt` bound arrow property.
 */
export class FixPromptActivities {
  private readonly cache: LlmClientCacheLike;
  private readonly repo: FixPromptRepo;
  private readonly gh: FixPromptIssueCommentClient;
  private readonly clock: Clock;
  private readonly resolver: PurposeModelResolverLike | undefined;

  public constructor(args: {
    cache: LlmClientCacheLike;
    repo: FixPromptRepo;
    gh: FixPromptIssueCommentClient;
    clock: Clock;
    resolver?: PurposeModelResolverLike;
  }) {
    this.cache = args.cache;
    this.repo = args.repo;
    this.gh = args.gh;
    this.clock = args.clock;
    this.resolver = args.resolver;
  }

  /**
   * The activity (W3.3 / F2 / F3 / F5). Arrow property so it stays bound when destructured into the
   * worker activities map.
   *
   * ## Recoverable post claim + operational marker recovery (W3.3)
   *
   * The advisory PR comment is posted under a RECOVERABLE lease so a crash between any two steps can never
   * permanently lose OR duplicate the comment across re-runs:
   *   1. persist the fix-prompt record (idempotent upsert — serves the API/UI even if the post never lands).
   *   2. `signal?.aborted` → return (no NEW external side-effect after abort; gate ①).
   *   3. `isCommentPosted` → return (idempotency short-circuit; a re-run on a posted review does nothing).
   *   4. `claimCommentPost(owner, ttl)` → if LOST (a live concurrent claim) return (no double-post).
   *   5. `signal?.aborted` → return (re-check; the claim above is a recoverable lease — it expires).
   *   6. OPERATIONAL MARKER RECOVERY (F2): scan `listIssueComments` for this review's marker. If a prior
   *      attempt already posted (post succeeded, crash before record) → `recordCommentPosted(found.id)` and
   *      RETURN — ZERO new create. This closes the "post succeeded, DB record crashed" duplicate window.
   *   7. else `createIssueComment` (marker embedded) → on SUCCESS `recordCommentPosted`; on FAILURE the
   *      claim is LEFT to expire (we do NOT record), so a re-run reclaims it after TTL and recovers/reposts.
   *
   * `signal` is optional — the Temporal path passes none (it still dedupes + recovers). It is a separate
   * positional arg, NOT a field of the Zod wire contract (an AbortSignal cannot cross the Temporal activity
   * boundary; E1). `opts.claimTtlSeconds` is a test-only tuning seam (default 120s).
   */
  public readonly generateFixPrompt = async (
    payload: GenerateFixPromptInputV1,
    signal?: AbortSignal,
    opts?: GenerateFixPromptOpts,
  ): Promise<FixPromptActivityResultV1> => {
    // No findings → nothing to build. Short-circuit with the not-generated result (empty generation_mode).
    if (payload.aggregated.findings.length === 0) {
      return FixPromptActivityResultV1.parse({
        generated: false,
        generation_mode: "",
        comment_posted: false,
      });
    }

    const record = await buildFixPrompt({
      reviewId: payload.review_id,
      aggregated: payload.aggregated,
      prNumber: payload.pr_number,
      // TS hardening divergence (ADR-0068) — thread the REAL installation_id to the LLM client (cost-cap /
      // blob / telemetry). The fix_prompt call was previously platform-scoped (installation_id omitted).
      installationId: payload.installation_id,
      cache: this.cache,
      clock: this.clock,
      ...(this.resolver !== undefined ? { resolver: this.resolver } : {}),
    });

    await this.repo.persist(record, { installationId: payload.installation_id });
    recordFixPromptGenerated({
      generationMode: record.generation_mode,
      truncated: record.truncated,
    });

    const scope = { installationId: payload.installation_id };
    // Per-review routing: the advisory comment posts under the per-PR numeric installation id from the input.
    // A null id (a synthetic/legacy trigger) simply skips the comment; the persisted record still serves the
    // API/UI. With no GitHub installation there is no claim to take and no comment to recover.
    const ghInstallationId = payload.github_installation_id;
    if (ghInstallationId === null) {
      return FixPromptActivityResultV1.parse({
        generated: true,
        generation_mode: record.generation_mode,
        comment_posted: false,
      });
    }

    // Gate ①: no NEW external side-effect (claim, marker scan, post) starts after abort. The record above
    // is a local DB upsert, not a review-side-effect, so it is allowed pre-gate (matches doPost's posture).
    if (signal?.aborted) {
      return FixPromptActivityResultV1.parse({
        generated: true,
        generation_mode: record.generation_mode,
        comment_posted: false,
      });
    }

    // Idempotency short-circuit: a review whose comment is already posted needs no claim + no post.
    if (await this.repo.isCommentPosted(payload.review_id, scope)) {
      return FixPromptActivityResultV1.parse({
        generated: true,
        generation_mode: record.generation_mode,
        comment_posted: true,
      });
    }

    // Acquire the RECOVERABLE in-flight post lease. A unique per-invocation owner fences recordCommentPosted
    // to exactly this attempt. Losing the claim (a live concurrent attempt holds it) → skip the post (no
    // double-post); the holder will post + record.
    const owner = uuid4();
    const ttl = opts?.claimTtlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS;
    if (!(await this.repo.claimCommentPost(payload.review_id, owner, ttl, scope))) {
      return FixPromptActivityResultV1.parse({
        generated: true,
        generation_mode: record.generation_mode,
        comment_posted: false,
      });
    }

    // Re-check abort AFTER claiming — the claim is a recoverable lease (it expires), so bailing here strands
    // nothing; a later re-run reclaims it.
    if (signal?.aborted) {
      return FixPromptActivityResultV1.parse({
        generated: true,
        generation_mode: record.generation_mode,
        comment_posted: false,
      });
    }

    const marker = fixPromptMarkerFor(payload.review_id);

    // F2 OPERATIONAL MARKER RECOVERY — if a prior attempt's createIssueComment SUCCEEDED but crashed before
    // recordCommentPosted, the marked comment already exists remotely. Recover its id from the marker scan
    // and record it instead of double-posting.
    const existingId = await this.findPostedCommentByMarker({
      installationId: ghInstallationId,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
      marker,
    });
    if (existingId !== null) {
      await this.repo.recordCommentPosted(payload.review_id, owner, existingId, scope);
      return FixPromptActivityResultV1.parse({
        generated: true,
        generation_mode: record.generation_mode,
        comment_posted: true,
      });
    }

    // No prior post found → create the comment with the marker EMBEDDED (the recovery oracle for the next
    // re-run). On SUCCESS record the id (clears the lease). On FAILURE we deliberately do NOT record — the
    // lease is left to expire so a re-run reclaims it (and either finds the marker, if the post actually
    // landed, or re-posts). The post failure propagates so the runner re-drives the job.
    const commentBody = `${renderFixPromptComment(record.prompt)}\n\n${marker}`;
    const commentId = await this.gh.createIssueComment({
      installationId: ghInstallationId,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
      body: commentBody,
    });
    await this.repo.recordCommentPosted(payload.review_id, owner, commentId, scope);

    return FixPromptActivityResultV1.parse({
      generated: true,
      generation_mode: record.generation_mode,
      comment_posted: true,
    });
  };

  /**
   * F2 marker-recovery oracle: GET the PR's issue comments and return the GLOBAL id of the first comment
   * whose body contains this review's fix-prompt marker, or `null` if none. Defensive about the raw GitHub
   * comment shape (each entry is `Record<string, unknown>`): a malformed entry (missing/non-numeric id,
   * non-string body) is skipped rather than crashing the recovery scan.
   */
  private readonly findPostedCommentByMarker = async (args: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    marker: string;
  }): Promise<number | null> => {
    const comments = await this.gh.listIssueComments({
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
    });
    for (const c of comments) {
      const body = c["body"];
      const id = c["id"];
      if (typeof body === "string" && body.includes(args.marker) && typeof id === "number") {
        return id;
      }
    }
    return null;
  };
}
