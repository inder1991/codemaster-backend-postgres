import { z } from "zod";

// Zod port of contracts/tool_findings/v1.py::ToolFindingV1 (frozen Python).
// One static-analysis finding (Semgrep / Trivy) normalised to the codemaster scale.
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in tool_findings.v1.parity.test.ts.

// Locked codemaster severity scale, mirroring ReviewFindingV1's (Python: ToolSeverity Literal).
export const ToolSeverity = z.enum(["nit", "suggestion", "issue", "blocker"]);
export type ToolSeverity = z.infer<typeof ToolSeverity>;

export const ToolFindingV1 = z
  .object({
    // Python: `schema_version: int = 1` — a plain int default, NOT a Literal, so any int is accepted.
    // Mirror with z.number().int().default(1) (z.literal(1) would wrongly reject schema_version=2).
    schema_version: z.number().int().default(1),
    // Pydantic uuid.UUID input accepts a UUID string and dumps it lowercased (mode="json").
    finding_id: z.string().uuid(),
    review_id: z.string().uuid(),
    tool_name: z.enum(["semgrep", "trivy"]),
    rule_id: z.string().min(1).max(200),
    severity: ToolSeverity,
    file_path: z.string().min(1).max(512),
    line: z.number().int().gte(1),
    message: z.string().min(1).max(1024),
    snippet: z.string().max(200).default(""),
  })
  .strict();

export type ToolFindingV1 = z.infer<typeof ToolFindingV1>;
