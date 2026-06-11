// Shared gate for DB-integration tests.
//
// Integration tests run ONLY when CODEMASTER_PG_CORE_DSN is EXPLICITLY set — pointing at a disposable
// Postgres with the migrations applied (see tools/squash + `npm run migrate:up`).
//
// W0.11 (XC2 — fail-loud when security tiers are unexercised): what happens WITHOUT a DSN depends on
// where we are. Locally, the tier SKIPS (a dev without a database must still run `npm run test` green;
// a [SKIP-CENSUS] line makes the skip visible, never silent). Under CI (env `CI` truthy) the tier
// FAILS at collect time instead: a CI job that forgot to provision the DB previously went green with
// the ENTIRE integration tier — DB fences, tenancy, crash-recovery, the security suites — unexercised.
//
// NEVER hard-default the DSN in an integration test — a default makes `vitest run` attempt a live
// connection (ECONNREFUSED) wherever no PG is listening. Import { describeDb, INTEGRATION_DSN } here.
import { describe } from "vitest";

export const INTEGRATION_DSN: string | undefined = process.env["CODEMASTER_PG_CORE_DSN"];

/** Pure decision seam (unit-tested in test/gates/db_suite_mode.test.ts): how a DB-gated suite
 *  behaves for a given environment. CI is truthy per the conventional vocabulary ("", "0", "false"
 *  mean NOT CI — some local tools export CI=false). */
export function dbSuiteMode(env: {
  CODEMASTER_PG_CORE_DSN?: string | undefined;
  CI?: string | undefined;
}): "run" | "skip" | "fail" {
  const dsn = env.CODEMASTER_PG_CORE_DSN;
  if (dsn !== undefined && dsn !== "") {
    return "run";
  }
  const ci = env.CI;
  const ciTruthy = ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
  return ciTruthy ? "fail" : "skip";
}

const MODE = dbSuiteMode(process.env);

if (MODE === "fail") {
  // Collect-time fail-loud: every DB-gated test FILE imports this module, so the throw names the
  // failure once per file in the CI log — impossible to mistake for a green tier.
  throw new Error(
    "CI requires CODEMASTER_PG_CORE_DSN: the DB-integration tier must be EXERCISED in CI, not " +
      "skipped (W0.11/XC2). Provision the disposable Postgres and set the DSN, or run this lane " +
      "without CI to accept the local skip posture.",
  );
}
if (MODE === "skip") {
  // The skipped-test census (W0.11): one structured line per vitest process so a skipped tier is
  // always VISIBLE in the run output, never silent.
  console.warn(
    "[SKIP-CENSUS] DB-integration tier SKIPPED: CODEMASTER_PG_CORE_DSN unset " +
      "(local no-database posture; under CI this is a hard failure)",
  );
}

/** `describe` when a DB DSN is configured, else `describe.skip` (locally) — CI fails above. */
export const describeDb = MODE === "run" ? describe : describe.skip;
