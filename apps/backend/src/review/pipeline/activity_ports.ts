// activity_ports — the typed ReviewActivityPorts surface (finding 9: ONE typed input envelope per
// activity) + the per-activity RETRY_POLICIES constants transcribed 1:1 from the Python dispatch sites.
//
// SCOPE (Stage 0): this module DEFINES the ports TYPE + the retry/timeout constants ONLY. It does NOT call
// proxyActivities() — that requires the @temporalio/workflow runtime context (a workflow execution must be
// active) and lands in Stage 1's workflow body (review_pull_request.workflow.ts), which will:
//   const ports = makeReviewActivityPorts();   // proxyActivities<...>(...) per-activity with RETRY_POLICIES.X
// The orchestrator (Stage 1) calls ports.reviewChunk({...}) etc. — never positional args=[...].
//
// The RETRY_POLICIES values are LOAD-BEARING — they are the exact start_to_close_timeout + RetryPolicy
// (initial_interval, maximum_interval, backoff_coefficient, maximum_attempts, non_retryable_error_types,
// heartbeat_timeout) from the frozen Python bridge closures in
// vendor/codemaster-py/codemaster/workflows/review_pull_request.py. Each constant cites its source line.
//
// Duration shape: the TS SDK ActivityOptions accept either an ms number or a humanized string ("60s",
// "5 minutes"). We use the SDK's string form. Defaults the Python RetryPolicy leaves implicit (the SDK's
// backoff_coefficient default is 2.0, maximum_interval default is 100x the initial) are written out ONLY
// where the Python set them EXPLICITLY — leaving the rest to the SDK defaults so we don't silently encode
// a different curve than the Python's. Where the Python omitted a field, this constant omits it too.
//
// SANDBOX SAFETY (ADR-0065/0066): pure data + a type. NO node:crypto / uuid / clock / RNG / timers. No
// runtime imports beyond type-only contract imports.

