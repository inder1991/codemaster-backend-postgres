/**
 * `loadRepoConfigActivity` — reads `<workspace>/.codemaster.yaml` from the cloned PR-head workspace
 * and returns the WHOLE {@link CodemasterConfigV1}. FAIL-OPEN — delegates to {@link loadRepoConfig},
 * which NEVER throws; on any failure mode it returns config defaults.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047
 *
 * The activity input is a typed single-positional envelope ({@link LoadRepoConfigInputV1},
 * `workspace_path: str`). No raw-dict re-validation needed — the Temporal DataConverter has already
 * produced the typed input.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. The filesystem I/O
 * lives INSIDE the activity precisely so the workflow body stays deterministic; the loader's `node:fs`
 * read is a permitted fs seam (NOT a clock/random seam).
 */

import { loadRepoConfigWithStatus } from "#backend/config/config_loader.js";

import type {
  LoadRepoConfigInputV1,
  LoadRepoConfigResultV1,
} from "#contracts/load_repo_config.v1.js";

/**
 * Return the repo's `.codemaster.yaml` as a validated config inside the M6 status envelope
 * (`{ config, config_status, reason }`) — defaults on any failure; the loader NEVER throws.
 * W4.4 [M6]: `config_status` lets the orchestrator append the user-visible "malformed and ignored"
 * NOTICE instead of silently dropping a customer's settings.
 */
export async function loadRepoConfigActivity(
  input: LoadRepoConfigInputV1,
): Promise<LoadRepoConfigResultV1> {
  return loadRepoConfigWithStatus(input.workspace_path);
}
