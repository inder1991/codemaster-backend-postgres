// W1.9d (RC5) — per-workflow-type retry budgets must survive the cutover map. The Temporal proxies
// carried tuned per-workflow curves (reconcile_repositories 10 attempts to absorb out-of-order
// webhook delivery — H4; the hydrate/repair 12-attempt window to ride bursty GitHub outages);
// without an explicit budget table every cutover enqueue collapses to BackgroundJobsRepo's
// max_attempts default (3) and an out-of-order `installation_repositories` dead-letters in ~3s.

import { describe, expect, it } from "vitest";

import { JOB_TYPE_MAX_ATTEMPTS, WORKFLOW_TYPE_TO_JOB_TYPE } from "#backend/runner/workflow_job_map.js";

describe("JOB_TYPE_MAX_ATTEMPTS — the Temporal-parity attempt budgets (RC5) [W1.9d]", () => {
  it("every mapped job_type carries an explicit budget (a newly-migrated workflow_type must DECIDE one)", () => {
    const mappedJobTypes = [...new Set(Object.values(WORKFLOW_TYPE_TO_JOB_TYPE))].sort();
    expect(Object.keys(JOB_TYPE_MAX_ATTEMPTS).sort()).toEqual(mappedJobTypes);
  });

  it("budgets are 1:1 with the Temporal proxies they replace (the parity sources in the map's doc)", () => {
    expect(JOB_TYPE_MAX_ATTEMPTS).toEqual({
      reconcile_installation: 5, //               reconcile.workflow.ts:71-77   (1s initial, 5 attempts)
      reconcile_repositories: 10, //              reconcile.workflow.ts:98-103  (5s initial, 10 — H4 out-of-order window)
      repair_installation_repositories: 12, //    reconcile.workflow.ts:127-134 (10s→300s ×2.0, 12 — GitHub-outage window)
      sync_code_owners: 5, //                     sync_code_owners.workflow.ts:61-64 (2s initial, 5)
      refresh_semantic_docs: 3, //                refresh_semantic_docs.workflow.ts:77-81 + :103-106 (both steps 3)
      trigger_page_resync: 3, //                  trigger_page_resync.workflow.ts:65-67 (10s→2m, 3)
    });
  });
});