import type { ClonedRepoV1 } from "#contracts/cloned_repo.v1.js";
import type { CloneRepoIntoWorkspaceInput } from "#contracts/clone_repo_into_workspace_input.v1.js";
import type { FileRoutingV1 } from "#contracts/file_routing.v1.js";
import type { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import type { ChangedLineRange } from "#contracts/chunk_and_redact.v1.js";
import type { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";
import type { CarryForwardSelectionV1 } from "#contracts/carry_forward.v1.js";
import type { EmbedQueryInputV1, EmbedQueryResultV1 } from "#contracts/embed_query.v1.js";
import type {
  RetrieveKnowledgeInputV1,
  RetrieveKnowledgeResultV1,
} from "#contracts/retrieve_knowledge.v1.js";
import type { ReviewContextV1 } from "#contracts/review_context.v1.js";
import type { ReviewChunkResponseV1 } from "#contracts/review_chunk_response.v1.js";
import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import type { WalkthroughV1, PrMetaV1, LinkedIssueV1 } from "#contracts/walkthrough.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import type { PostReviewInputV1 } from "#contracts/post_review_input.v1.js";
import type { PostedReviewV1 } from "#contracts/posted_review.v1.js";
import type { ReleaseWorkspaceInput } from "#contracts/release_workspace_input.v1.js";

/** changed_line_ranges wire shape: dict[str, tuple[tuple[int,int], ...]] → keyed by relative path,
 *  ChangedLineRange is the [start, end] tuple ported in chunk_and_redact.v1.ts. Matches the existing TS
 *  activity-side type (`Readonly<Record<string, ReadonlyArray<...>>>`). */
export type ChangedLineRanges = Readonly<Record<string, ReadonlyArray<ChangedLineRange>>>;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Per-activity input envelopes (finding 9). Some activities already have a single typed Pydantic/Zod
// input (clone, embedQuery, retrieveKnowledge, reviewChunk, postReview, cleanup) — those reuse the
// contract type directly. The remaining ones (classify, chunkAndRedact, staticAnalysis, selectCarryForward,
// aggregate, generateWalkthrough, postCheckRun) dispatch via positional args=[...] in the Python; finding 9
// collapses each into ONE typed envelope so the orchestrator never passes positional args. The field names
// mirror the Python positional argument names at each dispatch site.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type ClassifyInput = {
  workspacePath: string;
  files: ReadonlyArray<string>;
};

export type ChunkAndRedactInput = {
  workspacePath: string;
  files: ReadonlyArray<string>;
  ranges: ChangedLineRanges;
};

export type StaticAnalysisInput = {
  workspacePath: string;
  files: ReadonlyArray<string>;
  ranges: ChangedLineRanges;
  prMeta: PrMetaV1;
};

export type SelectCarryForwardInput = {
  parentFindings: ReadonlyArray<ReviewFindingV1>;
  currentChunks: ReadonlyArray<DiffChunkV1>;
  changedLineRanges: ChangedLineRanges;
  parentReviewId: string | null;
};

export type AggregateInput = {
  findings: ReadonlyArray<ReviewFindingV1>;
  policyRevision: number;
};

export type GenerateWalkthroughInput = {
  prMeta: PrMetaV1;
  aggregated: AggregatedFindingsV1;
  linkedIssues: ReadonlyArray<LinkedIssueV1>;
  suggestedReviewers: ReadonlyArray<string>;
};

export type PostCheckRunInput = {
  prMeta: PrMetaV1;
  headSha: string;
  summary: string;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ReviewActivityPorts — the typed spine activity surface. Stage 1 wires these to proxyActivities(); Stage
// 2-5 ports are added incrementally (mutex/lifecycle/enrichment/arbitration/fix-prompt) as their contracts
// land. Each method takes exactly ONE typed argument (invariant 11 / finding 9).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export type ReviewActivityPorts = {
  clone(input: CloneRepoIntoWorkspaceInput): Promise<ClonedRepoV1>;
  classify(input: ClassifyInput): Promise<FileRoutingV1>;
  chunkAndRedact(input: ChunkAndRedactInput): Promise<ReadonlyArray<DiffChunkV1>>;
  staticAnalysis(input: StaticAnalysisInput): Promise<StaticAnalysisResultV1>;
  selectCarryForward(input: SelectCarryForwardInput): Promise<CarryForwardSelectionV1>;
  embedQuery(input: EmbedQueryInputV1): Promise<EmbedQueryResultV1>;
  retrieveKnowledge(input: RetrieveKnowledgeInputV1): Promise<RetrieveKnowledgeResultV1>;
  reviewChunk(input: ReviewContextV1): Promise<ReviewChunkResponseV1>;
  aggregate(input: AggregateInput): Promise<AggregatedFindingsV1>;
  generateWalkthrough(input: GenerateWalkthroughInput): Promise<WalkthroughV1>;
  postReview(input: PostReviewInputV1): Promise<PostedReviewV1>;
  postCheckRun(input: PostCheckRunInput): Promise<unknown>;
  cleanup(input: ReleaseWorkspaceInput): Promise<void>;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// RETRY_POLICIES — the EXACT per-activity Temporal ActivityOptions (timeout + retry curve) from the
// Python bridge closures. The shape matches @temporalio/workflow's ActivityOptions so Stage 1 can spread
// each directly into proxyActivities(). Field names use the SDK's camelCase
// (startToCloseTimeout / heartbeatTimeout / scheduleToCloseTimeout / retry.{initialInterval,
// maximumInterval, backoffCoefficient, maximumAttempts, nonRetryableErrorTypes}).
//
// We model the shape locally (RetryActivityOptions) rather than importing ActivityOptions from
// @temporalio/workflow — that import is only valid inside a workflow runtime context and Stage 0 must stay
// runtime-free. Stage 1 asserts assignability when it spreads these into proxyActivities().
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export type RetryActivityOptions = {
  startToCloseTimeout?: string;
  heartbeatTimeout?: string;
  scheduleToCloseTimeout?: string;
  retry?: {
    initialInterval?: string;
    maximumInterval?: string;
    backoffCoefficient?: number;
    maximumAttempts?: number;
    nonRetryableErrorTypes?: ReadonlyArray<string>;
  };
};

export const RETRY_POLICIES = {
  // clone_repo_into_workspace (review_pull_request.py:1084-1088): start_to_close 60s,
  // heartbeat_timeout 30s (_CLONE_HEARTBEAT_TIMEOUT, BF-11), retry initial_interval=2s, max_attempts=3.
  clone: {
    startToCloseTimeout: "60s",
    heartbeatTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // classify_files (review_pull_request.py:1105-1108): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3.
  classify: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // chunk_and_redact_activity (review_pull_request.py:1126-1129): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3.
  chunkAndRedact: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // static_analysis_activity (review_pull_request.py:1445-1448): start_to_close 120s,
  // retry initial_interval=2s, max_attempts=2.
  staticAnalysis: {
    startToCloseTimeout: "120s",
    retry: { initialInterval: "2s", maximumAttempts: 2 },
  },

  // select_carry_forward (review_pull_request.py:1478-1481): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3.
  selectCarryForward: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // embed_query_activity (review_pull_request.py:1671-1683): start_to_close 15s,
  // retry initial_interval=2s, maximum_interval=15s, backoff_coefficient=2.0, max_attempts=3 (R-16).
  embedQuery: {
    startToCloseTimeout: "15s",
    retry: {
      initialInterval: "2s",
      maximumInterval: "15s",
      backoffCoefficient: 2.0,
      maximumAttempts: 3,
    },
  },

  // retrieve_knowledge_activity (review_pull_request.py:1777-1791): start_to_close 20s,
  // retry initial_interval=2s, maximum_interval=20s, backoff_coefficient=2.0, max_attempts=3 (R-16).
  retrieveKnowledge: {
    startToCloseTimeout: "20s",
    retry: {
      initialInterval: "2s",
      maximumInterval: "20s",
      backoffCoefficient: 2.0,
      maximumAttempts: 3,
    },
  },

  // bedrock_review_chunk (review_pull_request.py:1897-1917): start_to_close 90s,
  // retry initial_interval=5s, maximum_interval=60s, backoff_coefficient=2.0, max_attempts=4,
  // non_retryable=[BedrockBudgetExceededError, BedrockOutputUnsafeError, BedrockInvalidRequestError].
  reviewChunk: {
    startToCloseTimeout: "90s",
    retry: {
      initialInterval: "5s",
      maximumInterval: "60s",
      backoffCoefficient: 2.0,
      maximumAttempts: 4,
      nonRetryableErrorTypes: [
        "BedrockBudgetExceededError",
        "BedrockOutputUnsafeError",
        "BedrockInvalidRequestError",
      ],
    },
  },

  // aggregate_findings (review_pull_request.py:1974-1977): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3.
  aggregate: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // generate_walkthrough (review_pull_request.py:2227-2228): start_to_close 60s,
  // WALKTHROUGH_RETRY_POLICY (review_pull_request.py:95-103): initial_interval=5s, max_attempts=2,
  // non_retryable=[LlmAuthError, LlmRoleNotConfiguredError, LlmRoleDisabledError].
  generateWalkthrough: {
    startToCloseTimeout: "60s",
    retry: {
      initialInterval: "5s",
      maximumAttempts: 2,
      nonRetryableErrorTypes: [
        "LlmAuthError",
        "LlmRoleNotConfiguredError",
        "LlmRoleDisabledError",
      ],
    },
  },

  // post_review_results (review_pull_request.py:2442-2451): start_to_close 60s,
  // retry initial_interval=2s, max_attempts=3,
  // non_retryable=[PrClosedError, PostReviewPermissionError, StaleWriteError].
  postReview: {
    startToCloseTimeout: "60s",
    retry: {
      initialInterval: "2s",
      maximumAttempts: 3,
      nonRetryableErrorTypes: ["PrClosedError", "PostReviewPermissionError", "StaleWriteError"],
    },
  },

  // post_check_run (review_pull_request.py:2865-2868): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3.
  postCheckRun: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // release_workspace_activity (review_pull_request.py:3253-3256): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=2.
  cleanup: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 2 },
  },

  // allocate_workspace_activity (review_pull_request.py:1049-1050): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3. (Not a ReviewActivityPorts method yet — the workspace
  // lifecycle wraps the orchestrator in Stage 2 — but its policy is load-bearing, so it is transcribed
  // here now alongside its spine siblings.)
  allocateWorkspace: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // emit_output_safety_audit_event_activity (review_pull_request.py:1505-1510): schedule_to_close 2min,
  // retry initial_interval=1s, maximum_interval=30s, max_attempts=5. (Idempotent audit emit; independent
  // retry budget so a failed audit-emit never re-triggers the upstream LLM call. Stage 3 surface — policy
  // transcribed now.)
  emitOutputSafetyAudit: {
    scheduleToCloseTimeout: "2 minutes",
    retry: { initialInterval: "1s", maximumInterval: "30s", maximumAttempts: 5 },
  },
} as const satisfies Record<string, RetryActivityOptions>;
