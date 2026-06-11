/**
 * W4.4 [M6] — a malformed `.codemaster.yaml` must fail OPEN to defaults *with a visible status*,
 * not silently. `loadRepoConfig` was correctly fail-open but returned ONLY the config — the
 * orchestrator could not tell valid-equals-defaults from rejected-malformed, so the Python WARN +
 * `record_config_malformed` observability was a structural no-op and a customer's typo'd opt-out
 * (`enabled: nope` → whole doc rejected → defaults → review stays ON) vanished with zero feedback.
 *
 * `loadRepoConfigWithStatus` returns `{ config, config_status: absent|valid|malformed, reason }`,
 * populated per fail-open branch, plus the ported WARN log (the OTel counter half stays deferred
 * with W0.4/W0.5b per the owner steer). `loadRepoConfig` keeps its exact shape for the byte-parity
 * suite.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { loadRepoConfig, loadRepoConfigWithStatus } from "#backend/config/config_loader.js";
import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";

const dirs: Array<string> = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function ws(yaml?: string): string {
  const d = mkdtempSync(join(tmpdir(), "m6-config-"));
  dirs.push(d);
  if (yaml !== undefined) writeFileSync(join(d, ".codemaster.yaml"), yaml, "utf-8");
  return d;
}

const DEFAULTS = CodemasterConfigV1.parse({});

describe("loadRepoConfigWithStatus (M6)", () => {
  it("missing file → status 'absent', defaults, no reason, NO warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = loadRepoConfigWithStatus(ws());
    expect(r.config_status).toBe("absent");
    expect(r.reason).toBeNull();
    expect(r.config).toEqual(DEFAULTS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("valid document → status 'valid' with the parsed config", () => {
    const r = loadRepoConfigWithStatus(ws("severity_min: issue\n"));
    expect(r.config_status).toBe("valid");
    expect(r.reason).toBeNull();
    expect(r.config.severity_min).toBe("issue");
  });

  it("EMPTY document → status 'valid' (an intentionally-empty config IS the defaults opt-in)", () => {
    const r = loadRepoConfigWithStatus(ws(""));
    expect(r.config_status).toBe("valid");
    expect(r.config).toEqual(DEFAULTS);
  });

  it("YAML syntax error → 'malformed'/'parse_error', defaults, and a structured WARN", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = loadRepoConfigWithStatus(ws("enabled: [unclosed\n  - whoops: {"));
    expect(r.config_status).toBe("malformed");
    expect(r.reason).toBe("parse_error");
    expect(r.config).toEqual(DEFAULTS);
    const records = warn.mock.calls
      .map((c) => c[0])
      .filter((x): x is string => typeof x === "string")
      .flatMap((x) => {
        try {
          const p = JSON.parse(x) as Record<string, unknown>;
          return p["event"] === "repo_config.malformed" ? [p] : [];
        } catch {
          return [];
        }
      });
    expect(records).toHaveLength(1);
    expect(records[0]!["reason"]).toBe("parse_error");
  });

  it("schema-invalid field (max_findings_per_file: 9999) → 'malformed'/'validation_error', FULL defaults", () => {
    const r = loadRepoConfigWithStatus(ws("max_findings_per_file: 9999\nseverity_min: issue\n"));
    expect(r.config_status).toBe("malformed");
    expect(r.reason).toBe("validation_error");
    expect(r.config).toEqual(DEFAULTS); // whole-doc rejection, NOT a partial merge
  });

  it("oversize document (> 50 KiB) → 'malformed'/'oversize', defaults", () => {
    const r = loadRepoConfigWithStatus(ws(`# ${"x".repeat(51 * 1024)}\n`));
    expect(r.config_status).toBe("malformed");
    expect(r.reason).toBe("oversize");
    expect(r.config).toEqual(DEFAULTS);
  });

  it("a directory at the config path → 'absent' (Python is_file() false), defaults", () => {
    const d = ws();
    mkdirSync(join(d, ".codemaster.yaml"));
    const r = loadRepoConfigWithStatus(d);
    expect(r.config_status).toBe("absent");
    expect(r.config).toEqual(DEFAULTS);
  });

  it("loadRepoConfig (the parity surface) still returns the BARE config on every branch", () => {
    expect(loadRepoConfig(ws("severity_min: issue\n")).severity_min).toBe("issue");
    expect(loadRepoConfig(ws("max_findings_per_file: 9999\n"))).toEqual(DEFAULTS);
    expect(loadRepoConfig(ws())).toEqual(DEFAULTS);
  });
});
