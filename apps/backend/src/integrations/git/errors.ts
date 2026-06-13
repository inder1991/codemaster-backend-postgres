/**
 * Git-clone error taxonomy — two families:
 *   - Subprocess-driver errors: {@link GitClonerError} (base), {@link GitCloneFailedError} (non-zero
 *     exit), {@link GitCloneTimeoutError} (timeout budget exceeded).
 *   - Activity-level errors: {@link CloneFailedError} (any clone failure) and
 *     {@link WorkspaceTooLargeError} (cloned tree exceeds {@link MAX_WORKSPACE_BYTES}).
 *
 * The exact message strings are part of the parity surface — they are mirrored byte-for-byte,
 * including the `head_sha[:8]` truncation (Python `head_sha[:8]` → TS `headSha.slice(0, 8)`).
 */

/** Per-workspace size cap (200 MiB). Mirrors `_clone_common.MAX_WORKSPACE_BYTES`. */
export const MAX_WORKSPACE_BYTES = 200 * 1024 * 1024; // 200 MiB

/** Base class for cloner (subprocess-driver) failures. */
export class GitClonerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitClonerError";
  }
}

/** Subprocess returned non-zero (auth, missing ref, network). */
export class GitCloneFailedError extends GitClonerError {
  public constructor(message: string) {
    super(message);
    this.name = "GitCloneFailedError";
  }
}

/** Subprocess exceeded the timeout budget. */
export class GitCloneTimeoutError extends GitClonerError {
  public constructor(message: string) {
    super(message);
    this.name = "GitCloneTimeoutError";
  }
}

/** Raised when the underlying git clone fails for any reason. */
export class CloneFailedError extends Error {
  public readonly repo: string;
  public readonly headSha: string;
  public readonly reason: string;

  public constructor({ repo, headSha, reason }: { repo: string; headSha: string; reason: string }) {
    super(`clone failed for ${repo}@${headSha.slice(0, 8)}: ${reason}`);
    this.name = "CloneFailedError";
    this.repo = repo;
    this.headSha = headSha;
    this.reason = reason;
  }
}

/** Raised when the cloned workspace exceeds {@link MAX_WORKSPACE_BYTES}. */
export class WorkspaceTooLargeError extends Error {
  public readonly repo: string;
  public readonly headSha: string;
  public readonly byteSize: number;

  public constructor({
    repo,
    headSha,
    byteSize,
  }: {
    repo: string;
    headSha: string;
    byteSize: number;
  }) {
    super(
      `workspace for ${repo}@${headSha.slice(0, 8)} is ${byteSize} bytes; cap is ${MAX_WORKSPACE_BYTES}`,
    );
    this.name = "WorkspaceTooLargeError";
    this.repo = repo;
    this.headSha = headSha;
    this.byteSize = byteSize;
  }
}
