import { z } from "zod";

import { AnalysisFindingV1 } from "./analysis_findings.v1.js";
import { ReviewFindingV1 } from "./review_findings.v1.js";
import { ToolStatusV1 } from "./tool_status.v1.js";

// Zod port of contracts/static_analysis_result/v1.py::StaticAnalysisResultV1.
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in static_analysis_result.v1.parity.test.ts.
//
// Source models / aliases / constants ported (every public one):
//  - _NonNegativeInt = Annotated[int, Field(ge=0)]  (module-private alias)
//       → NonNegativeInt = z.number().int().gte(0)
//  - StaticAnalysisResultV1 (ConfigDict extra=forbid, frozen) → .strict().
//
// Cross-contract references are IMPORTED from their already-ported sibling schemas (do NOT redefine):
//  - findings:       tuple[ReviewFindingV1, ...]   → z.array(ReviewFindingV1)
//  - tier1_findings: tuple[AnalysisFindingV1, ...]  → z.array(AnalysisFindingV1)
//  - tool_statuses:  tuple[ToolStatusV1, ...]       → z.array(ToolStatusV1)
//
// All four tuple fields use Field(default_factory=tuple)  → z.array(...).default([]).
// `per_tool_errors`/`truncated_per_tool` are dict[str, X]  → z.record(z.string(), X).default({}).
//
// NOTE on `findings`: each embedded ReviewFindingV1 carries the bare-float `confidence` column,
// which the repo canonicalizer (test/parity/canonical.ts) deliberately rejects (Python emits `1.0`,
// JS emits `1`). The parity test strips nested `confidence` from BOTH sides before canonical diff,
// then asserts the confidence values structurally — mirroring review_findings.v1.parity.test.ts.

// Annotated[int, Field(ge=0)] — non-negative-int alias used as the dict value type of
// `truncated_per_tool` (per-tool drop-count when raw findings exceed MAX_RAW_PER_TOOL).
export const NonNegativeInt = z.number().int().gte(0);

// StaticAnalysisResultV1 — output envelope for `static_analysis_activity`.
export const StaticAnalysisResultV1 = z
  .object({
    // schema_version is a bare `int` defaulting to 1 — NOT a z.literal (that would false-reject a
    // future schema_version=2 envelope serialized under later sprints' code).
    schema_version: z.number().int().default(1),
    // findings: tuple[ReviewFindingV1, ...] = default_factory=tuple → z.array(...).default([]).
    findings: z.array(ReviewFindingV1).default([]),
    // per_tool_errors: dict[str, str] = default_factory=dict → z.record(...).default({}).
    per_tool_errors: z.record(z.string(), z.string()).default({}),
    // curator_skipped: bool = True (default True, not False).
    curator_skipped: z.boolean().default(true),
    // truncated_per_tool: dict[str, _NonNegativeInt] = default_factory=dict.
    // Each value is constrained to a non-negative int via the Annotated alias above.
    truncated_per_tool: z.record(z.string(), NonNegativeInt).default({}),
    // tier1_findings: tuple[AnalysisFindingV1, ...] = default_factory=tuple → z.array(...).default([]).
    tier1_findings: z.array(AnalysisFindingV1).default([]),
    // tool_statuses: tuple[ToolStatusV1, ...] = default_factory=tuple → z.array(...).default([]).
    tool_statuses: z.array(ToolStatusV1).default([]),
  })
  .strict();

export type StaticAnalysisResultV1 = z.infer<typeof StaticAnalysisResultV1>;
