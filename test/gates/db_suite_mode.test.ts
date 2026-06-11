// W0.11 (XC2 — validate-fast fail-loud): the DB-integration tier must be EXERCISED in CI, not
// silently skipped. Pre-W0.11, test/integration/_db.ts mapped a missing CODEMASTER_PG_CORE_DSN to
// describe.skip unconditionally — so a CI job that forgot to provision the DB went green with the
// ENTIRE integration tier (DB fences, tenancy, crash-recovery, the security suites) unexercised.
// dbSuiteMode is the pure decision seam:
//   * DSN set            → 'run'   (any environment)
//   * DSN missing, no CI → 'skip'  (local dev without a DB stays green — unchanged posture)
//   * DSN missing, CI=1  → 'fail'  (describeDb THROWS at collect time: loud, named, per-file)
import { describe, expect, it } from "vitest";
import { dbSuiteMode } from "../integration/_db.js";

describe("dbSuiteMode (W0.11 fail-loud)", () => {
  it("runs when the DSN is set — CI or not", () => {
    expect(dbSuiteMode({ CODEMASTER_PG_CORE_DSN: "postgresql://x" })).toBe("run");
    expect(dbSuiteMode({ CODEMASTER_PG_CORE_DSN: "postgresql://x", CI: "1" })).toBe("run");
  });

  it("skips locally (no CI) when the DSN is missing — the dev-without-a-DB posture is unchanged", () => {
    expect(dbSuiteMode({})).toBe("skip");
    expect(dbSuiteMode({ CODEMASTER_PG_CORE_DSN: "" })).toBe("skip");
  });

  it("FAILS (not skips) under CI when the DSN is missing — an unexercised tier can never go green", () => {
    expect(dbSuiteMode({ CI: "1" })).toBe("fail");
    expect(dbSuiteMode({ CI: "true" })).toBe("fail");
    expect(dbSuiteMode({ CI: "1", CODEMASTER_PG_CORE_DSN: "" })).toBe("fail");
  });

  it("CI explicitly falsy behaves as local", () => {
    expect(dbSuiteMode({ CI: "" })).toBe("skip");
    expect(dbSuiteMode({ CI: "0" })).toBe("skip");
    expect(dbSuiteMode({ CI: "false" })).toBe("skip");
  });
});
