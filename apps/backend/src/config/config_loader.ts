/**
 * Workspace-side `.codemaster.yaml` reader — 1:1 port of the frozen Python
 * `codemaster/policy/config_loader.py` (Sprint 25 / A-7-config-wireup + T-6b).
 *
 * Reads `<workspace>/.codemaster.yaml` from the cloned review workspace and returns the WHOLE
 * validated {@link CodemasterConfigV1}. FAIL-OPEN by construction: on EVERY failure mode it returns
 * a valid {@link CodemasterConfigV1} (defaults) — it NEVER throws.
 *
 * ## The fail-open branch map (ported point-for-point from the Python `# noqa: PLR0911` many-returns)
 *
 *   1. file missing                      → defaults
 *   2. stat() fails (OSError)            → defaults  (reason=io_error)
 *   3. size > 50 KiB cap                 → defaults  (reason=oversize)
 *   4. read fails (OSError)              → defaults  (reason=io_error)
 *   5. YAML parse error (YAMLException)  → defaults  (reason=parse_error)
 *   6. empty document (null/undefined)   → defaults
 *   7. schema validation failure (Zod)   → defaults  (reason=validation_error)
 *   8. valid                             → the validated config
 *
 * Branch 7 is FULL-defaults, NOT a partial merge: the frozen Python `CodemasterConfigV1.model_validate`
 * rejects the WHOLE document on any single invalid field (e.g. `max_findings_per_file: 9999` > 100) and
 * falls back to `CodemasterConfigV1()` defaults — there is no per-field salvage. The Zod
 * `.parse()` here mirrors that exactly: any `ZodError` collapses to full defaults. Branch 7 ALSO covers
 * a non-mapping top-level (a YAML list or scalar): the Python loader has no separate non-dict branch —
 * it relies on `model_validate` rejecting non-mappings, and `.strict()` Zod object `.parse()` likewise
 * rejects a top-level array/scalar with a `ZodError`, routing it to the same full-defaults return.
 *
 * ## js-yaml ↔ PyYAML are NOT parse-parity — a normalizer bridges the realistic divergences
 *
 *   * Parse via js-yaml `load` (the v4 SAFE loader — `yaml.load` in v4 is the `yaml.safe_load`
 *     analogue; the legacy unsafe loader was removed). Mirrors the Python `yaml.safe_load` DoS posture
 *     (no arbitrary-object construction).
 *   * js-yaml throws `YAMLException` on a syntax error; PyYAML raises `yaml.YAMLError`. Both are caught
 *     as the parse-error fail-open branch.
 *   * EMPTY-DOCUMENT divergence handled explicitly: js-yaml `load("")` returns `undefined` whereas
 *     PyYAML `safe_load("")` returns `None`. Python tests `if data is None`; the TS port tests
 *     `data === null || data === undefined` so BOTH the empty-string (`undefined`) and the
 *     whitespace/comment-only/`null`-literal (`null`) cases land on the empty-file → defaults branch,
 *     matching Python byte-for-byte.
 *   * **js-yaml is YAML 1.2; PyYAML's `safe_load` is YAML 1.1 — they DO NOT agree on scalars, and the
 *     gap is MATERIAL.** `enabled: no` is the canonical case: js-yaml (1.2) reads the STRING `"no"`
 *     (1.2 dropped the `yes/no/on/off` bool words), whereas PyYAML (1.1) reads bool `False` and Pydantic
 *     keeps it `False`. Strict `z.boolean()` rejects the string `"no"` → the WHOLE config would fall to
 *     defaults → `enabled` would stay its `true` default → review would STAY ON for a customer who opted
 *     OUT. To close that fidelity gap WITHOUT loosening the shared strict contract, the parsed object is
 *     run through {@link normalizeCodemasterYaml} (a dedicated untrusted-boundary parser) BEFORE the
 *     strict `CodemasterConfigV1.safeParse`. The normalizer coerces ONLY the contract's bool/int fields
 *     to the types Pydantic v2 accepts (bool words, quoted/underscore numerics, bool→int) — leaving every
 *     other field untouched — so the strict contract validates the same shapes Pydantic accepted. The
 *     EXOTIC YAML-1.1-only *parse* divergences (sexagesimal `1:30`, leading-zero octal `017`/`0o17`,
 *     bool words inside string lists, duplicate mapping keys) happen INSIDE js-yaml before the normalizer
 *     runs and are NOT bridged — a DOCUMENTED RESIDUAL (FOLLOW-UP-config-yaml-1.1-exotic-scalars), never
 *     present in a real `.codemaster.yaml` and not worth a new YAML-1.1 parser dependency. The parity
 *     corpus pins both the FIXED cases and the known RESIDUAL divergences. See
 *     {@link normalizeCodemasterYaml} for the full observed Pydantic-v2 coercion ground truth.
 *
 * ## Observability seam (intentionally a structural no-op here)
 *
 * The frozen Python emits a WARN log + one OTel counter (`record_config_malformed{reason}` /
 * `record_config_policy_disabled`) on each failure path. Those are pure side effects that DO NOT alter
 * the returned config — the parity oracle compares only the returned {@link CodemasterConfigV1}. The OTel
 * policy-metrics module is not yet ported (separate observability sub-project); the fail-open RETURN
 * semantics — the parity-critical contract — are ported in full here, and each branch is annotated with
 * the Python reason label it corresponds to so the metric wire-up is a mechanical follow-up.
 *
 * ## Runtime context
 *
 * This runs in the NORMAL Node runtime (inside an activity), NOT the workflow V8-isolate sandbox. The
 * file read uses `node:fs` synchronously — a filesystem read, which the check_clock_random gate permits
 * (it bans only clock/random/timer seams, not fs). There is NO Date/Math.random/setTimeout here.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { load as yamlLoad, YAMLException } from "js-yaml";

import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import {
  type ConfigMalformedReasonV1,
  LoadRepoConfigResultV1,
} from "#contracts/load_repo_config.v1.js";

import { normalizeCodemasterYaml } from "./codemaster_config_yaml_input.js";

/** The fixed config filename read from the cloned workspace root (ported verbatim). */
const CONFIG_FILENAME = ".codemaster.yaml";

