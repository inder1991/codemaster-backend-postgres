// Finding-feedback write — 1:1 port of finding_feedback.py PostgresFindingFeedbackRepo. Operators react
// to a review finding from the admin review-detail page. One transaction:
//   1. tenancy + path-coherence check (the finding must belong to this installation AND to the PR the
//      review_id maps to: review_findings → pull_request_reviews → repositories → pull_requests). → 404.
//   2. INSERT core.feedback_events with the ENCRYPTED raw_payload (AES-256-GCM + AAD).
//   3. emit one audit event (deferred no-op seam today).
//
// VERB→KIND collapse: helpful→thumbs_up, not_helpful→thumbs_down, wrong→thumbs_down — 'wrong' is
// indistinguishable from 'not_helpful' in the kind column; the discriminator lives only in raw_payload.verb.

import { type Kysely, sql } from "kysely";

import type { KeyRegistry } from "#platform/crypto/key_registry.js";

import {
  FEEDBACK_RAW_PAYLOAD_AAD,
  encryptJsonByteaWithRegistry,
} from "#backend/security/audit_field_codec.js";

/** Optional audit-emit seam (same structural shape as the other admin write flows; dormant no-op today). */
export type AdminAuditEmitter = (e: {
  actorUserId: string;
  installationId: string;
  action: string;
  targetKind: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  now: Date;
}) => Promise<void>;

const VERB_TO_KIND: Record<"helpful" | "not_helpful" | "wrong", string> = {
  helpful: "thumbs_up",
  not_helpful: "thumbs_down",
  wrong: "thumbs_down",
};

/** Submit feedback on a review finding. Returns the new feedback_event_id, or null when the finding isn't
 *  in the caller's tenant / doesn't match the review (→ route 404). */
export async function submitFindingFeedback(
  db: Kysely<unknown>,
  args: {
    reviewId: string;
    findingId: string;
    installationId: string;
    verb: "helpful" | "not_helpful" | "wrong";
    actorUserId: string;
    now: Date;
    registry: KeyRegistry;
    audit?: AdminAuditEmitter | undefined;
  },
): Promise<string | null> {
  const kind = VERB_TO_KIND[args.verb];
  const rawPayload = { verb: args.verb, user_id: args.actorUserId };

  const feedbackEventId = await db.transaction().execute(async (tx) => {
    const exists = await sql`
      SELECT 1
      FROM core.review_findings rf
      JOIN core.pull_request_reviews rev ON rev.review_id = ${args.reviewId}
      JOIN core.repositories repo        ON repo.github_repo_id = rev.repo_id
      JOIN core.pull_requests pull       ON pull.repository_id = repo.repository_id AND pull.pr_number = rev.pr_number
      WHERE rf.review_finding_id = ${args.findingId}
        AND rf.pr_id = pull.pr_id
        AND rf.installation_id = ${args.installationId}
    `.execute(tx);
    if (exists.rows.length === 0) {
      return null;
    }
    // raw_payload is encrypted under the column AAD with the injected registry (no module-global state).
    const payloadBytes = encryptJsonByteaWithRegistry(rawPayload, FEEDBACK_RAW_PAYLOAD_AAD, args.registry);
    const ins = await sql<{ feedback_event_id: string }>`
      INSERT INTO core.feedback_events (installation_id, review_finding_id, kind, raw_payload, created_at)
      VALUES (${args.installationId}, ${args.findingId}, ${kind}, ${payloadBytes}, ${args.now})
      RETURNING feedback_event_id
    `.execute(tx);
    return ins.rows[0]!.feedback_event_id;
  });

  if (feedbackEventId === null) {
    return null;
  }
  await args.audit?.({
    actorUserId: args.actorUserId,
    installationId: args.installationId,
    action: `finding_feedback.${kind}`,
    targetKind: "feedback_event",
    targetId: feedbackEventId,
    before: null,
    after: { kind, review_finding_id: args.findingId },
    now: args.now,
  });
  return feedbackEventId;
}
