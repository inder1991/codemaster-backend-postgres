/**
 * `buildRetrievedEvidence` activity — assembles the per-chunk `Array<RetrievedEvidenceV1>` the LLM
 * is permitted to cite via `ReviewFindingV1.evidence_refs`, from the per-chunk inputs the workflow
 * body has already resolved:
 *
 *   1. chunk_body          — ALWAYS exactly 1 entry (the chunk under review; primary grounding).
 *   2. retrieved_knowledge — 1 entry per KnowledgeChunkV1 (BM25+ANN+RRF retrieval).
 *   3. tier1_finding       — 1 entry per AnalysisFindingV1 (ruff / eslint / gitleaks / …).
 *   4. pr_topology         — 1 entry per PRTopologyEntryV1 (v8 chunk-locality manifest).
 *   5. tool_status         — 1 entry per ToolStatusV1 (per-tool execution outcome).
 *
 * Entries are emitted in PRIORITY ORDER and the output is sliced to `max_entries` (default 100),
 * dropping the LOWEST-priority entries first.
 *
 * ## Why this is an ACTIVITY (the sandbox boundary)
 *
 * `mintEvidenceId` mints via `node:crypto.createHash`, which is RESTRICTED inside the Temporal
 * workflow V8-isolate sandbox (deterministic + I/O-free to preserve replay — the same restriction
 * that makes citation_validate / dedup_findings activities). Wrapping the producer in an activity
 * moves the crypto-minting work to the NORMAL Node activity runtime where `node:crypto` is
 * unrestricted.
 *
 * ## Replay-safety
 *
 * `mintEvidenceId` is a deterministic UUIDv5 (content-addressable over `source_type + sha256(parts)`);
 * this producer performs NO wall-clock / RNG / DB / network operations. Every call over the same
 * per-chunk inputs mints bit-identical ev_ids → stable across Temporal history replays.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047
 *
 * The single positional input is the {@link BuildRetrievedEvidenceInputV1} envelope.
 *
 * ## Runtime context
 *
 * Runs in the NORMAL Node activity runtime — NOT the workflow V8-isolate sandbox. The only side-effect
 * is the crypto hash inside `mintEvidenceId`. No clock, no random, no DB, no network.
 *
 * ## Workflow-phase wiring boundary
 *
 * FOLLOW-UP-build-retrieved-evidence-orchestrator-wiring: the worker registry / build_activities /
 * activity_ports / orchestrator are OWNED by the Workflow phase and are NOT touched here.
 */

