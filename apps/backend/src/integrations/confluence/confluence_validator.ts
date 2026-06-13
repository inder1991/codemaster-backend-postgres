/**
 * Confluence space-validation port — validates the service account can reach a space BEFORE persisting
 * a row. PORT only (injectable seam); the REAL adapter is wired at the composition root. Tests inject a
 * stub. The real adapter MUST be exercised against live Atlassian Cloud before shipping.
 */

/** Outcome of a space-reachability probe. `detail` carries the upstream status/reason the route classifies
 *  into a stable error code (auth_error | rate_limited | not_found | validation_failed). */
export type ConfluenceValidationResult = {
  readonly ok: boolean;
  readonly detail: string;
  readonly validatedAt: Date;
};

export type ConfluenceValidatorPort = {
  validateSpace(args: { spaceKey: string; now: Date }): Promise<ConfluenceValidationResult>;
};

/** Factory injected into the admin routes (mirrors GetPreflightValidator). Undefined at the composition root
 *  until the live Confluence adapter lands → the create route 503s. */
export type GetConfluenceValidator = () => ConfluenceValidatorPort;