/**
 * T-6b: 50 KiB cap matches the A-7 spec. The DoS surface is customer-authored YAML; 50 KiB is generous
 * for legitimate use (thousands of patterns + paragraphs of comments) while preventing
 * memory-exhaustion / parser-DoS attacks. Checked BEFORE the read + parse.
 */
const CONFIG_MAX_BYTES = 50 * 1024;

/**
 * Read `<workspace>/.codemaster.yaml`; return the WHOLE validated {@link CodemasterConfigV1}.
 *
 * FAIL-OPEN: any error returns `CodemasterConfigV1.parse({})` (full defaults). NEVER throws. Mirrors the
 * frozen Python `load_repo_config` (50 KiB cap; safe YAML load; whole-config-or-defaults validation).
 *
 * Synchronous to match the frozen Python `def load_repo_config` (a sync def). This bare-config shape
 * is the byte-parity surface (config.parity.test.ts); the status-carrying variant below (M6) wraps it.
 */
export function loadRepoConfig(workspace: string): CodemasterConfigV1 {
  return loadRepoConfigWithStatus(workspace).config;
}

/**
 * W4.4 [M6]: the status-carrying loader — same fail-open branch map, but each branch RETURNS which
 * branch fired (`config_status` + `reason`) so the orchestrator can append the user-visible
 * "your .codemaster.yaml was malformed and ignored" NOTICE instead of silently dropping the
 * customer's settings. Each malformed branch also emits the ported Python WARN as a structured log
 * (`repo_config.malformed{reason}`); the OTel `record_config_malformed` counter half stays deferred
 * with the observability sub-project (W0.4/W0.5b owner steer). NEVER throws.
 */
