/**
 * Unit tests for the TS GitSubprocessCloner — 1:1 port of the frozen-Python parity reference
 * (`vendor/codemaster-py/tests/unit/integrations/git/test_cloner.py` +
 * `.../tests/adversarial/test_git_clone_token_redaction.py`).
 *
 * The deterministic parity surface is command CONSTRUCTION (argv + env + cwd) — the actual git
 * execution is external and STUBBED here via an injected {@link SpawnRecorder} (the TS analogue of the
 * Python `_SubprocessRecorder` monkeypatching `asyncio.create_subprocess_exec`). We never spawn real
 * git. Timing is driven by the transport-timeout seam; the timeout test uses a tiny `timeoutSeconds`
 * with a fake process that never closes, so the seam's abort fires deterministically.
 */

import { EventEmitter } from "node:events";
import { promises as fs, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GitCloneFailedError,
  GitCloneTimeoutError,
  GitSubprocessCloner,
  type SpawnFn,
} from "#backend/integrations/git/cloner.js";

const TEST_TOKEN = "ghs_test-installation-token-do-not-leak";
const CANARY_TOKEN = "ghs_RED-TEAM-CANARY-TOKEN-do-not-leak-9c3a";
const INSTALLATION_ID = 42;
const VALID_SHA = "abc1234deadbeef" + "0".repeat(25);

// ─── Fake subprocess infrastructure ──────────────────────────────────────────────────────────────

type RecordedCall = {
  command: string;
  args: ReadonlyArray<string>;
  env: Record<string, string>;
  cwd: string;
  /** Full argv as the Python recorder captured it: ["git", "clone", ...]. */
  argv: ReadonlyArray<string>;
};

type FakeProcConfig = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** When true the fake process NEVER emits `close` — drives the timeout path. */
  hang?: boolean;
  /** When set, the fake emits an `error` event (NOT `close`) — models a spawn failure (e.g. ENOENT). */
  spawnError?: string;
};

class FakeStream extends EventEmitter {}

class FakeProcess extends EventEmitter {
  public readonly stdout = new FakeStream();
  public readonly stderr = new FakeStream();
  public killCount = 0;
  public readonly killSignals: Array<NodeJS.Signals | number> = [];
  private readonly cfg: FakeProcConfig;

  public constructor(cfg: FakeProcConfig) {
    super();
    this.cfg = cfg;
    // Emit synchronously-but-async so listeners (attached right after spawn) are in place.
    queueMicrotask(() => {
      if (this.cfg.spawnError) {
        // A real spawn failure (ENOENT etc.) emits `error` and never `close`.
        this.emit("error", new Error(this.cfg.spawnError));
        return;
      }
      if (this.cfg.stdout) this.stdout.emit("data", Buffer.from(this.cfg.stdout));
      if (this.cfg.stderr) this.stderr.emit("data", Buffer.from(this.cfg.stderr));
      if (!this.cfg.hang) {
        this.emit("close", this.cfg.exitCode ?? 0);
      }
    });
  }

  public kill(signal?: NodeJS.Signals | number): boolean {
    this.killCount += 1;
    this.killSignals.push(signal ?? "SIGTERM");
    // A real SIGTERM/SIGKILL causes `close`; emit it so the timeout grace race resolves and the
    // process is reaped (mirrors the Python fake whose wait() returns after kill()).
    queueMicrotask(() => this.emit("close", -1));
    return true;
  }
}

class SpawnRecorder {
  public readonly calls: Array<RecordedCall> = [];
  private readonly procs: Array<FakeProcConfig>;
  private counter = 0;

  public constructor(procs: Array<FakeProcConfig> = []) {
    this.procs = procs;
  }

  public readonly spawn: SpawnFn = (command, args, options) => {
    this.calls.push({
      command,
      args: [...args],
      env: { ...(options.env as Record<string, string>) },
      cwd: String(options.cwd),
      argv: [command, ...args],
    });
    const cfg = this.procs[this.counter] ?? { exitCode: 0 };
    this.counter += 1;
    // The cast is the seam's escape hatch: a FakeProcess implements exactly the surface the cloner
    // touches (stdout/stderr/.on('close')/.kill()).
    return new FakeProcess(cfg) as unknown as ReturnType<SpawnFn>;
  };
}

// ─── Token provider double ───────────────────────────────────────────────────────────────────────

function fakeTokenProvider(token = TEST_TOKEN): {
  provider: (installationId: number) => Promise<string>;
  calls: Array<number>;
} {
  const calls: Array<number> = [];
  return {
    calls,
    provider: async (installationId: number) => {
      calls.push(installationId);
      return token;
    },
  };
}

