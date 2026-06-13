/**
 * Workspace lifecycle exceptions: {@link StateDrift}, {@link WorkspaceSecurityViolation}, and
 * {@link CrossInstallationViolation} (colocated here — when other spine primitives are ported they
 * can re-export or lift it into a shared `domain/cross_installation.ts`).
 *
 * Naming: the `*Violation` suffix (NOT `*Error`) is a pinned Phase-6 spec name, preserved verbatim
 * (`.name` matches the class name so structured logs / `instanceof` discrimination work correctly).
 */

/**
 * Path traversal or hostile symlink detected during workspace ops.
 *
 * Per spec §6.2: the only cleanup failure that fails the workflow — the workflow body MUST
 * re-raise this; everything else is absorbed.
 */
export class WorkspaceSecurityViolation extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkspaceSecurityViolation";
  }
}

/**
 * `transitionLease` found an unexpected current state.
 *
 * Per spec §7.5 + AD-11. Carries `workspaceId` + `expectedFrom` + `actualState` so
 * diagnostic logs can pinpoint the race. `actualState` is the literal sentinel `"<missing>"`
 * when the row does not exist.
 */
export class StateDrift extends Error {
  public readonly workspaceId: string;
  public readonly expectedFrom: string;
  public readonly actualState: string;

  public constructor(args: { workspaceId: string; expectedFrom: string; actualState: string }) {
    super(
      `workspace_id=${args.workspaceId} expected from_state='${args.expectedFrom}' ` +
        `got actual_state='${args.actualState}'`,
    );
    this.name = "StateDrift";
    this.workspaceId = args.workspaceId;
    this.expectedFrom = args.expectedFrom;
    this.actualState = args.actualState;
  }
}

/**
 * A spine mutation primitive was called with an `expectedInstallationId` that does NOT match
 * the actual installation of the row being mutated (BF-9 Phase A).
 *
 * Indicates a confused-deputy condition: the caller believes it is operating on a row in
 * installation A, but the primary key resolves to a row in installation B. Carries the
 * offending key + both installations for forensic attribution. `actualInstallationId` is
 * nullable (a row whose tenancy column is NULL — not reachable for `core.workspace_leases`
 * whose `installation_id` is NOT NULL, but the shape is preserved for cross-primitive reuse).
 */
export class CrossInstallationViolation extends Error {
  public readonly primitive: string;
  public readonly keyKind: string;
  public readonly keyValue: string;
  public readonly expectedInstallationId: string;
  public readonly actualInstallationId: string | null;

  public constructor(args: {
    primitive: string;
    keyKind: string;
    keyValue: string;
    expectedInstallationId: string;
    actualInstallationId: string | null;
  }) {
    super(
      `${args.primitive}: cross-installation violation: ` +
        `${args.keyKind}=${args.keyValue} resolves to installation_id=` +
        `${args.actualInstallationId} but caller expected ${args.expectedInstallationId}`,
    );
    this.name = "CrossInstallationViolation";
    this.primitive = args.primitive;
    this.keyKind = args.keyKind;
    this.keyValue = args.keyValue;
    this.expectedInstallationId = args.expectedInstallationId;
    this.actualInstallationId = args.actualInstallationId;
  }
}

/**
 * A workflow primitive could not resolve `core.repositories.installation_id` for a known `review_id`
 * (BF-3 Phase B Wave 10 R2).
 *
 * Indicates a data-integrity break: the `core.repositories` row is missing for the review's `repo_id`,
 * OR `core.repositories.installation_id` is NULL. Post-Phase-B the spine fails closed — tenancy integrity
 * wins over availability for this rare administrative-error case. The typed exception upgrades the
 * operator diagnostic from "audit row would have been NULL" to "repositories integrity break, here is
 * the offending review_id." `.name` matches the class name for structured-log / `instanceof`
 * discrimination. Colocated here until a shared `domain/cross_installation.ts` exists.
 */
export class RepositoriesResolveFailed extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RepositoriesResolveFailed";
  }
}