import {
  mintEvidenceId,
  RetrievedEvidenceV1,
} from "#contracts/retrieved_evidence.v1.js";

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import type { BuildRetrievedEvidenceInputV1 } from "#contracts/build_retrieved_evidence_input.v1.js";
import type { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import type { KnowledgeChunkV1 } from "#contracts/knowledge_chunks.v1.js";
import type { PRTopologyEntryV1 } from "#contracts/pr_topology.v1.js";
import type { ToolStatusV1 } from "#contracts/tool_status.v1.js";

// Matches RetrievedEvidenceV1.excerpt max_length (the prompt renderer applies its own per-entry
// truncation on top of this).
const EXCERPT_CAP = 2000;

// Matches ReviewContextV1.retrieved_evidence max_length — the hard
// cap on the output array length when the input envelope omits `max_entries`.
export const DEFAULT_ENTRY_CAP = 100;

/**
 * One evidence entry for the chunk under review (ALWAYS emitted).
 *
 * Excerpt capped at 2000 chars (RetrievedEvidenceV1.excerpt max_length). The empty-body fallback
 * `(empty <chunk_kind>)` uses a plain Literal, e.g. `(empty hunk)`.
 */
function chunkBodyEvidence(chunk: DiffChunkV1): RetrievedEvidenceV1 {
  return RetrievedEvidenceV1.parse({
    evidence_id: mintEvidenceId("chunk_body", chunk.chunk_id),
    source_type: "chunk_body",
    chunk_id: chunk.chunk_id,
    path: chunk.path,
    excerpt: chunk.body ? chunk.body.slice(0, EXCERPT_CAP) : `(empty ${chunk.chunk_kind})`,
  });
}

/**
 * One evidence entry per retrieved knowledge chunk. Incl. R-20 empty-body fallback:
 * `(empty <doc_kind> knowledge chunk)`.
 */
function knowledgeEvidence(k: KnowledgeChunkV1): RetrievedEvidenceV1 {
  const excerpt = k.body ? k.body.slice(0, EXCERPT_CAP) : `(empty ${k.doc_kind} knowledge chunk)`;
  return RetrievedEvidenceV1.parse({
    evidence_id: mintEvidenceId("retrieved_knowledge", k.chunk_id),
    source_type: "retrieved_knowledge",
    knowledge_chunk_id: k.chunk_id,
    path: k.relative_path,
    excerpt,
  });
}

/** One evidence entry per Tier-1 static-analysis finding. */
function tier1Evidence(f: AnalysisFindingV1): RetrievedEvidenceV1 {
  // excerpt: `rule_id: message`, capped to 2000 (rule_id ≤ 200 + message ≤ 2000 + separator).
  const excerpt = `${f.rule_id}: ${f.message}`.slice(0, EXCERPT_CAP);
  return RetrievedEvidenceV1.parse({
    evidence_id: mintEvidenceId("tier1_finding", f.finding_id),
    source_type: "tier1_finding",
    path: f.file,
    excerpt,
  });
}

/** One evidence entry per PR topology manifest entry. `kind` is a plain Literal. */
function topologyEvidence(entry: PRTopologyEntryV1): RetrievedEvidenceV1 {
  return RetrievedEvidenceV1.parse({
    evidence_id: mintEvidenceId("pr_topology", entry.chunk_id),
    source_type: "pr_topology",
    chunk_id: entry.chunk_id,
    path: entry.path,
    excerpt: `${entry.kind} ${entry.path}:${entry.start_line}-${entry.end_line}`,
  });
}

/**
 * One evidence entry per Tier-1 tool execution status.
 *
 * Per R-21 the sequence `index` is part of the mint key so two ToolStatusV1 entries sharing
 * `(tool_name, status)` don't collide on ev_id; the rendered excerpt DROPS the index (an opaque
 * sequence number the LLM doesn't need to see). The mint call passes `index` as a number — `mintEvidenceId`
 * stringifies parts with `String(p)`, which renders the integer byte-for-byte into the ev_id key.
 */
function toolStatusEvidence(s: ToolStatusV1, index: number): RetrievedEvidenceV1 {
  return RetrievedEvidenceV1.parse({
    evidence_id: mintEvidenceId("tool_status", s.tool_name, s.status, index),
    source_type: "tool_status",
    excerpt: `${s.tool_name} ${s.status}`,
  });
}

/**
 * The `build_retrieved_evidence` core (priority assembly + lowest-priority-first cap).
 *
 * Builds per-source-type entries in priority order (chunk_body → retrieved_knowledge → tier1_finding →
 * pr_topology → tool_status), then slices to `maxEntries` so the tail (= lowest priority) is dropped.
 *
 * Exported so the Tier-1 parity oracle can drive the same logic the activity runs.
 */
export function buildRetrievedEvidenceEntries(args: {
  readonly chunk: DiffChunkV1;
  readonly retrievedKnowledge?: ReadonlyArray<KnowledgeChunkV1>;
  readonly tier1Findings?: ReadonlyArray<AnalysisFindingV1>;
  readonly toolStatuses?: ReadonlyArray<ToolStatusV1>;
  readonly prTopologyManifest?: ReadonlyArray<PRTopologyEntryV1>;
  readonly maxEntries?: number;
}): Array<RetrievedEvidenceV1> {
  const retrievedKnowledge = args.retrievedKnowledge ?? [];
  const tier1Findings = args.tier1Findings ?? [];
  const toolStatuses = args.toolStatuses ?? [];
  const prTopologyManifest = args.prTopologyManifest ?? [];
  const maxEntries = args.maxEntries ?? DEFAULT_ENTRY_CAP;

  const byPriority: Array<RetrievedEvidenceV1> = [];
  // 1. chunk_body — always exactly 1 entry.
  byPriority.push(chunkBodyEvidence(args.chunk));
  // 2. retrieved_knowledge.
  for (const k of retrievedKnowledge) {
    byPriority.push(knowledgeEvidence(k));
  }
  // 3. tier1_finding.
  for (const f of tier1Findings) {
    byPriority.push(tier1Evidence(f));
  }
  // 4. pr_topology.
  for (const t of prTopologyManifest) {
    byPriority.push(topologyEvidence(t));
  }
  // 5. tool_status. Per R-21 the sequence index is part of the mint key.
  for (const [i, s] of toolStatuses.entries()) {
    byPriority.push(toolStatusEvidence(s, i));
  }

  // Apply the entry cap by slicing (drops the tail = lowest priority).
  return byPriority.slice(0, maxEntries);
}

/**
 * The registered activity: assemble the per-chunk evidence manifest from the typed envelope and return
 * the priority-ordered `Array<RetrievedEvidenceV1>` (length ≤ `input.max_entries`). Stateless — the
 * producer is pure modulo the `mintEvidenceId` crypto hash.
 */
export async function buildRetrievedEvidence(
  input: BuildRetrievedEvidenceInputV1,
): Promise<Array<RetrievedEvidenceV1>> {
  return buildRetrievedEvidenceEntries({
    chunk: input.chunk,
    retrievedKnowledge: input.retrieved_knowledge,
    tier1Findings: input.tier1_findings,
    toolStatuses: input.tool_statuses,
    prTopologyManifest: input.pr_topology_manifest,
    maxEntries: input.max_entries,
  });
}
