/**
 * `citationValidate` activity — thin wrapper around {@link CitationValidator}`.validate()`.
 *
 * ## Why this is an ACTIVITY (the sandbox boundary)
 *
 * The validator's `repoPathExists` helper does REAL filesystem syscalls (`existsSync`/`statSync`/
 * `realpathSync`), which are RESTRICTED inside the Temporal workflow V8-isolate sandbox (deterministic +
 * I/O-free for replay). Wrapping the call in an activity moves the fs-touching work to the NORMAL Node
 * activity-task-queue runtime. The activity builds a fresh validator scoped to `input.workspace_path`
 * on every call (NOT a shared instance).
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The single positional input is the {@link CitationValidateInputV1} envelope. The tri-stated
 * `knowledge_chunk_ids` (`null` = skip-mode, array = strict membership) and `policy_citation`
 * (`null` = skip-mode, context = observe/enforce) travel as the envelope's nullable fields.
 *
 * ## Timeout sizing
 *
 * `start_to_close_timeout` (set at the workflow body's execute_activity call site) was sized at 30s for
 * the M-A3 cap of 300 findings x ~4 syscalls per repo_path source. On a healthy filesystem this
 * completes in <2s; the 30s budget absorbs cold-cache / kind-cluster IO contention.
 *
 * ## Workflow-phase wiring boundary
 *
 * FOLLOW-UP-citation-validate-orchestrator-wiring: the worker registry / build_activities / activity_ports
 * / orchestrator are OWNED by the Workflow phase and are NOT touched here.
 */
import { CitationValidator } from "#backend/review/citation_validator.js";

import type { CitationValidateInputV1 } from "#contracts/citation_validate_input.v1.js";
import type { CitationValidationResultV1 } from "#contracts/citation_validation.v1.js";

/**
 * The registered activity: validate citations on each finding against `input.workspace_path` + the
 * tri-stated chunk-id / policy contexts, returning the {@link CitationValidationResultV1} (surviving +
 * dropped) envelope.
 *
 * Builds a FRESH {@link CitationValidator} per call (no shared state). The `knowledge_chunk_ids` array
 * (or `null`) becomes a Set (or `null` skip-mode); the `policy_citation` context (or `null`) is
 * threaded straight through. No `onWarn` sink is attached at the activity boundary — drop logging is a
 * pure side effect that does NOT alter the surviving/dropped partition, and the policy-mismatch counter
 * still fires inside the validator regardless.
 */
export async function citationValidate(
  input: CitationValidateInputV1,
): Promise<CitationValidationResultV1> {
  const validator = new CitationValidator({
    workspace: input.workspace_path,
    knowledgeChunkIds: input.knowledge_chunk_ids === null ? null : new Set(input.knowledge_chunk_ids),
    policyCitation: input.policy_citation,
  });
  return validator.validate(input.findings);
}
