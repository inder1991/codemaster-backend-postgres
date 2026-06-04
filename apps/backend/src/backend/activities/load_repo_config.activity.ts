/**
 * `loadRepoConfigActivity` — Phase-2.1 core-loop activity #3 port. 1:1 in intent with the frozen Python
 * `@activity.defn(name="load_repo_config_activity") load_repo_config_activity`
 * (vendor/codemaster-py/codemaster/activities/load_repo_config.py): read `<workspace>/.codemaster.yaml`
 * from the cloned PR-head workspace and return the WHOLE {@link CodemasterConfigV1}. FAIL-OPEN — delegates
 * to {@link loadRepoConfig}, which NEVER throws; on any failure mode it returns config defaults.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047
 *
 * The activity input was ALREADY a typed single-positional envelope on the frozen Python side
 * ({@link LoadRepoConfigInputV1}, `workspace_path: str`), so — unlike the `aggregate_findings` /
 * `classify_files` ports — there is NO invariant-11 closure work here: no Python 2-positional dispatch
 * to collapse. The ported envelope is the already-shipped {@link LoadRepoConfigInputV1} Zod contract.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. The filesystem I/O
 * lives INSIDE the activity (per the Python module docstring) precisely so the workflow body stays
 * deterministic; the loader's `node:fs` read is a permitted fs seam (NOT a clock/random seam).
 *
 * `async` mirrors the frozen Python `async def load_repo_config_activity`. The underlying
 * {@link loadRepoConfig} is synchronous (the Python `def load_repo_config` is a sync def), so the activity
 * awaits nothing — it returns the sync result wrapped in the activity's `Promise`.
 */

import { loadRepoConfig } from "#backend/config/config_loader.js";

import type { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import type { LoadRepoConfigInputV1 } from "#contracts/load_repo_config.v1.js";

/**
 * Return the repo's `.codemaster.yaml` as a validated config, or {@link CodemasterConfigV1} defaults on
 * any failure. Mirrors `return load_repo_config(Path(input_.workspace_path))`.
 */
export async function loadRepoConfigActivity(
  input: LoadRepoConfigInputV1,
): Promise<CodemasterConfigV1> {
  return loadRepoConfig(input.workspace_path);
}
