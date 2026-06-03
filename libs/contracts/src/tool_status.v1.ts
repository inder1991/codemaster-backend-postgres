import { z } from "zod";

// Zod port of contracts/tool_status/v1.py::ToolStatusV1 (frozen Python).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in tool_status.v1.parity.test.ts.
//
// Notes on the port:
//  - `coverage_fraction` is a Python @property, NOT a model field — it is absent from
//    model_dump(mode="json"), so it is intentionally not represented here.
//  - `started_at` is a required datetime; `finished_at` is required-but-nullable (datetime | None
//    with no default → Pydantic requires it). Neither is .optional().
//  - The `_check_coverage` model_validator (files_scanned <= files_total) is re-authored as a
//    .superRefine() so the cross-field invariant rejects identically on both sides.

// Literal[...] string union → z.enum.
export const TOOL_STATUS_LITERALS = [
  "completed",
  "timed_out",
  "failed_startup",
  "failed_runtime",
  "oom",
  "auth_failed",
  "skipped",
] as const;

export const ToolStatusLiteral = z.enum(TOOL_STATUS_LITERALS);
export type ToolStatusLiteral = z.infer<typeof ToolStatusLiteral>;

export const ToolStatusV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    tool_name: z.string().min(1).max(64),
    status: ToolStatusLiteral,

    files_scanned: z.number().int().gte(0),
    files_total: z.number().int().gte(0),

    // datetime on the wire is an ISO-8601 string (Pydantic model_dump(mode="json")).
    started_at: z.string().datetime({ offset: true }),
    finished_at: z.string().datetime({ offset: true }).nullable(),
    duration_ms: z.number().int().gte(0),

    findings_produced: z.number().int().gte(0).default(0),

    error_class: z.string().max(128).nullable().default(null),
    error_message: z.string().max(2048).nullable().default(null),
  })
  .strict()
  // @model_validator(mode="after") _check_coverage: files_scanned must not exceed files_total.
  .superRefine((val, ctx) => {
    if (val.files_scanned > val.files_total) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `files_scanned (${val.files_scanned}) cannot exceed files_total (${val.files_total})`,
        path: ["files_scanned"],
      });
    }
  });

export type ToolStatusV1 = z.infer<typeof ToolStatusV1>;