// ─── Workspace tmpdir lifecycle ──────────────────────────────────────────────────────────────────

const created: Array<string> = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cm-cloner-test-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─── AC1: the 3-command argv sequence + cwds (pr_number omitted → fetch head_sha) ─────────────────

describe("GitSubprocessCloner argv / cwd / env construction", () => {
  it("issues clone, fetch <head_sha>, checkout with exact flags + cwds when pr_number is omitted", async () => {
    const recorder = new SpawnRecorder();
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: recorder.spawn,
    });
    const workspace = await makeWorkspace();
    const repoDir = path.join(workspace, "repo");

    await cloner.clone({
      workspace,
      repoUrl: "https://github.com/acme/widget.git",
      headSha: VALID_SHA,
      installationId: INSTALLATION_ID,
      paths: [],
    });

    expect(recorder.calls.length).toBe(3);

    expect(recorder.calls[0]?.argv).toEqual([
      "git",
      "clone",
      "--depth=1",
      "--no-tags",
      "--filter=blob:none",
      "https://github.com/acme/widget.git",
      repoDir,
    ]);
    expect(recorder.calls[0]?.cwd).toBe(workspace);

    expect(recorder.calls[1]?.argv).toEqual(["git", "fetch", "--depth=1", "origin", VALID_SHA]);
    expect(recorder.calls[1]?.cwd).toBe(repoDir);

    expect(recorder.calls[2]?.argv).toEqual(["git", "checkout", "--detach", VALID_SHA]);
    expect(recorder.calls[2]?.cwd).toBe(repoDir);
  });

  it("fetches pull/<n>/head when pr_number is supplied (checkout still uses head_sha)", async () => {
    const recorder = new SpawnRecorder();
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: recorder.spawn,
    });
    const workspace = await makeWorkspace();

    await cloner.clone({
      workspace,
      repoUrl: "https://github.com/acme/widget.git",
      headSha: VALID_SHA,
      installationId: INSTALLATION_ID,
      paths: [],
      prNumber: 42,
    });

    expect(recorder.calls[1]?.argv).toEqual([
      "git",
      "fetch",
      "--depth=1",
      "origin",
      "pull/42/head",
    ]);
    expect(recorder.calls[2]?.argv).toEqual(["git", "checkout", "--detach", VALID_SHA]);
  });

  it("layers GIT_ASKPASS / GIT_TERMINAL_PROMPT / GIT_CONFIG_NOSYSTEM over the process env", async () => {
    const recorder = new SpawnRecorder();
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: recorder.spawn,
    });
    const workspace = await makeWorkspace();

    await cloner.clone({
      workspace,
      repoUrl: "https://github.com/acme/widget.git",
      headSha: VALID_SHA,
      installationId: INSTALLATION_ID,
      paths: [],
    });

    for (const call of recorder.calls) {
      expect(call.env["GIT_TERMINAL_PROMPT"]).toBe("0");
      expect(call.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
      // GIT_ASKPASS points at the per-clone helper script inside the workspace.
      expect(call.env["GIT_ASKPASS"]).toBe(
        path.join(workspace, ".codemaster-askpass", "askpass.sh"),
      );
      // PATH passes through from the process env (proves the layering, not a fresh env).
      expect(call.env["PATH"]).toBe(process.env["PATH"]);
    }
  });

  it("calls the token provider with the PER-CALL installation_id (per-review routing — one cloner, any org)", async () => {
    const recorder = new SpawnRecorder();
    const { provider, calls } = fakeTokenProvider();
    // ONE cloner instance, NOT bound to any installation. Two clones with DIFFERENT ids must mint for the
    // id passed to THAT call — the whole point of per-review routing (one worker pool serves all orgs).
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: recorder.spawn,
    });
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();

    await cloner.clone({
      workspace: wsA,
      repoUrl: "https://github.com/acme/widget.git",
      headSha: VALID_SHA,
      installationId: INSTALLATION_ID,
      paths: [],
    });
    await cloner.clone({
      workspace: wsB,
      repoUrl: "https://github.com/acme/widget.git",
      headSha: VALID_SHA,
      installationId: 7654321,
      paths: [],
    });

    // The same cloner minted for BOTH installation ids — proving it's not bound to one.
    expect(calls).toContain(INSTALLATION_ID);
    expect(calls).toContain(7654321);
  });
});

// ─── Askpass script body + perms + cleanup ────────────────────────────────────────────────────────

