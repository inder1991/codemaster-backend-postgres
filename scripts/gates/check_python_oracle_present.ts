// W0.11 (XC2 — fail-loud when security tiers are unexercised): the frozen-Python oracle gate.
//
// The vendor/codemaster-py submodule is the FROZEN ORACLE this port is verified against: the parity
// suites cite it, the dualrun scripts execute it, and the four bug-class gates were ported from its
// scripts/. An uninitialized submodule silently turns "verified against the frozen Python" into
// "verified against nothing" — and `git submodule status` showing a `-` prefix is invisible in a CI
// log nobody reads. The gate makes it loud:
//   * present  → [INFO], rc 0 (everywhere)
//   * missing under CI (env CI truthy) → [ERROR], rc 1 — validate-fast prepends
//     `git submodule update --init`, so reaching this gate without the oracle means the clone/init
//     itself failed; the lane must not pretend its parity claims hold.
//   * missing locally → [WARN], rc 0 — a fresh clone without submodules must still lint/build.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ORACLE_SCRIPTS_DIR = join(process.cwd(), "vendor", "codemaster-py", "scripts");

/** Pure decision seam (unit-tested): outcome for a given (present, ci) pair. */
export function oracleGateOutcome(args: { present: boolean; ci: boolean }): "pass" | "warn" | "error" {
  if (args.present) {
    return "pass";
  }
  return args.ci ? "error" : "warn";
}

/** Is the oracle ACTUALLY usable — the directory exists and carries the gate scripts (an empty
 *  directory is what an uninitialized submodule leaves behind, so existsSync alone is not enough). */
function oraclePresent(): boolean {
  if (!existsSync(ORACLE_SCRIPTS_DIR)) {
    return false;
  }
  try {
    return readdirSync(ORACLE_SCRIPTS_DIR).some((f) => f.startsWith("check_") && f.endsWith(".py"));
  } catch {
    return false;
  }
}

export function main(): number {
  const ci = process.env["CI"];
  const ciTruthy = ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
  const outcome = oracleGateOutcome({ present: oraclePresent(), ci: ciTruthy });
  switch (outcome) {
    case "pass":
      console.info("[INFO] python-oracle gate: vendor/codemaster-py present. ok");
      return 0;
    case "warn":
      console.warn(
        "[WARN] python-oracle gate: vendor/codemaster-py is NOT initialized — parity claims are " +
          "unverifiable in this checkout. Run `git submodule update --init`. (WARN locally; ERROR in CI.)",
      );
      return 0;
    case "error":
      console.error(
        "[ERROR] python-oracle gate: vendor/codemaster-py is missing/empty under CI — the frozen " +
          "Python oracle the parity suites and ported gates reference is absent, so this lane's " +
          "parity claims verify NOTHING. `git submodule update --init` must run before the gates.",
      );
      return 1;
  }
}
