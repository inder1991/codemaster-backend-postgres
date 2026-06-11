// W0.11 (XC2): the frozen-Python oracle (the vendor/codemaster-py submodule) must be PRESENT in
// CI — the parity suites, the dualrun scripts, and the ported gates all reference it, and an
// uninitialized submodule silently turns "verified against the frozen Python" into "verified
// against nothing". The gate: under CI (env CI truthy) a missing/empty vendor/codemaster-py is an
// ERROR (validate-fast prepends `git submodule update --init`, so a failing gate means the clone
// itself is broken); locally it is a WARN (a fresh clone without submodules must still lint/build).
import { describe, expect, it } from "vitest";
import { oracleGateOutcome } from "../../scripts/gates/check_python_oracle_present.js";

describe("check_python_oracle_present (W0.11)", () => {
  it("present oracle → pass everywhere", () => {
    expect(oracleGateOutcome({ present: true, ci: true })).toBe("pass");
    expect(oracleGateOutcome({ present: true, ci: false })).toBe("pass");
  });

  it("missing oracle under CI → ERROR (rc 1)", () => {
    expect(oracleGateOutcome({ present: false, ci: true })).toBe("error");
  });

  it("missing oracle locally → WARN only (a fresh clone must still build)", () => {
    expect(oracleGateOutcome({ present: false, ci: false })).toBe("warn");
  });

  it("the real repo (submodule initialized in this worktree) passes the live check", async () => {
    const { main } = await import("../../scripts/gates/check_python_oracle_present.js");
    expect(main()).toBe(0);
  });
});
