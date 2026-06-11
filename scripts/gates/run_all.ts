// Aggregate gate runner (Task 0.4 + W0.11). Runs every ported CI gate; exits non-zero if any
// ERROR-mode gate reports a blocking violation. WARN-mode gates report to stderr but return 0.
//
// W0.11 (XC2/XH1) ports the four LOAD-BEARING bug-class gates (each maps to a real shipped Python
// incident) plus the python-oracle presence check; the remaining ~31 Python gates stay deferred to
// land alongside the subsystems they guard — tracked in the master hardening plan (Tier 5 / W5.3).
import { main as tenantScopedRawSql } from "./check_tenant_scoped_raw_sql.js";
import { main as exemptedListsPointed } from "./check_exempted_lists_pointed.js";
import { main as exemptedRotationAge } from "./check_exempted_rotation_age.js";
import { main as clockRandom } from "./check_clock_random.js";
import { main as pythonOraclePresent } from "./check_python_oracle_present.js";
// W0.11 — the four bug-class gates (each maps to a real shipped Python incident):
import { main as unsafeMigrationPattern } from "./check_unsafe_migration_pattern.js";
import { main as activityInputJsonSafe } from "./check_activity_input_json_safe.js";
import { main as llmOutputParsersUseCoercion } from "./check_llm_output_parsers_use_coercion.js";
import { main as workflowSilentDegradation } from "./check_workflow_silent_degradation.js";

const gates: Array<() => number> = [
  tenantScopedRawSql,
  exemptedListsPointed,
  exemptedRotationAge,
  clockRandom,
  pythonOraclePresent,
  unsafeMigrationPattern,
  activityInputJsonSafe,
  llmOutputParsersUseCoercion,
  workflowSilentDegradation,
];

let rc = 0;
for (const gate of gates) {
  rc = gate() || rc;
}
process.exit(rc);
