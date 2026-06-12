import { z } from "zod";

// knowledge_corpus_probe.v1 — W2.4 (XH13) retrieval short-circuit probe contract.
//
// NEW contract introduced DURING the hardening waves (no frozen-Python counterpart): the Python
// pipeline ran the full per-chunk hybrid retrieval UNCONDITIONALLY, even for repos with zero indexed
// knowledge (XH13 — docs/audits/2026-06-11-cross-cutting-characteristics-audit.md). The probe is the
// cheap once-per-review EXISTS pair the orchestrator consults BEFORE the chunk fan-out so it can skip
// `embed_query` + `retrieve_knowledge` entirely when retrieval provably cannot contribute.
//
// FAIL-OPEN posture: consumers must treat a probe FAILURE as "knowledge may exist" (run retrieval),
// and the producer deliberately OVER-reports availability — a false "has knowledge" costs one legacy
// retrieval round-trip; a false "no knowledge" would silently drop retrieval that could have helped.

export const CURRENT_SCHEMA_VERSION = 1 as const;

// Input — extra=forbid posture of every sibling contract → .strict().
export const KnowledgeCorpusProbeInputV1 = z
  .object({
    schema_version: z.number().int().default(CURRENT_SCHEMA_VERSION),
    /** The internal tenant UUID (same identity retrieve_knowledge dispatches carry). */
    installation_id: z.string().uuid(),
    /** The internal repository UUID (`repository_id` — the workflow payload's repo identity). */
    repo_id: z.string().uuid(),
  })
  .strict();
export type KnowledgeCorpusProbeInputV1 = z.infer<typeof KnowledgeCorpusProbeInputV1>;

// Result — the two corpus-existence answers the short-circuit decision consumes.
export const KnowledgeCorpusProbeResultV1 = z
  .object({
    schema_version: z.number().int().default(CURRENT_SCHEMA_VERSION),
    /** Any ACTIVE `core.knowledge_chunks` row for (installation_id, repo_id). */
    has_repo_knowledge: z.boolean(),
    /** Any live `core.confluence_chunks` row (platform-shared corpus — no tenancy filter). */
    has_confluence_knowledge: z.boolean(),
  })
  .strict();
export type KnowledgeCorpusProbeResultV1 = z.infer<typeof KnowledgeCorpusProbeResultV1>;
