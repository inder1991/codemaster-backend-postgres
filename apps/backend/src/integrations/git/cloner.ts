/**
 * GitSubprocessCloner — shells out to `git clone --depth=1 --no-tags --filter=blob:none` then
 * `git fetch + git checkout
 * <head_sha>` to land an exact commit in the workspace.
 *
 * Auth
 * ----
 * The GitHub installation token is threaded via a per-clone GIT_ASKPASS helper script — the token
 * NEVER appears in subprocess argv (visible to `ps` / `/proc/<pid>/cmdline`). Architecture-review B7
 * fix; pinned by the token-redaction unit + adversarial tests.
 *
 * Determinism / seams
 * -------------------
 * The actual git execution is EXTERNAL and stubbed in tests. The deterministic parity surface is
 * command CONSTRUCTION: argv + env + cwd. Two seams make that observable and replay-safe:
 *   - {@link SpawnFn}: the subprocess factory (default `node:child_process.spawn`). Tests inject a
 *     recorder that captures argv/env/cwd and returns a fake process.
 *   - The transport-timeout seam (`#platform/transport_timeout.ts::transportAbortSignal`) arms the
 *     60s git timeout and the 5s SIGKILL grace. Raw `setTimeout` / `AbortSignal.timeout` are banned
 *     by the `check_clock_random` gate outside the seam; routing through `transportAbortSignal` keeps
 *     this driver gate-clean.
 *
 * Input validation
 * ----------------
 * `head_sha` must be a valid 7-64 char hex string; `repo_url` must be `https://github.com/...`;
 * `pr_number` (when supplied) must be positive. Validation happens BEFORE any subprocess invocation.
 */

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { transportAbortSignal } from "#platform/transport_timeout.js";
import { type TokenProvider } from "#backend/integrations/github/api_client.js";

import { GitCloneFailedError, GitCloneTimeoutError } from "./errors.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
const HEAD_SHA_RE = /^[0-9a-f]{7,64}$/;
const REPO_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const KILL_TIMEOUT_SECONDS = 5; // SIGKILL grace after SIGTERM
const REPO_SUBDIR = "repo";

/**
 * The subprocess factory seam. Mirrors `node:child_process.spawn`'s shape (command, args, options) so
 * the default impl is `spawn` itself; tests inject a recorder. The returned object only needs the
 * surface this driver touches: stdout/stderr streams, the `close` event (exit code), and
 * `kill(signal)`.
 */
