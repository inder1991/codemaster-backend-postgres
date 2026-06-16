/**
 * Page-approval OTel metric helpers (Option C, Phase 5 / D9). Net-new TS instrument observing the
 * best-effort resync-enqueue failure on the approval path — the approval COMMITS even if the resync
 * dispatch fails (the 6h cron is the safety net), so the failure is otherwise invisible. Mirrors the
 * sibling metric modules (confluence_ingest_metrics.ts / confluence_token_metrics.ts): lazy instrument
 * construction through the `#platform/observability/metrics.js::getMeter` seam (a NO-OP Meter when no
 * MeterProvider is registered, so emission is safe before the exporter is wired), bounded cardinality
 * (NO labels — the platform-wide failure rate is the alertable signal; the per-page detail rides the
 * structured WARN log next to each emit).
 */

import { getMeter, type Counter } from "#platform/observability/metrics.js";

/** Approvals whose best-effort page-resync enqueue FAILED (the approval still committed). Grafana-query
 *  stable; renaming requires an ADR. */
export const APPROVAL_RESYNC_ENQUEUE_FAILED_NAME =
  "codemaster_page_approval_resync_enqueue_failed_total";

let resyncEnqueueFailed: Counter | null = null;

/** Record ONE approval whose page-resync enqueue failed (best-effort dispatch, no rollback). Bounded: no labels. */
export function recordApprovalResyncEnqueueFailed(): void {
  resyncEnqueueFailed ??= getMeter("codemaster.page_approval").createCounter(
    APPROVAL_RESYNC_ENQUEUE_FAILED_NAME,
    {
      description:
        "Page approvals whose best-effort trigger_page_resync enqueue failed (approval committed; cron is the safety net)",
    },
  );
  resyncEnqueueFailed.add(1);
}