export function loadRepoConfigWithStatus(workspace: string): LoadRepoConfigResultV1 {
  const yamlPath = join(workspace, CONFIG_FILENAME);

  // Branch 1 + 2: missing file OR un-stat-able. ENOENT / not-a-regular-file is the ABSENT branch
  // (Python `is_file()` false → defaults, no metric); any other stat OSError is malformed/io_error.
  let size: number;
  try {
    const st = statSync(yamlPath);
    if (!st.isFile()) {
      return absent(); // not a regular file → Python `is_file()` false → defaults (no metric)
    }
    size = st.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return absent();
    }
    return malformed("io_error"); // stat()-failure branch (Python reason=io_error)
  }

  // Branch 3: oversize → defaults (reason=oversize).
  if (size > CONFIG_MAX_BYTES) {
    return malformed("oversize");
  }

  // Branch 4: read failure → defaults (reason=io_error).
  let text: string;
  try {
    text = readFileSync(yamlPath, "utf-8");
  } catch {
    return malformed("io_error");
  }

  // Branch 5: YAML parse error → defaults (reason=parse_error). js-yaml throws `YAMLException`, the
  // analogue of PyYAML's `yaml.YAMLError`. We narrow to it (and still fail open on any other throw, which
  // a well-behaved js-yaml does not produce — but fail-open is the whole contract).
  let data: unknown;
  try {
    data = yamlLoad(text);
  } catch (err) {
    if (err instanceof YAMLException) {
      return malformed("parse_error");
    }
    // Defensive: any non-YAMLException throw is still a fail-open path (never raise out of the loader).
    return malformed("parse_error");
  }

  // Branch 6: empty document → defaults, STATUS 'valid'. Python `if data is None` (no metric — an
  // intentionally-empty config IS the all-defaults opt-in, not an error). js-yaml returns `undefined`
  // for an empty string and `null` for whitespace/comment-only/`null`-literal; both map here.
  if (data === null || data === undefined) {
    return LoadRepoConfigResultV1.parse({
      schema_version: 1,
      config: defaults(),
      config_status: "valid",
      reason: null,
    });
  }

  // Untrusted-boundary normalization (YAML-1.2 → Pydantic-v2-compatible scalars) BEFORE the strict parse.
  // js-yaml (1.2) hands us `"no"`/`"1_000"`/`true`-on-an-int-field where PyYAML (1.1) + lax Pydantic would
  // have coerced to `False`/`1000`/`1`. `normalizeCodemasterYaml` coerces ONLY the contract's bool/int
  // fields (and leaves everything else untouched), so the STRICT contract below validates the same shapes
  // Pydantic accepted — without `CodemasterConfigV1` itself loosening to `z.coerce` (Temporal/DB/internal
  // consumers MUST stay strict). A value it cannot confidently coerce is left as-is so the strict parse
  // rejects it → fail-open to defaults (matching Pydantic rejecting that same value). See
  // codemaster_config_yaml_input.ts.
  const normalized = normalizeCodemasterYaml(data);

  // Branch 7 + 8: validate the whole document. Any single invalid field (or a non-mapping top-level)
  // throws a `ZodError`, which falls back to FULL defaults — the frozen Python `model_validate` rejects
  // the whole doc, NOT a partial merge. A valid document returns the validated, default-filled config.
  const parsed = CodemasterConfigV1.safeParse(normalized);
  if (!parsed.success) {
    return malformed("validation_error");
  }
  return LoadRepoConfigResultV1.parse({
    schema_version: 1,
    config: parsed.data,
    config_status: "valid",
    reason: null,
  });
}

/** The absent-file result (defaults, no notice, no warn — matching Python's metric-free branch). */
function absent(): LoadRepoConfigResultV1 {
  return LoadRepoConfigResultV1.parse({
    schema_version: 1,
    config: defaults(),
    config_status: "absent",
    reason: null,
  });
}

/** A malformed-branch result: defaults + status + reason, with the ported WARN log. */
function malformed(reason: ConfigMalformedReasonV1): LoadRepoConfigResultV1 {
  // The Python WARN ("config malformed; using defaults") ported as a structured log line; the OTel
  // `record_config_malformed{reason}` counter is the deferred W0.4/W0.5b half.
  console.warn(JSON.stringify({ event: "repo_config.malformed", reason }));
  return LoadRepoConfigResultV1.parse({
    schema_version: 1,
    config: defaults(),
    config_status: "malformed",
    reason,
  });
}

/**
 * The full-defaults config, ported from the Python `CodemasterConfigV1()` no-arg construction. Zod
 * fills every `.default(...)` from the empty object, exactly as the Pydantic field defaults do — so this
 * is byte-identical to the Python defaults instance the fail-open branches return.
 */
function defaults(): CodemasterConfigV1 {
  return CodemasterConfigV1.parse({});
}