describe("GitSubprocessCloner askpass helper", () => {
  it("writes the exact askpass body, mode 0700, and the token NEVER appears in any argv", async () => {
    // Capture the script body BEFORE the finally-unlink: the spawnFn reads it on the first call
    // (synchronously, while the helper is still on disk).
    let capturedBody: string | undefined;
    let capturedMode: number | undefined;
    const recorder = new SpawnRecorder();
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: (command, args, options) => {
        const askpass = (options.env as Record<string, string>)["GIT_ASKPASS"];
        if (askpass && capturedBody === undefined) {
          capturedBody = readFileSync(askpass, "utf8");
          capturedMode = statSync(askpass).mode & 0o777;
        }
        return recorder.spawn(command, args, options);
      },
    });
    const workspace = await makeWorkspace();

    await cloner.clone({
      workspace,
      repoUrl: "https://github.com/acme/widget.git",
      headSha: VALID_SHA,
      installationId: INSTALLATION_ID,
      paths: [],
    });

    expect(capturedBody).toBe(`#!/bin/sh\nprintf '%s' '${TEST_TOKEN}'\n`);
    expect(capturedMode).toBe(0o700);

    // The token MUST NOT appear in any argv across all 3 invocations.
    for (const call of recorder.calls) {
      for (const arg of call.argv) {
        expect(arg).not.toContain(TEST_TOKEN);
      }
    }

    // Cleanup: the askpass script + dir are gone after clone returns (finally-unlink).
    await expect(
      fs.access(path.join(workspace, ".codemaster-askpass", "askpass.sh")),
    ).rejects.toThrow();
  });

  it("escapes a single-quote in the token in the askpass body (defense-in-depth)", async () => {
    let capturedBody: string | undefined;
    const recorder = new SpawnRecorder();
    const trickyToken = "tok'en";
    const { provider } = fakeTokenProvider(trickyToken);
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: (command, args, options) => {
        const askpass = (options.env as Record<string, string>)["GIT_ASKPASS"];
        if (askpass && capturedBody === undefined) {
          capturedBody = readFileSync(askpass, "utf8");
        }
        return recorder.spawn(command, args, options);
      },
    });
    const workspace = await makeWorkspace();

    await cloner.clone({
      workspace,
      repoUrl: "https://github.com/acme/widget.git",
      headSha: VALID_SHA,
      installationId: INSTALLATION_ID,
      paths: [],
    });

    // Python: token.replace("'", "'\\''") → tok'en becomes tok'\''en inside single quotes.
    expect(capturedBody).toBe(`#!/bin/sh\nprintf '%s' 'tok'\\''en'\n`);
    // The raw token must never reach argv even with metachars.
    for (const call of recorder.calls) {
      for (const arg of call.argv) {
        expect(arg).not.toContain(trickyToken);
      }
    }
  });
});

// ─── Adversarial: canary token never leaks to argv ────────────────────────────────────────────────

describe("GitSubprocessCloner token redaction (adversarial)", () => {
  it("never leaks the canary token to any subprocess argv", async () => {
    const recorder = new SpawnRecorder();
    const { provider } = fakeTokenProvider(CANARY_TOKEN);
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: recorder.spawn,
    });
    const workspace = await makeWorkspace();

    await cloner.clone({
      workspace,
      repoUrl: "https://github.com/acme/widget.git",
      headSha: VALID_SHA,
      installationId: INSTALLATION_ID,
      paths: [],
    });

    expect(recorder.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of recorder.calls) {
      for (const arg of call.argv) {
        expect(arg).not.toContain(CANARY_TOKEN);
      }
      // Also assert it's not smuggled into any env var (the token lives in the on-disk askpass body).
      for (const v of Object.values(call.env)) {
        expect(v).not.toContain(CANARY_TOKEN);
      }
    }
  });
});

// ─── Input validation rejects BEFORE any subprocess ───────────────────────────────────────────────

