// ActivityError — de-Temporal replacement for `ApplicationFailure` on the review-pipeline activity
// surfaces (post_review_results / record_delivery_lifecycle / review_activity) and the posting.ts
// dropped-state reader.
//
// In the Postgres runtime there is no Temporal retry policy: the runner classifies retries by the error's
// `name` (CS4.3 / W1.9c, runner/retry_policies.ts) and the in-process call propagates the error DIRECTLY
// (no ActivityFailure boundary wrapping). So this plain Error subclass preserves all three carriers — its
// `name` IS the old `type` string (so the name-match classifier is unchanged), with `nonRetryable` and
// `details` as own properties. The constructor mirrors `ApplicationFailure.create`'s arg shape so the
// throw sites change minimally.

export class ActivityError extends Error {
  /** Fail-fast hint — the runner's name-match classifier is the authority on the review path; this is
   *  carried for any caller that inspects it. */
  public readonly nonRetryable: boolean;
  /** Carrier array — the H-2 dropped-state payload rides `details[0]`. */
  public readonly details: ReadonlyArray<unknown>;

  public constructor(args: {
    message: string;
    /** The error NAME (was ApplicationFailure `type`) the retry classifier matches on. */
    type: string;
    nonRetryable?: boolean;
    details?: ReadonlyArray<unknown>;
  }) {
    super(args.message);
    this.name = args.type;
    this.nonRetryable = args.nonRetryable ?? false;
    this.details = args.details ?? [];
  }
}

/** Narrow an unknown error (and its `cause` chain) to an {@link ActivityError}, or null. The cause walk
 *  keeps the posting.ts dropped-state reader robust if a future seam wraps the error. */
export function asActivityError(err: unknown): ActivityError | null {
  if (err instanceof ActivityError) {
    return err;
  }
  if (err instanceof Error && err.cause instanceof ActivityError) {
    return err.cause;
  }
  return null;
}
