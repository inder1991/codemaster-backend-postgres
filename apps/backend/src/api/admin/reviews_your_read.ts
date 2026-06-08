// Your-reviews repo — Pattern A foundation (returns empty). A later phase wires the engineer-identity link
// (core.gh_users + PR assignment) so a signed-in engineer sees the reviews they authored / are assigned.
// Protocol: authored + assigned both return empty arrays today; the route shape is already final.

import { type Kysely } from "kysely";

import type { ReviewListItemV1 } from "#contracts/admin.v1.js";

/** Reviews the user authored. Pattern A: empty until the engineer-identity join lands. */
export async function authoredBy(
  db: Kysely<unknown>,
  args: { installationId: string; userId: string },
): Promise<Array<ReviewListItemV1>> {
  void db; // captured to match the final signature; the join is a follow-up phase.
  void args;
  return [];
}

/** Reviews the user is assigned to. Pattern A: empty until the assignment join lands. */
export async function assignedTo(
  db: Kysely<unknown>,
  args: { installationId: string; userId: string },
): Promise<Array<ReviewListItemV1>> {
  void db;
  void args;
  return [];
}

export async function buildYourReviews(
  db: Kysely<unknown>,
  args: { installationId: string; userId: string },
): Promise<{ authored: Array<ReviewListItemV1>; assigned: Array<ReviewListItemV1> }> {
  const authored = await authoredBy(db, args);
  const assigned = await assignedTo(db, args);
  return { authored, assigned };
}