describe("GitSubprocessCloner input validation", () => {
  it("rejects a non-hex head_sha before spawning", async () => {
    const recorder = new SpawnRecorder();
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: recorder.spawn,
    });
    const workspace = await makeWorkspace();

    await expect(
      cloner.clone({
        workspace,
        repoUrl: "https://github.com/acme/widget.git",
        headSha: "not-a-real-sha-bytes; rm -rf /",
        installationId: INSTALLATION_ID,
        paths: [],
      }),
    ).rejects.toThrow(/head_sha/);
    expect(recorder.calls).toEqual([]);
  });

  it("rejects non-https / non-github repo_url before spawning", async () => {
    const recorder = new SpawnRecorder();
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: recorder.spawn,
    });
    const workspace = await makeWorkspace();

    for (const badUrl of [
      "git@github.com:acme/widget.git",
      "http://github.com/acme/widget.git",
      "https://evil.example.com/acme/widget.git",
    ]) {
      await expect(
        cloner.clone({ workspace, repoUrl: badUrl, headSha: VALID_SHA, installationId: INSTALLATION_ID, paths: [] }),
      ).rejects.toThrow(/repo_url/);
    }
    expect(recorder.calls).toEqual([]);
  });

  it("rejects a non-positive pr_number before spawning", async () => {
    const recorder = new SpawnRecorder();
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: recorder.spawn,
    });
    const workspace = await makeWorkspace();

    for (const badPr of [0, -1, -42]) {
      await expect(
        cloner.clone({
          workspace,
          repoUrl: "https://github.com/acme/widget.git",
          headSha: VALID_SHA,
          installationId: INSTALLATION_ID,
          paths: [],
          prNumber: badPr,
        }),
      ).rejects.toThrow(/pr_number/);
    }
    expect(recorder.calls).toEqual([]);
  });

  it("rejects a non-positive installation id PER-CALL (the guard moved from ctor to clone — per-review routing)", async () => {
    const recorder = new SpawnRecorder();
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({ tokenProvider: provider, spawnFn: recorder.spawn });
    const workspace = await makeWorkspace();

    await expect(
      cloner.clone({
        workspace,
        repoUrl: "https://github.com/acme/widget.git",
        headSha: VALID_SHA,
        installationId: 0,
        paths: [],
      }),
    ).rejects.toThrow(/github_installation_id/);
    expect(recorder.calls).toEqual([]);
  });

  it("rejects a non-positive timeout at construction", () => {
    const { provider } = fakeTokenProvider();
    expect(
      () =>
        new GitSubprocessCloner({
          tokenProvider: provider,
          timeoutSeconds: 0,
        }),
    ).toThrow(/timeout_seconds/);
  });
});

// ─── Failure / timeout taxonomy ───────────────────────────────────────────────────────────────────

describe("GitSubprocessCloner failure taxonomy", () => {
  it("maps a non-zero exit to GitCloneFailedError with the exact message", async () => {
    const recorder = new SpawnRecorder([{ exitCode: 128, stderr: "fatal: not found" }]);
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: recorder.spawn,
    });
    const workspace = await makeWorkspace();

    await expect(
      cloner.clone({
        workspace,
        repoUrl: "https://github.com/acme/widget.git",
        headSha: VALID_SHA,
        installationId: INSTALLATION_ID,
        paths: [],
      }),
    ).rejects.toThrow(new GitCloneFailedError("git clone exited 128: fatal: not found"));
  });

  it("falls back to 'no output' when both streams are empty", async () => {
    const recorder = new SpawnRecorder([{ exitCode: 1 }]);
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: recorder.spawn,
    });
    const workspace = await makeWorkspace();

    await expect(
      cloner.clone({
        workspace,
        repoUrl: "https://github.com/acme/widget.git",
        headSha: VALID_SHA,
        installationId: INSTALLATION_ID,
        paths: [],
      }),
    ).rejects.toThrow("git clone exited 1: no output");
  });

  it("kills the subprocess and raises GitCloneTimeoutError on a hanging clone", async () => {
    let hangProc: FakeProcess | undefined;
    // First (and only) process hangs (never emits `close`) — drives the timeout path.
    const hangingRecorder = new SpawnRecorder([{ hang: true }]);
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      timeoutSeconds: 1, // 1s timeout — the transport seam fires the abort deterministically
      spawnFn: (command, args, options) => {
        const proc = hangingRecorder.spawn(command, args, options);
        hangProc ??= proc as unknown as FakeProcess;
        return proc;
      },
    });
    const workspace = await makeWorkspace();

    await expect(
      cloner.clone({
        workspace,
        repoUrl: "https://github.com/acme/widget.git",
        headSha: VALID_SHA,
        installationId: INSTALLATION_ID,
        paths: [],
      }),
    ).rejects.toThrow(GitCloneTimeoutError);

    expect(hangProc?.killCount).toBeGreaterThanOrEqual(1);
    expect(hangProc?.killSignals[0]).toBe("SIGTERM");
  }, 15_000);

  it("surfaces a spawn FAILURE (ENOENT) as a catchable GitCloneFailedError, not an uncaught crash", async () => {
    // `git` absent from the runtime image's PATH → spawn emits an `error` event, NOT `close`. WITHOUT an
    // `error` listener the unhandled event becomes an uncaught exception that crashes the fail-loud process —
    // one missing binary would take down the WHOLE pod instead of failing this one review. The cloner MUST
    // map the spawn failure to a catchable GitCloneFailedError so the clone activity degrades gracefully.
    const recorder = new SpawnRecorder([{ spawnError: "spawn git ENOENT" }]);
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({ tokenProvider: provider, spawnFn: recorder.spawn });
    const workspace = await makeWorkspace();

    await expect(
      cloner.clone({
        workspace,
        repoUrl: "https://github.com/acme/widget.git",
        headSha: VALID_SHA,
        installationId: INSTALLATION_ID,
        paths: [],
      }),
    ).rejects.toThrow(new GitCloneFailedError("git clone failed to spawn: spawn git ENOENT"));
  });
});