export type SpawnFn = (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => ChildProcess;

/** The git-driver contract. Production: subprocess-git. Mirrors the Python `GitCloner` Protocol.
 *
 * `installationId` is PER-CALL (per-review routing) — the cloner is no longer bound to one installation at
 * construction. The caller (clone_repo_into_workspace activity) resolves the per-PR numeric id from the
 * activity input and passes it here; one cloner instance serves every installation. */
export type GitCloner = {
  clone(input: {
    workspace: string;
    repoUrl: string;
    headSha: string;
    installationId: number;
    paths: ReadonlyArray<string>;
    prNumber?: number | null;
    /**
     * OPTIONAL external abort signal (W4.1 / de-Temporal gate ①). A pre-spawn abort throws BEFORE any
     * subprocess; an abort mid-clone runs the EXISTING SIGTERM→SIGKILL teardown and the askpass-cleanup
     * `finally`. Absent → byte-identical to the pre-W4.1 cloner.
     */
    signal?: AbortSignal;
  }): Promise<void>;
};

type GitSubprocessClonerOptions = {
  tokenProvider: TokenProvider;
  timeoutSeconds?: number;
  /** Injected for tests; defaults to `node:child_process.spawn`. */
  spawnFn?: SpawnFn;
};

/** Production `GitCloner` impl backed by `git` subprocess calls. */
export class GitSubprocessCloner implements GitCloner {
  private readonly tokenProvider: TokenProvider;
  private readonly timeoutSeconds: number;
  private readonly spawnFn: SpawnFn;

  public constructor({
    tokenProvider,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    spawnFn = nodeSpawn,
  }: GitSubprocessClonerOptions) {
    if (timeoutSeconds <= 0) {
      throw new Error(`timeout_seconds must be > 0, got ${timeoutSeconds}`);
    }
    this.tokenProvider = tokenProvider;
    this.timeoutSeconds = timeoutSeconds;
    this.spawnFn = spawnFn;
  }

  public async clone({
    workspace,
    repoUrl,
    headSha,
    installationId,
    prNumber = null,
    signal,
  }: {
    workspace: string;
    repoUrl: string;
    headSha: string;
    installationId: number;
    paths: ReadonlyArray<string>;
    prNumber?: number | null;
    signal?: AbortSignal;
  }): Promise<void> {
    // Defense-in-depth: validate inputs BEFORE the subprocess. `spawn` (argv form) doesn't use a
    // shell, but rejecting bad inputs early protects against future refactors.
    // Single-quote wrapping (NOT JSON.stringify double quotes) matches the existing error message format
    // for sha/url values.
    if (!HEAD_SHA_RE.test(headSha)) {
      throw new Error(`head_sha must be 7-64 hex chars; got '${headSha}'`);
    }
    if (!REPO_URL_RE.test(repoUrl)) {
      throw new Error(`repo_url must be an https://github.com/... URL; got '${repoUrl}'`);
    }
    if (prNumber !== null && prNumber !== undefined && prNumber <= 0) {
      throw new Error(`pr_number must be a positive integer when supplied; got ${prNumber}`);
    }
    // Per-call installation guard (was a constructor guard before per-review routing). The activity
    // fail-closes on a null id BEFORE calling clone(); this defends against a 0/negative id reaching the mint.
    if (installationId <= 0) {
      throw new Error(`github_installation_id must be >= 1, got ${installationId}`);
    }

    // W4.1 / gate ①: a PRE-SPAWN abort throws BEFORE any token fetch / askpass write / subprocess —
    // no NEW external work STARTS after abort. `signal` is OPTIONAL; absent → byte-identical.
    signal?.throwIfAborted();

    const token = await this.tokenProvider(installationId);

    // Write a per-clone GIT_ASKPASS helper so the token is not in argv. The helper just prints the
    // token; git invokes it when the remote prompts for a password (the username is `x-access-token`
    // for GitHub App installation tokens).
    const askpassDir = path.join(workspace, ".codemaster-askpass");
    await fs.mkdir(askpassDir, { recursive: true });
    const askpassScript = await writeAskpassScript({ token, destDir: askpassDir });

    const env = this.buildSubprocessEnv({ askpassScript });

    // S19.SMOKE.3 — fetch via pull/<n>/head when we have a PR number. GitHub maintains this ref on
    // the base repo for every open PR, including cross-fork PRs (the fork's commits are mirrored into
    // the base repo's pull/<n>/head). Falls back to direct SHA fetch for callers without a PR context.
    const fetchRef = prNumber !== null && prNumber !== undefined ? `pull/${prNumber}/head` : headSha;

    try {
      // Gate before EACH spawn (gate ①): an abort between the clone/fetch/checkout stages does not
      // start the next subprocess. An in-flight subprocess is torn down by `runGit` (signal forwarded).
      signal?.throwIfAborted();
      await this.runGit(
        [
          "git",
          "clone",
          "--depth=1",
          "--no-tags",
          "--filter=blob:none",
          repoUrl,
          path.join(workspace, REPO_SUBDIR),
        ],
        // Conditional spread (NOT `signal,`) so the optional `signal?: AbortSignal` property is
        // OMITTED — not set to `undefined` — when absent (codebase `exactOptionalPropertyTypes` rule,
        // same idiom as the api_client request options).
        { env, cwd: workspace, ...(signal !== undefined ? { signal } : {}) },
      );
      signal?.throwIfAborted();
      await this.runGit(["git", "fetch", "--depth=1", "origin", fetchRef], {
        env,
        cwd: path.join(workspace, REPO_SUBDIR),
        ...(signal !== undefined ? { signal } : {}),
      });
      signal?.throwIfAborted();
      await this.runGit(["git", "checkout", "--detach", headSha], {
        env,
        cwd: path.join(workspace, REPO_SUBDIR),
        ...(signal !== undefined ? { signal } : {}),
      });
    } finally {
      // Remove the askpass helper as soon as the clone completes (success or failure) so a stale
      // script doesn't sit on disk past the workflow's lifetime.
      try {
        await fs.rm(askpassScript, { force: true });
        await fs.rmdir(askpassDir);
      } catch {
        // missing_ok / non-empty-dir / permission — ignore.
      }
    }
  }

  /**
   * Build the env passed to `git`. Only the askpass-related bits are codemaster-specific; PATH/HOME
   * pass through so the kubelet's container env reaches git. Mirrors `_build_subprocess_env` (Python
   * `dict(os.environ)` layered with the three GIT_* overrides).
   */
  private buildSubprocessEnv({ askpassScript }: { askpassScript: string }): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) {
        env[k] = v;
      }
    }
    env["GIT_ASKPASS"] = askpassScript;
    // Disable interactive prompt fallback paths (git terminal prompt, system config / credential
    // helpers).
    env["GIT_TERMINAL_PROMPT"] = "0";
    env["GIT_CONFIG_NOSYSTEM"] = "1";
    return env;
  }

  /**
   * Run `git` with the configured timeout. Raises typed errors on failure / timeout. Mirrors the
   * Python `_run_git`: `create_subprocess_exec(*args)` → `wait_for(communicate(), timeout)`; on
   * timeout SIGTERM → 5s grace → SIGKILL → 5s grace, then `GitCloneTimeoutError`; non-zero exit →
   * `GitCloneFailedError` with the exact message shape.
   *
   * `args[0]` is the executable ("git"); `args[1]` is the verb (clone/fetch/checkout), used verbatim
   * in the error messages.
   */
  private async runGit(
    args: ReadonlyArray<string>,
    { env, cwd, signal }: { env: Record<string, string>; cwd: string; signal?: AbortSignal },
  ): Promise<void> {
    const verb = args.length > 1 ? (args[1] ?? "?") : "?";
    const proc = this.spawnFn(args[0] ?? "git", args.slice(1), {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Array<Buffer> = [];
    const stderrChunks: Array<Buffer> = [];
    proc.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
    proc.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));

    // A spawn FAILURE (e.g. `git` not on PATH → ENOENT, or a permission error) emits an 'error' event, NOT
    // 'close'. WITHOUT this listener the unhandled 'error' becomes an uncaught exception that crashes the
    // (fail-loud) process — a missing/unspawnable git would take down the WHOLE pod instead of failing this
    // one review. Reject with a catchable GitCloneFailedError so the clone activity degrades gracefully.
    const spawnFailed = new Promise<never>((_resolve, reject) => {
      proc.on("error", (err: Error) =>
        reject(new GitCloneFailedError(`git ${verb} failed to spawn: ${err.message}`)),
      );
    });

    const exitCode = await Promise.race([this.awaitWithTimeout(proc, verb, signal), spawnFailed]);

    if (exitCode !== 0) {
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      throw new GitCloneFailedError(
        `git ${verb} exited ${exitCode}: ${stderrText || stdoutText || "no output"}`,
      );
    }
  }

  /**
   * Wait for `proc` to exit, bounded by `timeoutSeconds` AND (W4.1 / gate ①) an optional external
   * abort `signal`. On timeout: SIGTERM, then a 5s SIGKILL-grace, then SIGKILL, then a final 5s grace;
   * either way raise {@link GitCloneTimeoutError}. On an external abort: the SAME SIGTERM→SIGKILL
   * teardown runs (so the in-flight git subprocess is reaped, never orphaned), then the abort REASON
   * is re-thrown (via `signal.throwIfAborted()`) so the caller's cancel cause (e.g. the composed
   * `TerminalCancelError`) propagates. The caller's `finally` removes the askpass script on EITHER path.
   *
   * The timeout + grace timers are armed through the transport-timeout seam (`transportAbortSignal`)
   * — NOT a raw `setTimeout` — so this driver stays clean under the `check_clock_random` gate.
   */
  private async awaitWithTimeout(
    proc: ChildProcess,
    verb: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const closed = new Promise<number>((resolve) => {
      // `close` fires after stdio is flushed and the process has exited; the code is the exit code
      // (or null if killed by signal, which we coerce to a non-zero sentinel for the failed-error
      // path — though the timeout path raises before that matters).
      proc.on("close", (code) => resolve(code ?? -1));
    });

    // The graceful SIGTERM→SIGKILL teardown, shared by the timeout AND the external-abort paths so the
    // subprocess is reaped identically either way (no orphaned git process after a mid-clone abort).
    const teardown = async (): Promise<void> => {
      proc.kill("SIGTERM");
      const exitedAfterTerm = await Promise.race([
        closed.then(() => true),
        abortAfter(KILL_TIMEOUT_SECONDS).then(() => false),
      ]);
      if (!exitedAfterTerm) {
        proc.kill("SIGKILL");
        await Promise.race([
          closed.then(() => true),
          abortAfter(KILL_TIMEOUT_SECONDS).then(() => false),
        ]);
        // If it's STILL stuck the OS reaper will clean up; we proceed to raise.
      }
    };

    const timedOut = abortAfter(this.timeoutSeconds);
    const aborted = signalFired(signal);
    const winner = await Promise.race([
      closed.then(() => "closed" as const),
      timedOut.then(() => "timeout" as const),
      aborted.then(() => "aborted" as const),
    ]);

    if (winner === "closed") {
      return await closed;
    }

    if (winner === "aborted") {
      // External cancel mid-clone: tear the subprocess down (same SIGTERM→SIGKILL grace as a timeout),
      // then re-throw the abort reason so the cancel cause propagates to the caller.
      await teardown();
      signal?.throwIfAborted();
      // Defensive: `throwIfAborted` above always throws when we reached the abort branch, but keep a
      // typed fallback so the function never returns silently on a hand-fired signal without a reason.
      throw new GitCloneFailedError(`git ${verb} aborted`);
    }

    // Timeout path: the same graceful SIGTERM→SIGKILL teardown, then raise the timeout error.
    await teardown();
    throw new GitCloneTimeoutError(`git ${verb} exceeded timeout ${this.timeoutSeconds}s`);
  }
}

