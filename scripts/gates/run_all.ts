// Aggregate gate runner (Task 0.4). Runs every ported CI gate; exits non-zero if any ERROR-mode
// gate reports a blocking violation. WARN-mode gates report to stderr but return 0.
//
// Only the gates whose TS target shape is already stable are ported here. The remaining ~35 Python
// gates are deferred to land alongside the subsystems they guard (Temporal workers, Zod contracts,
// data layer, admin API, etc.) — see docs/plans Task 0.4 classification.
import { main as tenantScopedRawSql } from "./check_tenant_scoped_raw_sql.js";
import { main as exemptedListsPointed } from "./check_exempted_lists_pointed.js";
import { main as exemptedRotationAge } from "./check_exempted_rotation_age.js";
import { main as clockRandom } from "./check_clock_random.js";

const gates: Array<() => number> = [
  tenantScopedRawSql,
  exemptedListsPointed,
  exemptedRotationAge,
  clockRandom,
];

let rc = 0;
for (const gate of gates) {
  rc = gate() || rc;
}
process.exit(rc);
