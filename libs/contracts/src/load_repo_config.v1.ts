import { z } from "zod";

import { CodemasterConfigV1 } from "./codemaster_config.v1.js";

// Zod port of contracts/load_repo_config/v1.py (frozen Python). Parity-validated in
// load_repo_config.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - LoadRepoConfigInputV1 (ConfigDict extra="forbid", frozen=True) → .strict().
//    Frozen input envelope for `load_repo_config_activity` (spec §3.1). Single typed
//    positional Temporal-activity argument (CLAUDE.md invariant 11); JSON-safe by
//    construction (workspace_path is `str`, not Path).
//
// NOTE on `schema_version`: the Python contract types it as a bare `int` defaulting to 1
// (NOT a Literal), so a future v2 envelope can carry schema_version=2 without the v1
// contract false-rejecting it. Modeled as z.number().int().default(1), NOT z.literal(1).

// LoadRepoConfigInputV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const LoadRepoConfigInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    // workspace_path: str = Field(min_length=1). Absolute path to the cloned workspace
    // produced by the clone step earlier in the pipeline.
    workspace_path: z.string().min(1),
  })
  .strict();
export type LoadRepoConfigInputV1 = z.infer<typeof LoadRepoConfigInputV1>;

// ─── W4.4 [M6] — the status-carrying RESULT envelope (TS hardening divergence) ────────────────────
// The frozen Python activity returns the bare CodemasterConfigV1, so its WARN +
// `record_config_malformed` observability was structurally unreachable from the orchestrator: a
// valid-equals-defaults config and a rejected-malformed one were indistinguishable, and the SEED
// contract ("fail-open to defaults + a NOTICE") could not be honored. This envelope is additive:
// the config rides inside it unchanged; `config_status` + `reason` carry the fail-open branch.

/** Which fail-open branch produced the config. */
export const ConfigStatusV1 = z.enum(["absent", "valid", "malformed"]);
export type ConfigStatusV1 = z.infer<typeof ConfigStatusV1>;

/** The Python `record_config_malformed{reason}` label vocabulary (null when not malformed). */
export const ConfigMalformedReasonV1 = z.enum(["io_error", "oversize", "parse_error", "validation_error"]);
export type ConfigMalformedReasonV1 = z.infer<typeof ConfigMalformedReasonV1>;

// LoadRepoConfigResultV1 — the activity's result envelope (M6).
export const LoadRepoConfigResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    /** The effective config — the validated document, or FULL defaults on absent/malformed. */
    config: CodemasterConfigV1,
    /** absent = no `.codemaster.yaml`; valid = parsed (incl. an intentionally-empty doc);
     *  malformed = the WHOLE doc was rejected and defaults are in effect (notice-worthy). */
    config_status: ConfigStatusV1,
    reason: ConfigMalformedReasonV1.nullable().default(null),
  })
  .strict();
export type LoadRepoConfigResultV1 = z.infer<typeof LoadRepoConfigResultV1>;
