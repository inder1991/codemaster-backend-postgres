/**
 * Workspace lifecycle exceptions — 1:1 TypeScript port of the frozen Python spine
 * `vendor/codemaster-py/codemaster/workspace/_errors.py` (StateDrift,
 * WorkspaceSecurityViolation) PLUS the cross-installation safety error
 * `vendor/codemaster-py/codemaster/domain/cross_installation.py::CrossInstallationViolation`
 * that {@link transitionLease} raises.
 *
 * The Python source places `CrossInstallationViolation` in a separate cross-cutting
 * module (`codemaster.domain.cross_installation`). That module has no TS port yet and the
 * only TS consumer today is the workspace transition primitive, so the class is colocated
 * here (the workspace error taxonomy) — when other spine primitives (`transition_run`,
 * `supersede_run`, `flip_current_run`) are ported they can re-export from here or lift it
 * into a shared `domain/cross_installation.ts`. The class shape is byte-faithful to the
 * frozen Python so that move is purely mechanical.
 *
 * Naming: the Python uses the `*Violation` suffix (NOT `*Error`) for the audit-log surface
 * on both `WorkspaceSecurityViolation` and `CrossInstallationViolation` — that is a pinned
 * Phase-6 spec name, preserved here verbatim (`.name` matches the class name so structured
 * logs / `instanceof` discrimination read identically to the Python).
 */

/**
 * Path traversal or hostile symlink detected during workspace ops (1:1 with the Python
 * `WorkspaceSecurityViolation`).
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
 * `transitionLease` found an unexpected current state (1:1 with the Python `StateDrift`).
 *
 * Per spec §7.5 + AD-11. Carries `workspaceId` + `expectedFrom` + `actualState` so
 * diagnostic logs can pinpoint the race. `actualState` is the literal sentinel
 * `"<missing>"` when the row does not exist (the Python uses the same sentinel string so
 * the field stays non-optional).
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
 * the actual installation of the row being mutated (1:1 with the Python
 * `CrossInstallationViolation`, BF-9 Phase A).
 *
 * Indicates a confused-deputy condition: the caller believes it is operating on a row in
 * installation A, but the primary key resolves to a row in installation B. Carries the
 * offending key + both installations for forensic attribution. `actualInstallationId` is
 * nullable to mirror the Python `uuid.UUID | None` (a row whose tenancy column is somehow
 * NULL — not reachable for `core.workspace_leases` whose `installation_id` is NOT NULL, but
 * the shape is preserved for cross-primitive reuse).
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
