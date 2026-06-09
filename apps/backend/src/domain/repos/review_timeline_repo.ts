// Review-timeline persistence — port of review_timeline.py + the Day-1 PostgresReviewTimelineRepo.
// Three methods: getWebhook, getOutbox, getBedrock. External chains (Temporal/Langfuse/GitHub) are
// Day-1 shims wired at the route layer (return null + warnings). These are cross-tenant
// PLATFORM-operator by-delivery_id lookups (operator inspecting a single delivery across all tenants),
// so each tenant-scoped raw SELECT carries a `// tenant:exempt reason=operator-inspection` marker.
//
// Live-schema adaptations vs the Python-derived plan:
//   - core.outbox PK is `id` (not `outbox_id`); the workflow handle lives in `run_id` (uuid). state ∈
//     {pending,dispatched,dead} (the live CHECK), surfaced verbatim into OutboxRowV1.state.
//   - telemetry.llm_calls has NO `delivery_id` column (only request_id / installation_id / created_at),
//     so there is no by-delivery join to issue. getBedrock returns [] — faithful to the frozen Python
//     `_InMemoryReviewTimelineRepo.get_bedrock_calls` which returned () (the PostgresReviewTimelineRepo
//     adapter was never authored). Production wiring is a tracked follow-up
//     (FOLLOW-UP-review-timeline-bedrock-by-delivery): it needs a delivery_id↔llm_call linkage column
//     that does not yet exist on telemetry.llm_calls.

import { type Kysely, sql } from "kysely";

import type { LlmCallV1, OutboxRowV1, WebhookEventV1 } from "#contracts/admin.v1.js";

export class ReviewTimelineRepo {
  public constructor(private db: Kysely<unknown>) {}

  public async getWebhook(deliveryId: string): Promise<WebhookEventV1 | null> {
    // tenant:exempt reason=operator-inspection-by-delivery_id follow_up=PERMANENT-EXEMPTION-review-timeline-operator
    const res = await sql<{
      webhook_event_id: string;
      installation_id: string | null;
      event_type: string;
      received_at: Date;
    }>`
      SELECT webhook_event_id, installation_id, event_type, received_at
      FROM audit.webhook_events
      WHERE delivery_id = ${deliveryId}
      ORDER BY received_at DESC
      LIMIT 1
    `.execute(this.db);

    const row = res.rows[0];
    if (!row) {
      return null;
    }

    return {
      schema_version: 1,
      webhook_event_id: row.webhook_event_id,
      installation_id: row.installation_id,
      event_type: row.event_type,
      received_at: row.received_at,
    };
  }

  public async getOutbox(deliveryId: string): Promise<OutboxRowV1 | null> {
    // tenant:exempt reason=operator-inspection-by-delivery_id follow_up=PERMANENT-EXEMPTION-review-timeline-operator
    const res = await sql<{
      id: string;
      sink: string;
      state: string;
      created_at: Date;
      leased_until: Date | null;
      run_id: string | null;
    }>`
      SELECT id, sink, state, created_at, leased_until, run_id
      FROM core.outbox
      WHERE delivery_id = ${deliveryId}
      ORDER BY created_at DESC
      LIMIT 1
    `.execute(this.db);

    const row = res.rows[0];
    if (!row) {
      return null;
    }

    return {
      schema_version: 1,
      outbox_id: row.id,
      sink: row.sink,
      state: row.state as "pending" | "dispatched" | "dead",
      created_at: row.created_at,
      leased_until: row.leased_until,
      // The outbox stores the Temporal workflow handle in core.outbox.run_id (uuid); surface it as the
      // contract's workflow_id (string). Distinct from the workflow-status chain (Day-1 shim, route layer).
      workflow_id: row.run_id,
    };
  }

  public async getBedrock(deliveryId: string): Promise<Array<LlmCallV1>> {
    void deliveryId; // no delivery_id linkage column on telemetry.llm_calls yet (see header note).
    // telemetry.llm_calls has no delivery_id linkage column yet, so there is no by-delivery query to
    // issue. Faithful to the frozen Python shim (returned ()). Production wiring is a tracked follow-up
    // (FOLLOW-UP-review-timeline-bedrock-by-delivery). Returns [] — the route renders bedrock_calls: [].
    return [];
  }
}
