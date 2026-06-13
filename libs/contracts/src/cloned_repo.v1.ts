import { z } from "zod";

// Zod port of contracts/cloned_repo/v1.py::ClonedRepoV1.
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// NOTE: the file is v1.py but the contract's schema_version default is 2 (no Literal annotation,
// so any int is accepted; the int default is mirrored with .default(2)).
// Parity-validated in cloned_repo.v1.parity.test.ts.
export const ClonedRepoV1 = z
  .object({
    schema_version: z.number().int().default(2),
    workspace_path: z.string().min(1),
    // Python `repo_path: str | None = None` — optional + nullable; Pydantic dumps null when omitted.
    repo_path: z.string().nullable().default(null),
    head_sha: z.string().min(7).max(64),
    byte_size: z.number().int().gte(0),
  })
  .strict();

export type ClonedRepoV1 = z.infer<typeof ClonedRepoV1>;