/**
 * Resolve after `seconds`, driven by the transport-timeout seam's `AbortSignal`. The seam owns the
 * underlying timer (the gate allow-lists `AbortSignal.timeout` only inside it); here we just observe
 * the signal firing. Listening to a signal — not creating a timer — keeps this file gate-clean.
 */
function abortAfter(seconds: number): Promise<void> {
  const signal = transportAbortSignal(seconds * 1000);
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Resolve when `signal` fires (W4.1 / gate ①). When `signal` is undefined the returned promise NEVER
 * settles — so it never wins the `Promise.race` against close/timeout for callers without an external
 * cancel (the pre-W4.1 path stays byte-identical). This only OBSERVES the `abort` event — no timer —
 * so the file stays clean under the `check_clock_random` gate.
 */
function signalFired(signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    return new Promise<void>(() => {
      /* never resolves — no external abort to observe */
    });
  }
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Write a tiny shell script that prints the token. File is mode 0700 so only the worker UID can read
 * it. The token lives in the script body (not in env, not in argv), so it's invisible to `ps` /
 * `/proc/<pid>/environ` of the git subprocess. Mirrors `_write_askpass_script`.
 *
 * Single-quote-with-careful-escape avoids shell interpolation of the token (`'` → `'\''`). GitHub
 * installation tokens are hex-ish (no shell metachars), but defense-in-depth.
 */
async function writeAskpassScript({
  token,
  destDir,
}: {
  token: string;
  destDir: string;
}): Promise<string> {
  const script = path.join(destDir, "askpass.sh");
  const safeToken = token.replaceAll("'", "'\\''");
  await fs.writeFile(script, `#!/bin/sh\nprintf '%s' '${safeToken}'\n`, { encoding: "utf8" });
  await fs.chmod(script, 0o700);
  return script;
}

export { GitClonerError, GitCloneFailedError, GitCloneTimeoutError, MAX_WORKSPACE_BYTES } from "./errors.js";
export const REPO_SUBDIR_NAME = REPO_SUBDIR;
