/**
 * Activity registry — the map the worker passes to `Worker.create({ activities })`. A thin re-export so
 * the worker bootstrap (`main.ts`) and the bundle self-check stay decoupled from the individual activity
 * modules, and so 2.1 grows the registered surface by adding ONE entry here (additively) rather than
 * editing the worker bootstrap.
 *
 * Phase 2.0 walking skeleton: exactly ONE activity. The key MUST match the name the workflow's
 * `proxyActivities<{ persistReviewFindings(...) }>` calls — Temporal resolves the activity by this key.
 */

import { persistReviewFindings } from "../activities/persist_review_findings.activity.js";

/** The activities map the worker registers. Grown additively in Phase 2.1. */
export const activities = { persistReviewFindings };
