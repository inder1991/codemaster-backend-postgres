import { createHash } from "node:crypto";

import { z } from "zod";

// Zod port of contracts/retrieved_evidence/v1.py (frozen Python — v10 provenance-backed evidence).
// Parity-validated in retrieved_evidence.v1.parity.test.ts.
//
// RetrievedEvidenceV1 is one piece of evidence the orchestration layer made available to a chunk
// worker. The LLM cites evidence by its stable `evidence_id`; the activity-boundary parser asserts
// finding.evidence_refs ⊆ {ev.evidence_id} so the LLM cannot invent references it was not issued.

// Literal["chunk_body", ...] → z.enum([...]).
export const EvidenceSourceType = z.enum([
  "chunk_body",
  "retrieved_knowledge",
  "tier1_finding",
  "pr_topology",
  "tool_status",
]);
export type EvidenceSourceType = z.infer<typeof EvidenceSourceType>;

// EVIDENCE_PRIORITY (remediation R-24) — single source of truth for the evidence priority order.
// Lower index = higher priority = kept longest under cap pressure.
export const EVIDENCE_PRIORITY: readonly EvidenceSourceType[] = [
  "chunk_body",
  "retrieved_knowledge",
  "tier1_finding",
  "pr_topology",
  "tool_status",
] as const;

// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// UUID fields are emitted by Pydantic model_dump(mode="json") as lowercase RFC4122 strings; on the wire
// they are strings, so the Zod port validates the string form. `= None` defaults → .nullable().default(null)
// (Pydantic dumps the absent fields as explicit null, so the Zod default must inject null too).
export const RetrievedEvidenceV1 = z
  .object({
    evidence_id: z.string().regex(/^ev_[0-9a-f]{16}$/),
    source_type: EvidenceSourceType,
    chunk_id: z.string().uuid().nullable().default(null),
    knowledge_chunk_id: z.string().uuid().nullable().default(null),
    path: z.string().max(1024).nullable().default(null),
    excerpt: z.string().min(1).max(2000),
  })
  .strict();

export type RetrievedEvidenceV1 = z.infer<typeof RetrievedEvidenceV1>;

// v10 R-5 — deterministic UUIDv5 namespace for evidence_id minting. Stable across deploys.
const EVIDENCE_NAMESPACE = "e7c4f8e7-c4f8-4e7c-8e7c-4f8e7c4f8e7c";

// RFC4122 v5 UUID (SHA-1 of namespace bytes ++ name bytes), returned as 32 lowercase hex chars.
// Re-authored from Python's `uuid.uuid5` (no `uuid` npm dep; node:crypto only). Parity-checked.
function uuid5Hex(namespaceHex: string, name: string): string {
  const nsBytes = Buffer.from(namespaceHex.replace(/-/g, ""), "hex"); // 16 bytes
  const digest = createHash("sha1")
    .update(nsBytes)
    .update(Buffer.from(name, "utf-8"))
    .digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8); // RFC4122 variant
  return b.toString("hex");
}

// v10 R-5 — deterministic evidence_id minter. Returns a string matching ^ev_[0-9a-f]{16}$.
// Mirrors contracts/retrieved_evidence/v1.py::mint_evidence_id: build a UUIDv5 "name" from
// source_type + sha256(parts joined by "|") under EVIDENCE_NAMESPACE, take the first 16 hex
// chars of the v5 digest, prefix `ev_`. Deterministic (replay-safe) by construction.
//
// NOTE (non-trivial helper): the Python signature is `mint_evidence_id(source_type, *parts)` with
// parts ∈ {str | uuid.UUID | int}. The parity oracle calls `fn(**kwargs)` and so can only drive the
// empty-parts path (source_type only); parts are stringified the same way Python's `str()` does, so a
// caller passing e.g. integers or UUID strings reproduces the Python id byte-for-byte (verified
// manually against the frozen ref for the full-parts case).
export function mintEvidenceId(
  source_type: EvidenceSourceType,
  ...parts: (string | number)[]
): string {
  const partsStr = parts.map((p) => String(p)).join("|");
  const name =
    source_type +
    "|" +
    createHash("sha256").update(Buffer.from(partsStr, "utf-8")).digest("hex");
  const digest = uuid5Hex(EVIDENCE_NAMESPACE, name).slice(0, 16);
  return `ev_${digest}`;
}
