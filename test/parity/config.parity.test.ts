import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import { pyLoadRepoConfig, shutdownConfigRef, type ConfigRequest } from "./config_oracle.js";
import { loadRepoConfig } from "#backend/config/config_loader.js";
import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import { LoadRepoConfigInputV1 } from "#contracts/load_repo_config.v1.js";
import { loadRepoConfigActivity } from "#backend/activities/load_repo_config.activity.js";

afterAll(() => {
  shutdownConfigRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS `loadRepoConfig` fail-open YAML loader is byte-equal to the frozen Python
// `load_repo_config` (vendor/codemaster-py/codemaster/policy/config_loader.py), driven over the dedicated
// ref (tools/parity/run_config_ref.py).
//
// CodemasterConfigV1 is pure-structural (bool / int / str / nested-model — NO bare float per the
// contract's own note), so the generic `canonicalize` compare diffs the WHOLE config envelope directly —
// no per-field stripping needed (unlike the aggregate confidence float).
//
// Each case writes the SAME `.codemaster.yaml` body into a fresh TS temp workspace (or omits the file)
// AND forwards the same body to the Python driver (which writes its OWN temp dir internally). The two
// workspaces differing doesn't affect parity — the dumped config carries no absolute path.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const tempDirs: Array<string> = [];

/** Materialize the request's `.codemaster.yaml` into a fresh TS temp workspace (or, when `yaml` is
 *  absent, write NOTHING → the missing-file branch). Returns the absolute workspace path. */
function writeTsWorkspace(req: ConfigRequest): string {
  const workspace = mkdtempSync(join(tmpdir(), "config-parity-"));
  tempDirs.push(workspace);
  if (req.yaml !== undefined) {
    writeFileSync(join(workspace, ".codemaster.yaml"), req.yaml, "utf-8");
  }
  return workspace;
}

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Run the SAME `.codemaster.yaml` body (or absence) through the TS `loadRepoConfig` and the frozen Python
 * `load_repo_config`, and assert byte-equality of the WHOLE `CodemasterConfigV1` envelope. Returns the
 * Python config dict for extra structural assertions.
 */
async function assertParity(req: ConfigRequest): Promise<ConfigDictLocal> {
  const workspace = writeTsWorkspace(req);

  const ts = loadRepoConfig(workspace) as unknown as Record<string, unknown>;
  const py = (await pyLoadRepoConfig(req)) as Record<string, unknown>;

  expect(canonicalize(ts)).toBe(canonicalize(py));
  return py as ConfigDictLocal;
}

type ConfigDictLocal = {
  readonly schema_version: number;
  readonly enabled: boolean;
  readonly severity_min: string;
  readonly max_findings_per_file: number;
  readonly max_findings_per_review: number;
  readonly knowledge: { readonly enabled: boolean; readonly file_patterns: ReadonlyArray<string> };
};

/**
 * Run the SAME body through BOTH sides and return both configs WITHOUT asserting equality — used by the
 * RESIDUAL fixtures, which must document a KNOWN YAML-1.1-vs-1.2 divergence (TS ≠ PY) rather than pretend
 * parity. The FIX fixtures use {@link assertParity} (which DOES assert equality).
 */
async function bothSides(
  req: ConfigRequest,
): Promise<{ ts: Record<string, unknown>; py: ConfigDictLocal }> {
  const workspace = writeTsWorkspace(req);
  const ts = loadRepoConfig(workspace) as unknown as Record<string, unknown>;
  const py = (await pyLoadRepoConfig(req)) as unknown as ConfigDictLocal;
  return { ts, py };
}

describe("load_repo_config fail-open parity (Python ↔ TS)", () => {
  it("(a) FULLY-valid .codemaster.yaml — every config branch round-trips", async () => {
    const py = await assertParity({
      yaml: [
        "schema_version: 1",
        "enabled: false",
        "severity_min: blocker",
        "ignore_paths:",
        "  - 'legacy/**'",
        "path_filters:",
        "  - 'src/**/*.ts'",
        "  - '!**/*.test.ts'",
        "max_findings_per_file: 5",
        "max_findings_per_review: 25",
        "model_overrides:",
        "  review_finding: 'claude-3-opus'",
        "enabled_tools:",
        "  - eslint",
        "  - ruff",
        "path_instructions:",
        "  - path: 'src/api/**'",
        "    instructions: 'Be strict about auth checks.'",
        "knowledge:",
        "  enabled: true",
        "  file_patterns:",
        "    - 'docs/**/*.md'",
        "  confluence:",
        "    include_labels:",
        "      - python",
        "    exclude_labels:",
        "      - default",
        "",
      ].join("\n"),
    });
    // Spot-check the validated values flowed through (parity already asserts whole-config equality).
    expect(py.enabled).toBe(false);
    expect(py.severity_min).toBe("blocker");
    expect(py.max_findings_per_file).toBe(5);
    expect(py.knowledge.file_patterns).toEqual(["docs/**/*.md"]);
  }, 30_000);

  it("(b) MISSING file → defaults", async () => {
    const py = await assertParity({}); // no `yaml` key → no file written
    expect(py.schema_version).toBe(1);
    expect(py.enabled).toBe(true);
    expect(py.severity_min).toBe("nit");
    expect(py.max_findings_per_file).toBe(10);
    expect(py.max_findings_per_review).toBe(50);
    expect(py.knowledge.enabled).toBe(true);
    expect(py.knowledge.file_patterns).toEqual([]);
  }, 30_000);

  it("(c) MALFORMED yaml (syntax error) → defaults", async () => {
    const py = await assertParity({ yaml: "enabled: false\n  bad: [unclosed\n\tmix: tabs" });
    expect(py.enabled).toBe(true); // fell back to default, did NOT honor the malformed `enabled: false`
    expect(py.severity_min).toBe("nit");
  }, 30_000);

  it("(d) top-level non-mapping (a YAML list) → defaults", async () => {
    const py = await assertParity({ yaml: "- a\n- b\n- c" });
    expect(py.enabled).toBe(true);
    expect(py.max_findings_per_file).toBe(10);
  }, 30_000);

  it("(d') top-level non-mapping (a bare scalar) → defaults", async () => {
    const py = await assertParity({ yaml: "42" });
    expect(py.enabled).toBe(true);
    expect(py.schema_version).toBe(1);
  }, 30_000);

  it("(e) ONE invalid field value → FULL defaults (no partial merge)", async () => {
    // `max_findings_per_file: 9999` exceeds the 1..100 bound → the WHOLE doc is rejected and the loader
    // returns config defaults; the OTHERWISE-valid `severity_min: issue` is DISCARDED, not salvaged.
    const py = await assertParity({ yaml: "max_findings_per_file: 9999\nseverity_min: issue" });
    expect(py.max_findings_per_file).toBe(10); // default, not 9999
    expect(py.severity_min).toBe("nit"); // default, not the otherwise-valid "issue" → proves full-defaults
  }, 30_000);

  it("(e') unknown top-level key (extra=forbid / .strict()) → FULL defaults", async () => {
    const py = await assertParity({ yaml: "bogus_key: true\nenabled: false" });
    expect(py.enabled).toBe(true); // .strict() rejected the doc → defaults, did NOT honor enabled:false
  }, 30_000);

  it("(f) EMPTY file → defaults", async () => {
    const py = await assertParity({ yaml: "" });
    expect(py.schema_version).toBe(1);
    expect(py.enabled).toBe(true);
    expect(py.knowledge.file_patterns).toEqual([]);
  }, 30_000);

  it("(f') whitespace / comment-only file → defaults", async () => {
    // js-yaml `load` returns `null` (not `undefined`) here; both must route to the empty-file branch.
    const py = await assertParity({ yaml: "  \n# only a comment\n   " });
    expect(py.enabled).toBe(true);
  }, 30_000);

  it("knowledge.enabled=false opt-out still returns the WHOLE valid config (not defaults)", async () => {
    // load_repo_config returns the validated config regardless of the customer opt-out — the opt-out only
    // affects the NARROWER load_knowledge_config path (not ported here). Confirm parity on the valid doc.
    const py = await assertParity({
      yaml: "knowledge:\n  enabled: false\n  file_patterns:\n    - 'guidelines/**'",
    });
    expect(py.knowledge.enabled).toBe(false);
    expect(py.knowledge.file_patterns).toEqual(["guidelines/**"]);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Adversarial YAML-1.1-vs-1.2 fidelity corpus (the 12 fixtures a parity check surfaced).
//
// js-yaml is YAML 1.2; PyYAML's safe_load is YAML 1.1; Pydantic v2 is LAX (coerces scalars) while the TS
// CodemasterConfigV1 stays STRICT. WITHOUT the `normalizeCodemasterYaml` boundary layer, `enabled: no`
// parsed to the string "no", strict `z.boolean()` rejected it, the WHOLE config fell to defaults, and
// review STAYED ON for a customer who opted OUT. These FIX fixtures prove the normalizer closes that gap
// (TS === frozen-Python). The RESIDUAL fixtures pin the EXOTIC YAML-1.1-only *parse* divergences that
// happen INSIDE js-yaml before the normalizer runs — they are NOT bridged (no YAML-1.1 parser dep), so we
// assert the EXACT known PY-vs-TS divergence + the reason, rather than pretending they match.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("YAML-1.1↔1.2 fidelity corpus — FIX (normalizer closes the gap; TS === frozen-Python)", () => {
  it("enabled: no → disabled at top level (was: string 'no' → strict reject → review stayed ON)", async () => {
    const py = await assertParity({ yaml: "enabled: no" });
    expect(py.enabled).toBe(false); // the safety-critical opt-out is HONORED, not lost to defaults (true)
  }, 30_000);

  it("enabled: off → disabled at top level", async () => {
    const py = await assertParity({ yaml: "enabled: off" });
    expect(py.enabled).toBe(false);
  }, 30_000);

  it("enabled: False → disabled at top level (js-yaml already yields boolean; passthrough)", async () => {
    const py = await assertParity({ yaml: "enabled: False" });
    expect(py.enabled).toBe(false);
  }, 30_000);

  it("enabled: 0 → disabled at top level (numeric 0 → bool false, as Pydantic)", async () => {
    const py = await assertParity({ yaml: "enabled: 0" });
    expect(py.enabled).toBe(false);
  }, 30_000);

  it("knowledge.enabled: no → policy knowledge disabled (nested bool field coerced)", async () => {
    const py = await assertParity({ yaml: "knowledge:\n  enabled: no" });
    expect(py.knowledge.enabled).toBe(false);
  }, 30_000);

  it('schema_version: "2" → 2 (quoted numeric string coerced to int, as Pydantic)', async () => {
    const py = await assertParity({ yaml: 'schema_version: "2"' });
    expect(py.schema_version).toBe(2);
  }, 30_000);

  it("schema_version: 1_000 → 1000 (YAML 1.2 yields STRING '1_000'; underscore-grouped int coerced)", async () => {
    const py = await assertParity({ yaml: "schema_version: 1_000" });
    expect(py.schema_version).toBe(1000);
  }, 30_000);

  it("max_findings_per_file: true → 1 (bool→int, as Pydantic; in-bounds 1..100)", async () => {
    const py = await assertParity({ yaml: "max_findings_per_file: true" });
    expect(py.max_findings_per_file).toBe(1);
  }, 30_000);
});

describe("YAML-1.1↔1.2 fidelity corpus — RESIDUAL (known divergence; NOT bridged, documented)", () => {
  // RESIDUAL: YAML 1.1 only — sexagesimal. PyYAML 1.1 reads `1:30` as base-60 int 1*60+30 = 90 (in 1..100
  // bounds → accepted). js-yaml 1.2 reads the STRING "1:30"; strict z.number().int() rejects → whole
  // config → defaults (max_findings_per_file = 10). The normalizer does NOT bridge this: bridging would
  // require a YAML-1.1 parser to even recover the sexagesimal int, and no real .codemaster.yaml writes a
  // base-60 finding cap. Pinned so it can never silently regress into "we think they match".
  it("sexagesimal max_findings_per_file: 1:30 — PY=90 (1.1 base-60) vs TS=10 (default; 1.2 string reject)", async () => {
    const { ts, py } = await bothSides({ yaml: "max_findings_per_file: 1:30" });
    expect(py.max_findings_per_file).toBe(90); // PyYAML 1.1: 1*60 + 30
    expect(ts.max_findings_per_file).toBe(10); // js-yaml 1.2: string "1:30" → strict reject → default
  }, 30_000);

  // RESIDUAL: YAML 1.1 only — leading-zero octal. PyYAML 1.1 reads `017` as octal int 15. js-yaml 1.2
  // reads it as DECIMAL int 17 (1.2 dropped leading-zero octal). Both sides get a valid int, but a
  // DIFFERENT one — a true value divergence the normalizer cannot bridge (the byte difference is consumed
  // inside the YAML parser, not at the scalar-coercion boundary this layer owns).
  it("octal schema_version: 017 — PY=15 (1.1 octal) vs TS=17 (1.2 decimal)", async () => {
    const { ts, py } = await bothSides({ yaml: "schema_version: 017" });
    expect(py.schema_version).toBe(15); // PyYAML 1.1: octal 017 = 15
    expect(ts.schema_version).toBe(17); // js-yaml 1.2: decimal 17
  }, 30_000);

  // RESIDUAL: YAML 1.1 only — `0o17` prefix. PyYAML 1.1 has NO 0o octal syntax → reads the STRING "0o17";
  // strict z.number().int() rejects → defaults (schema_version = 1). js-yaml 1.2 reads octal int 15.
  it("octal schema_version: 0o17 — PY=1 (1.1 string reject → default) vs TS=15 (1.2 octal)", async () => {
    const { ts, py } = await bothSides({ yaml: "schema_version: 0o17" });
    expect(py.schema_version).toBe(1); // PyYAML 1.1: string "0o17" → strict reject → default
    expect(ts.schema_version).toBe(15); // js-yaml 1.2: octal 0o17 = 15
  }, 30_000);

  // RESIDUAL: YAML 1.1 only — bool words inside a string list. PyYAML 1.1 reads `[yes, no]` as
  // `[True, False]` (booleans), which `ignore_paths: tuple[str, ...]` REJECTS (bool is not str under
  // strict-by-default Pydantic here) → whole config → defaults (ignore_paths = []). js-yaml 1.2 reads
  // `["yes", "no"]` (strings) → valid str list → ignore_paths = ["yes", "no"]. The normalizer leaves list
  // ELEMENTS untouched by design (only scalar bool/int FIELDS are coerced), so this is residual.
  it("bools-in-string-list ignore_paths: [yes, no] — PY=[] (1.1 bools → reject → default) vs TS=['yes','no']", async () => {
    const { ts, py } = await bothSides({ yaml: "ignore_paths: [yes, no]" });
    expect((py as unknown as { ignore_paths: ReadonlyArray<string> }).ignore_paths).toEqual([]);
    expect(ts.ignore_paths).toEqual(["yes", "no"]); // js-yaml 1.2: string list, accepted verbatim
  }, 30_000);

  // RESIDUAL: YAML 1.1 only — bool words nested inside the OPAQUE `policy` block. PyYAML 1.1 yields
  // `{k: {b: [True, False]}}`; js-yaml 1.2 yields `{k: {b: ["yes", "no"]}}`. `policy` is reserved-for-v2
  // opaque data (z.record of unknown) — the normalizer NEVER touches it (criterion: leave opaque/policy
  // untouched), so the inner scalars diverge exactly as the two parsers diverge.
  it("policy: {k: {b: [yes, no]}} — PY inner=[true,false] (1.1 bools) vs TS inner=['yes','no'] (1.2 strings)", async () => {
    const { ts, py } = await bothSides({ yaml: "policy:\n  k:\n    b: [yes, no]" });
    const pyInner = (py as unknown as { policy: { k: { b: ReadonlyArray<unknown> } } }).policy.k.b;
    const tsInner = (ts as { policy: { k: { b: ReadonlyArray<unknown> } } }).policy.k.b;
    expect(pyInner).toEqual([true, false]); // PyYAML 1.1: booleans inside the opaque block
    expect(tsInner).toEqual(["yes", "no"]); // js-yaml 1.2: strings; opaque block left UNTOUCHED
  }, 30_000);

  // RESIDUAL: YAML 1.1/1.2 spec divergence — duplicate mapping keys. PyYAML accepts and keeps the LAST
  // (`enabled: false` → enabled disabled). js-yaml THROWS a YAMLException on the duplicate key → the
  // parse-error fail-open branch → defaults (enabled = true, its default). The normalizer never runs (the
  // throw is upstream of it), so this is a parser-layer residual, not a coercion one.
  it("duplicate-key enabled: true\\nenabled: false — PY=false (1.1 last-wins) vs TS=true (1.2 throws → default)", async () => {
    const { ts, py } = await bothSides({ yaml: "enabled: true\nenabled: false" });
    expect(py.enabled).toBe(false); // PyYAML: duplicate key → last value wins → disabled
    expect(ts.enabled).toBe(true); // js-yaml: YAMLException → parse-error fail-open → default (true)
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The registered activity wrapper — `loadRepoConfigActivity(input: LoadRepoConfigInputV1)` delegates to
// `loadRepoConfig(input.workspace_path)`. The input was ALREADY a typed single-positional envelope on the
// frozen Python side (NO invariant-11 closure work), so this covers the wrapper's delegation + fail-open
// only (the loader itself is byte-parity-tested above).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("loadRepoConfigActivity wrapper (already-typed envelope; no inv-11 work)", () => {
  it("delegates to loadRepoConfig and returns the validated config for a valid workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "config-activity-"));
    tempDirs.push(workspace);
    writeFileSync(join(workspace, ".codemaster.yaml"), "severity_min: issue\n", "utf-8");

    const input = LoadRepoConfigInputV1.parse({ workspace_path: workspace });
    const cfg = await loadRepoConfigActivity(input);
    expect(cfg.severity_min).toBe("issue");
    expect(cfg.enabled).toBe(true);
  });

  it("fails open to defaults for a workspace with no .codemaster.yaml (never throws)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "config-activity-"));
    tempDirs.push(workspace);
    const input = LoadRepoConfigInputV1.parse({ workspace_path: workspace });
    const cfg = await loadRepoConfigActivity(input);
    expect(cfg).toEqual(CodemasterConfigV1.parse({}));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// LoadRepoConfigInputV1 envelope — the ALREADY-PORTED typed contract (no inv-11 closure here). Validation
// smoke only (the contract has its own dedicated parity test).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("LoadRepoConfigInputV1 envelope (already-typed; validation smoke)", () => {
  it("accepts a valid {workspace_path} and applies the schema_version default", () => {
    const parsed = LoadRepoConfigInputV1.parse({ workspace_path: "/tmp/ws" });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.workspace_path).toBe("/tmp/ws");
  });

  it("rejects an empty workspace_path (min_length=1)", () => {
    expect(() => LoadRepoConfigInputV1.parse({ workspace_path: "" })).toThrow();
  });

  it("rejects unknown top-level keys (.strict())", () => {
    expect(() => LoadRepoConfigInputV1.parse({ workspace_path: "/tmp/ws", bogus: true })).toThrow();
  });
});
