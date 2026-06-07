// Two-person-approval predicate helpers — 1:1 port of
// vendor/codemaster-py/codemaster/api/admin/_two_person_approval.py.
//
// Each predicate is PURE (no I/O, no clock beyond the `now` passed in) so the admin pending-change flows
// (members, cost-caps, flags) can compose them regardless of their storage shape. Each raises a
// TwoPersonApprovalError subclass carrying the relevant context; consumers catch and re-raise their own
// typed, HTTP-mappable errors (`... from err`).

/** Base for every shared two-person-approval predicate error. */
export class TwoPersonApprovalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TwoPersonApprovalError";
  }
}

/** Requester and approver are the same user. Carries the offending id. */
export class SelfApprovalError extends TwoPersonApprovalError {
  public readonly userId: string;
  public constructor(userId: string) {
    super(`two-person rule violated: user ${userId} cannot approve their own request`);
    this.name = "SelfApprovalError";
    this.userId = userId;
  }
}

/** A pending change's TTL has elapsed. Carries the original expires_at. */
export class ExpiredApprovalError extends TwoPersonApprovalError {
  public readonly expiresAt: Date;
  public constructor(expiresAt: Date) {
    super(`pending change expired at ${expiresAt.toISOString()}; resubmit the request`);
    this.name = "ExpiredApprovalError";
    this.expiresAt = expiresAt;
  }
}

/** A state transition would move from a non-expected state (double-apply / approve-after-reject). */
export class StalePendingStateError extends TwoPersonApprovalError {
  public readonly actualState: string;
  public readonly expectedState: string;
  public constructor(args: { actualState: string; expectedState: string }) {
    super(`pending change in state '${args.actualState}', not '${args.expectedState}'`);
    this.name = "StalePendingStateError";
    this.actualState = args.actualState;
    this.expectedState = args.expectedState;
  }
}

/** Raise {@link SelfApprovalError} if requester === approver. The two-person rule: a pending change
 *  needs two distinct users. Refused BEFORE any state transition so audit sees a clean rejection. */
export function checkSelfApproval(args: { requesterUserId: string; approverUserId: string }): void {
  if (args.requesterUserId === args.approverUserId) {
    throw new SelfApprovalError(args.requesterUserId);
  }
}

/** Raise {@link ExpiredApprovalError} if `expiresAt <= now`. `null` = no expiry. The exact-equality
 *  boundary is treated as expired (the TTL has elapsed at this instant). */
export function checkNotExpired(args: { expiresAt: Date | null; now: Date }): void {
  if (args.expiresAt === null) {
    return;
  }
  if (args.expiresAt.getTime() <= args.now.getTime()) {
    throw new ExpiredApprovalError(args.expiresAt);
  }
}

/** Raise {@link StalePendingStateError} if `state !== expected` (default `'pending'`). */
export function checkPendingState(args: { state: string; expected?: string }): void {
  const expected = args.expected ?? "pending";
  if (args.state !== expected) {
    throw new StalePendingStateError({ actualState: args.state, expectedState: expected });
  }
}