// ─── AbortSignal threading (W4.1 / de-Temporal gate ①) ─────────────────────────────────────────────

describe("GitSubprocessCloner AbortSignal threading", () => {
  it("pre-spawn abort: an already-aborted signal throws and spawns NO subprocess", async () => {
    const recorder = new SpawnRecorder();
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: recorder.spawn,
    });
    const workspace = await makeWorkspace();
    const aborted = AbortSignal.abort(new Error("pre-spawn-abort"));

    await expect(
      cloner.clone({
        workspace,
        repoUrl: "https://github.com/acme/widget.git",
        headSha: VALID_SHA,
        installationId: INSTALLATION_ID,
        paths: [],
        signal: aborted,
      }),
    ).rejects.toThrow(/pre-spawn-abort/);

    // The gate fired before the first runGit → ZERO subprocesses.
    expect(recorder.calls).toEqual([]);
    // And the askpass helper directory was cleaned up (the finally ran on the abort path).
    await expect(
      fs.access(path.join(workspace, ".codemaster-askpass", "askpass.sh")),
    ).rejects.toThrow();
  });

  it("mid-clone abort: the SIGTERM→SIGKILL teardown fires AND the askpass script is removed", async () => {
    let hangProc: FakeProcess | undefined;
    // The first (clone) process hangs — it never closes on its own; only an abort or timeout ends it.
    const hangingRecorder = new SpawnRecorder([{ hang: true }]);
    const { provider } = fakeTokenProvider();
    const controller = new AbortController();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      // A long transport timeout so the ABORT (not the timeout) is unambiguously what tore it down.
      timeoutSeconds: 3600,
      spawnFn: (command, args, options) => {
        const proc = hangingRecorder.spawn(command, args, options);
        hangProc ??= proc as unknown as FakeProcess;
        // Abort the external signal once the clone subprocess is in-flight (mid-clone).
        queueMicrotask(() => controller.abort(new Error("mid-clone-abort")));
        return proc;
      },
    });
    const workspace = await makeWorkspace();

    await expect(
      cloner.clone({
        workspace,
        repoUrl: "https://github.com/acme/widget.git",
        headSha: VALID_SHA,
        installationId: INSTALLATION_ID,
        paths: [],
        signal: controller.signal,
      }),
    ).rejects.toThrow(/mid-clone-abort/);

    // The EXISTING teardown ran: at least a SIGTERM was delivered to the hung subprocess.
    expect(hangProc?.killCount).toBeGreaterThanOrEqual(1);
    expect(hangProc?.killSignals[0]).toBe("SIGTERM");
    // The finally MUST run on the abort path → the askpass helper is gone.
    await expect(
      fs.access(path.join(workspace, ".codemaster-askpass", "askpass.sh")),
    ).rejects.toThrow();
  }, 15_000);

  it("no signal passed → byte-identical clone (the existing 3-command sequence, no abort plumbing)", async () => {
    const recorder = new SpawnRecorder();
    const { provider } = fakeTokenProvider();
    const cloner = new GitSubprocessCloner({
      tokenProvider: provider,
      spawnFn: recorder.spawn,
    });
    const workspace = await makeWorkspace();

    await cloner.clone({
      workspace,
      repoUrl: "https://github.com/acme/widget.git",
      headSha: VALID_SHA,
      installationId: INSTALLATION_ID,
      paths: [],
    });

    // Absent signal → identical to the pre-W4.1 path: clone, fetch, checkout.
    expect(recorder.calls.length).toBe(3);
    expect(recorder.calls.map((c) => c.argv[1])).toEqual(["clone", "fetch", "checkout"]);
  });
});
