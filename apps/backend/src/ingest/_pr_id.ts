// derivePrId — deterministic internal PR identity: uuid5 over (installation_id, repository_id,
// pr_number), stable across webhook redeliveries + workflow replays.

import { uuid5 } from "#platform/randomness.js";

/** The frozen uuid5 namespace. MUST NOT change — it would re-key every PR. */
export const PR_ID_NAMESPACE = "e6c2c4f4-f8e4-4a3b-8e6e-2a8b4f1f9c1d";

/** Derive the internal pr_id: `uuid5(PR_ID_NAMESPACE, "{installationId}/{repositoryId}/{prNumber}")`. */
export function derivePrId(args: {
  installationId: string;
  repositoryId: string;
  prNumber: number;
}): string {
  return uuid5(PR_ID_NAMESPACE, `${args.installationId}/${args.repositoryId}/${args.prNumber}`);
}
