import { createHash } from "node:crypto";

import { z } from "zod";

// Zod port of contracts/diff_chunking/v1.py::DiffChunkV1.
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in diff_chunking.v1.parity.test.ts.

// ChunkKind = Literal["function", "class", "module", "hunk", "batch"]  →  z.enum([...])
export const CHUNK_KINDS = ["function", "class", "module", "hunk", "batch"] as const;
export const ChunkKind = z.enum(CHUNK_KINDS);
export type ChunkKind = z.infer<typeof ChunkKind>;

// DiffChunkV1 — one review-sized slice of a file (or a batch of small files).
//  - schema_version: int = 1                                    → z.number().int().default(1)
//    (Python field is a plain `int` with default 1, NOT Literal[1] — it accepts e.g. 2 and
//     re-emits it; z.literal(1) would FALSELY reject and break parity. Verified vs the frozen ref.)
//  - chunk_id: uuid.UUID (required; no default_factory per R-5) → z.string().uuid()
//  - path: str = Field(min_length=1)                            → z.string().min(1)
//  - language: str | None = None                                → z.string().nullable().default(null)
//  - start_line: int = Field(ge=1)                              → z.number().int().gte(1)
//  - end_line: int = Field(ge=1)                                → z.number().int().gte(1)
//  - body: str                                                  → z.string()
//  - chunk_kind: ChunkKind                                      → ChunkKind enum
//  - token_estimate: int = Field(ge=0)                          → z.number().int().gte(0)
//  - @model_validator(mode="after") _check_line_range           → .superRefine() (end_line >= start_line)
export const DiffChunkV1 = z
  .object({
    schema_version: z.number().int().default(1),
    chunk_id: z.string().uuid(),
    path: z.string().min(1),
    language: z.string().nullable().default(null),
    start_line: z.number().int().gte(1),
    end_line: z.number().int().gte(1),
    body: z.string(),
    chunk_kind: ChunkKind,
    token_estimate: z.number().int().gte(0),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Re-authored from DiffChunkV1._check_line_range (@model_validator mode="after").
    if (v.end_line < v.start_line) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_line"],
        message: `end_line (${v.end_line}) must be >= start_line (${v.start_line})`,
      });
    }
  });

export type DiffChunkV1 = z.infer<typeof DiffChunkV1>;

// v8 R-4: namespace for deterministic chunk_id derivation (mirrors `_CHUNK_ID_NAMESPACE`).
const CHUNK_ID_NAMESPACE = "c4f8c4f8-c4f8-4c4f-8c4f-c4f8c4f8c4f8";

function uuidToBytes(u: string): Buffer {
  return Buffer.from(u.replace(/-/g, ""), "hex");
}

// RFC 4122 UUIDv5 (SHA-1 of namespace || name), stdlib-only (matches Python uuid.uuid5).
function uuid5(namespace: string, name: string): string {
  const digest = createHash("sha1")
    .update(Buffer.concat([uuidToBytes(namespace), Buffer.from(name, "utf-8")]))
    .digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * v8 R-4: deterministic chunk_id derivation — port of
 * contracts/diff_chunking/v1.py::compute_chunk_id.
 *
 * Returns UUIDv5 of (path, start_line, end_line, sha256(body)) namespaced under
 * CHUNK_ID_NAMESPACE. Same inputs → same id across runs → replay-safe. The body is
 * sha256-hashed first so the UUIDv5 name stays bounded for tens-of-KB chunk bodies.
 * Cross-language value-parity is asserted in the parity test.
 */
export function computeChunkId(args: {
  path: string;
  start_line: number;
  end_line: number;
  body: string;
}): string {
  const bodyHash = createHash("sha256").update(Buffer.from(args.body, "utf-8")).digest("hex");
  const name = `${args.path}\n${args.start_line}\n${args.end_line}\n${bodyHash}`;
  return uuid5(CHUNK_ID_NAMESPACE, name);
}
