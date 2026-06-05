import { z } from "zod";

// Zod port of codemaster/workspace/_handle.py::WorkspaceHandle (frozen Python).
// Parity-validated in workspace_handle.v1.parity.test.ts.
//
// Pydantic ConfigDict(frozen=True, extra="forbid") → .strict() (frozen is a TS-side immutability
// concern, not a wire concern). NO schema_version field — this is a value object, not a versioned
// activity-input contract.
//
// UUID GOTCHA: workspace_id / installation_id / run_id are Pydantic uuid.UUID. model_dump(mode="json")
// emits the lowercase canonical form; an uppercase input is normalized to lowercase by Pydantic. The
// Zod .transform(toLowerCase) reproduces that normalization so accept-and-dump round-trips match.
//
// derived_path GOTCHA: typed pathlib.Path in Python; a @field_serializer renders it to str on
// model_dump (Path is not JSON-serializable). Over the wire it is always a string, so the Zod field
// is z.string() (min 1 — an empty path is not a valid Path on the Python side either, but the
// load-bearing parity surface is the string round-trip, mirrored exactly).
export const WorkspaceHandle = z
  .object({
    workspace_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    installation_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    run_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    derived_path: z.string(),
    state: z.string(),
  })
  .strict();

export type WorkspaceHandle = z.infer<typeof WorkspaceHandle>;
