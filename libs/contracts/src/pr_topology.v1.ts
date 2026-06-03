import { z } from "zod";

// Zod port of contracts/pr_topology/v1.py::PRTopologyEntryV1 (frozen Python — v8 chunk-locality manifest).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// chunk_id is a uuid.UUID in Python; Pydantic serializes it to its canonical lowercase string form, so the
// wire shape is a UUID string. Parity payloads use canonical-lowercase UUIDs (Pydantic lowercases input;
// Zod .uuid() does not — keep inputs canonical to avoid a spurious diff). Parity-validated in
// pr_topology.v1.parity.test.ts.

// PRTopologyKind = Literal["code", "doc", "config", "test", "other"]
export const PRTopologyKind = z.enum(["code", "doc", "config", "test", "other"]);
export type PRTopologyKind = z.infer<typeof PRTopologyKind>;

export const PRTopologyEntryV1 = z
  .object({
    // Stable; deterministic v5 of (pr_id, path, start_line, end_line). uuid.UUID → canonical string.
    chunk_id: z.string().uuid(),
    path: z.string().min(1).max(1024),
    start_line: z.number().int().gte(1),
    end_line: z.number().int().gte(1),
    kind: PRTopologyKind.default("code"),
  })
  .strict()
  // @model_validator(mode="after") _check_line_range: end_line must be >= start_line.
  .superRefine((val, ctx) => {
    if (val.end_line < val.start_line) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `end_line (${val.end_line}) must be >= start_line (${val.start_line})`,
        path: ["end_line"],
      });
    }
  });

export type PRTopologyEntryV1 = z.infer<typeof PRTopologyEntryV1>;
