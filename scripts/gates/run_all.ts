// Aggregate gate runner (Task 0.4 + W0.11). Runs every ported CI gate; exits non-zero if any
// ERROR-mode gate reports a blocking violation. WARN-mode gates report to stderr but return 0.
//
// W0.11 (XC2/XH1) ported the four LOAD-BEARING bug-class gates (each maps to a real shipped Python
// incident); the no-temporal-imports gate locks the de-Temporal teardown. (The python-oracle gate
// was retired with the Python parity suite — the port is complete + covered by the TS test battery.)
import { main as tenantScopedRawSql } from "./check_tenant_scoped_raw_sql.js";
import { main as exemptedListsPointed } from "./check_exempted_lists_pointed.js";
import { main as exemptedRotationAge } from "./check_exempted_rotation_age.js";
import { main as clockRandom } from "./check_clock_random.js";
// W0.11 — the four bug-class gates (each maps to a real shipped Python incident):
import { main as unsafeMigrationPattern } from "./check_unsafe_migration_pattern.js";
import { main as activityInputJsonSafe } from "./check_activity_input_json_safe.js";
import { main as llmOutputParsersUseCoercion } from "./check_llm_output_parsers_use_coercion.js";
import { main as workflowSilentDegradation } from "./check_workflow_silent_degradation.js";
// Teardown lock — fails if any @temporalio module reference reappears after the de-Temporal removal.
import { main as noTemporalImports } from "./check_no_temporal_imports.js";

const gates: Array<() => number> = [
  tenantScopedRawSql,
  exemptedListsPointed,
  exemptedRotationAge,
  clockRandom,
  unsafeMigrationPattern,
  activityInputJsonSafe,
  llmOutputParsersUseCoercion,
  workflowSilentDegradation,
  noTemporalImports,
];

let rc = 0;
for (const gate of gates) {
  rc = gate() || rc;
}
process.exit(rc);
