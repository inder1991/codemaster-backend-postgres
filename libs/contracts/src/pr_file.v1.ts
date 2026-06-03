import { z } from "zod";

// Zod port of contracts/pr_file/v1.py::PrFileV1 (frozen Python).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in pr_file.v1.parity.test.ts.

// Mirrors GitHub's documented status values (Python Literal["added", ...]). → z.enum.
export const PrFileStatus = z.enum(["added", "modified", "removed", "renamed", "copied"]);
export type PrFileStatus = z.infer<typeof PrFileStatus>;

export const PrFileV1 = z
  .object({
    // schema_version: int = 1 — Pydantic default, no z.literal in source (plain int default).
    schema_version: z.number().int().default(1),
    pr_file_id: z.string().uuid(),
    pr_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    file_path: z.string().min(1).max(2048),
    status: PrFileStatus,
    additions: z.number().int().gte(0),
    deletions: z.number().int().gte(0),
    // previous_path: str | None = Field(default=None, max_length=2048)
    previous_path: z.string().max(2048).nullable().default(null),
    // language: str | None = Field(default=None, max_length=64)
    language: z.string().max(64).nullable().default(null),
    // created_at: datetime | None = None — ISO-8601 string on the wire.
    created_at: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();

export type PrFileV1 = z.infer<typeof PrFileV1>;
