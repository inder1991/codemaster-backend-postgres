export const meta = {
  name: 'phase22-clone-seam',
  description: 'core-loop clone step: the minimal WIRED clone seam — CloneRepoIntoWorkspaceInput/WorkspaceHandle contracts + GitCloner Protocol + GitSubprocessCloner (3 git invocations + GIT_ASKPASS token auth + input validation + 60s timeout) + the clone_repo_into_workspace activity (head_sha check → cloner.clone → byte_size walk → 200MiB cap → ClonedRepoV1). DB lease lifecycle + heartbeats DEFERRED as injected no-op seams. Adversarial parity vs frozen Python: git argv/env construction + ClonedRepoV1/byte_size.',
  phases: [
    { title: 'PortSeam', detail: 'contracts (WorkspaceHandle + CloneRepoIntoWorkspaceInput) + GitCloner interface + GitSubprocessCloner (argv/env/askpass/validation/timeout) + errors + constants + TS-only unit tests' },
    { title: 'PortActivity', detail: 'clone_repo_into_workspace activity (lease-assert no-op seam → head_sha check → cloner.clone → _byte_size_of_dir → size cap → ClonedRepoV1) + stub cloner + unit tests' },
    { title: 'Verify', detail: 'adversarial dual-run vs frozen Python: git argv+env+cwd+askpass-body construction (pr_number set/None, validation rejects, token NOT in argv) + activity ClonedRepoV1/byte_size over a constructed tree' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC_CLONER = REPO + '/vendor/codemaster-py/codemaster/integrations/git/cloner.py'
const SRC_COMMON = REPO + '/vendor/codemaster-py/codemaster/activities/_clone_common.py'
const SRC_ACT = REPO + '/vendor/codemaster-py/codemaster/activities/_workspace_clone.py'
const SRC_HANDLE = REPO + '/vendor/codemaster-py/codemaster/workspace/_handle.py'
const SRC_TEST_CLONER = REPO + '/vendor/codemaster-py/tests/unit/integrations/git/test_cloner.py'
const SRC_TEST_REDACT = REPO + '/vendor/codemaster-py/tests/adversarial/test_git_clone_token_redaction.py'

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['component', 'files_written', 'commands', 'all_green', 'notes'],
  properties: {
    component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'passed'], properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } } } },
    all_green: { type: 'boolean' }, notes: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'checks', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['SOUND', 'WEAK', 'INCONCLUSIVE'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = [
  'WORKING DIR: ' + REPO + '. ABSOLUTE paths. Bash cwd RESETS between calls — prefix EVERY command with (cd ' + REPO + ' && ...).',
  'TS STYLE (validate-fast = gates -> lint -> typecheck -> test): ESM .js specifiers; "type" not "interface"; Array<T>; NO any (unknown+narrow); named exports; explicit return types; import { type X }; no unused vars; snake_case FILENAMES; camelCase members.',
  'IMPORTS: #contracts/* , #platform/* , #backend/* ; same-dir relative ./x.js.',
  'GATE: check_clock_random scans apps/** + libs/**/src — NO raw Date.now/Math.random/setTimeout/setInterval/AbortSignal.timeout outside the seams. The subprocess TIMEOUT must use the ESTABLISHED seam: grep libs/platform/src for transport_timeout / transportAbortSignal (the AbortSignal-timeout seam) and use it for the git timeout; if a kill-grace timer is needed, route it through the same seam (do NOT introduce a raw setTimeout). For determinism use FakeClock (#platform/clock.js). check_tenant_scoped_raw_sql: this slice has NO DB (the lease/heartbeat machinery is DEFERRED as no-op injected seams). NO NEW DEPS — use node:child_process (spawn/execFile), node:fs, node:os, node:path (built-ins, not deps).',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit; CLEAN UP scratch (UNIQUE names; delete from tools/parity). You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

phase('PortSeam')

const PORT_SEAM = [
  'Port the GIT CLONE SEAM (core-loop clone step, part 1 of 2) to TypeScript, 1:1 with frozen Python. This is the subprocess git driver + its contracts + error taxonomy. Deterministic command CONSTRUCTION (argv + env + cwd) is the parity surface — the actual git execution is external + stubbed in tests.',
  STYLE,
  'READ FULLY (frozen Python, READ-ONLY):',
  '- ' + SRC_CLONER + ' — GitSubprocessCloner. The exact: regexes _HEAD_SHA_RE=^[0-9a-f]{7,64}$ and _REPO_URL_RE=^https://github\\.com/[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+(?:\\.git)?$ ; _REPO_SUBDIR="repo"; _DEFAULT_TIMEOUT_SECONDS=60, _KILL_TIMEOUT_SECONDS=5; the clone() body (validate head_sha/repo_url/pr_number>0 → ValueError; token=await token_provider(installation_id); write GIT_ASKPASS script; env build; the THREE git commands with exact flags + cwd; finally-unlink askpass); _build_subprocess_env (GIT_ASKPASS + GIT_TERMINAL_PROMPT=0 + GIT_CONFIG_NOSYSTEM=1, layered over the process env); _run_git (create_subprocess_exec, wait_for(timeout) → on TimeoutError SIGTERM then 5s then SIGKILL → GitCloneTimeoutError; returncode!=0 → GitCloneFailedError with "git <verb> exited <rc>: <stderr|stdout|no output>"); _write_askpass_script (body `#!/bin/sh\\nprintf \'%s\' \'<safe_token>\'\\n` where safe_token = token.replace("\'", "\'\\\\\'\'"); chmod 0o700).',
  '- ' + SRC_COMMON + ' — MAX_WORKSPACE_BYTES=200*1024*1024; CloneFailedError(repo, head_sha, reason) msg "clone failed for <repo>@<sha[:8]>: <reason>"; WorkspaceTooLargeError(repo, head_sha, byte_size) msg; GitCloner Protocol (async clone({workspace, repo_url, head_sha, paths, pr_number})); _byte_size_of_dir (sum of regular non-symlink file sizes via rglob, skip OSError on stat).',
  '- ' + SRC_HANDLE + ' — WorkspaceHandle (Pydantic v2; the EXACT fields; derived_path serializes Path→str over the wire). ' + SRC_ACT + ':92-110 — CloneRepoIntoWorkspaceInput (extra=forbid; schema_version:1; handle: WorkspaceHandle; repo_url; head_sha; changed_paths: tuple[str,...]; pr_number: int|None=None).',
  '- ' + SRC_TEST_CLONER + ' + ' + SRC_TEST_REDACT + ' — the parity reference: a _SubprocessRecorder stubbing create_subprocess_exec to capture argv/env/cwd; asserts the 3-command argv, env keys, fetch-ref selection (pull/<n>/head vs SHA), token NOT in any argv, token only in the askpass script body.',
  'ALREADY PORTED — REUSE: #contracts/cloned_repo.v1.js (ClonedRepoV1). Grep apps/backend/src/backend for an EXISTING installation-token provider seam (a (installationId)=>Promise<string> callback ported in an earlier phase) — reuse its type if present, else define a local _TokenProvider type. Grep libs/platform/src for the transport-timeout seam (use it for the 60s git timeout). FakeClock from #platform/clock.js for tests.',
  'PORT TO (create):',
  '- ' + REPO + '/libs/contracts/src/workspace_handle.v1.ts (WorkspaceHandle Zod, .strict-ish per the Python config; derived_path as string) + ' + REPO + '/libs/contracts/src/clone_repo_into_workspace_input.v1.ts (CloneRepoIntoWorkspaceInput Zod, extra=forbid → .strict(); nested handle). Parity tests test/contracts/{workspace_handle,clone_repo_into_workspace_input}.v1.parity.test.ts driving the frozen Python via the established oracle.',
  '- ' + REPO + '/apps/backend/src/backend/integrations/git/errors.ts — GitClonerError/GitCloneFailedError/GitCloneTimeoutError + CloneFailedError + WorkspaceTooLargeError (the messages EXACT, incl. head_sha[:8]).',
  '- ' + REPO + '/apps/backend/src/backend/integrations/git/cloner.ts — the GitCloner type (interface) + GitSubprocessCloner implementing it: a SpawnFn seam (default node:child_process spawn; tests inject a recorder) so the argv/env/cwd are observable; the validation; the askpass write (node:fs writeFile + chmod 0o700 into workspace/.codemaster-askpass/askpass.sh, the EXACT body + escaping); the env build; the 3 git invocations (exact flags + cwd); the timeout via the platform seam; finally-unlink. Constants MAX_WORKSPACE_BYTES, REPO_SUBDIR, the regexes, timeouts.',
  '- ' + REPO + '/apps/backend/src/backend/integrations/git/byte_size.ts — byteSizeOfDir (sum of regular non-symlink file sizes; skip stat errors). node:fs.',
  'UNIT TESTS (TS-only, deterministic — inject a spawn recorder; do NOT spawn real git): test/unit/integrations/git/cloner.test.ts — assert the 3-command argv sequence + cwds + env (GIT_ASKPASS/GIT_TERMINAL_PROMPT/GIT_CONFIG_NOSYSTEM) for pr_number set (fetch pull/<n>/head) AND None (fetch head_sha); the validation rejects (bad sha / bad url / pr_number<=0); the askpass body + 0700; token NEVER in any argv (adversarial); returncode!=0 → GitCloneFailedError; timeout → GitCloneTimeoutError. test/unit/integrations/git/byte_size.test.ts — byteSizeOfDir over a constructed temp tree (files + a symlink skipped).',
  'Return component="clone_seam", files_written, commands, all_green, notes: the EXACT argv per command, the askpass body + escaping, the env keys, the timeout-seam used, the token-provider reuse, and any divergence risk for the verifier (esp. env layering over process env, the askpass escaping, the spawn-recorder seam shape).',
].join('\n')

const portSeam = await agent(PORT_SEAM, { label: 'port:clone-seam', phase: 'PortSeam', schema: BUILD_SCHEMA })

phase('PortActivity')

const PORT_ACT = [
  'Port the clone_repo_into_workspace ACTIVITY (core-loop clone step, part 2 of 2) to TypeScript, 1:1 with frozen Python. Depends on part 1 (the GitCloner seam + contracts + errors just ported under #backend/integrations/git/ + #contracts/{workspace_handle,clone_repo_into_workspace_input}.v1.js).',
  STYLE,
  'Part-1 built (REUSE its exports — grep them): ' + JSON.stringify(portSeam).slice(0, 500),
  'READ FULLY: ' + SRC_ACT + ' (the activity 133-262). The body: (1)+(2) lease-state assertion + heartbeat bump in a DB txn — DEFER: model as an injected `assertLeaseAllocated?` collaborator with a NO-OP default (the observable ClonedRepoV1 does NOT depend on it; a StateDrift-raising impl is the error path); activity.heartbeat(...) → an injected `heartbeat?` callback defaulting to no-op. (3) head_sha falsy or len<7 (_MIN_HEAD_SHA_LEN=7) → CloneFailedError(reason="missing head_sha"). (4) cloner.clone({workspace=handle.derived_path, repo_url, head_sha, paths=changed_paths, pr_number}); wrap any non-CloneFailedError in CloneFailedError(reason=str(e)) (re-raise an existing CloneFailedError unchanged). (5) byteSizeOfDir(workspace_path); > MAX_WORKSPACE_BYTES → WorkspaceTooLargeError. (6) return ClonedRepoV1(workspace_path=str(derived_path), repo_path=str(derived_path/"repo"), head_sha, byte_size).',
  'PATTERN: match the established TS activity shape (explicit collaborator arg, NOT the Python module-level configure() globals) — e.g. cloneRepoIntoWorkspace(req: CloneRepoIntoWorkspaceInput, deps: { cloner: GitCloner; assertLeaseAllocated?: (...)=>Promise<void>; heartbeat?: (p: unknown)=>void }): Promise<ClonedRepoV1>. The no-op defaults make the lease/heartbeat machinery deferrable WITHOUT changing the observable output. Document the deferred DB lease lifecycle + heartbeats as tracked follow-ups (FOLLOW-UP-workspace-lease-lifecycle, FOLLOW-UP-clone-activity-heartbeats).',
  'PORT TO (create): ' + REPO + '/apps/backend/src/backend/activities/clone_repo_into_workspace.activity.ts — the activity function + a StubCloner helper (a GitCloner that creates a marker file in workspace/repo, for tests + the verifier dual-run) exported from a sibling test-support or the same file.',
  'UNIT TESTS: test/unit/activities/clone_repo_into_workspace.test.ts — with a StubCloner (writes known files into workspace/repo): returns ClonedRepoV1 with the right workspace_path/repo_path/head_sha/byte_size; head_sha too short → CloneFailedError("missing head_sha"); cloner throwing a generic Error → wrapped in CloneFailedError; oversized tree → WorkspaceTooLargeError; the no-op lease/heartbeat defaults do not affect output. Use os.tmpdir for the workspace.',
  'Return component="clone_activity", files_written, commands, all_green, notes: the deferred lease/heartbeat seam shape + their defaults, the error-wrapping rule, the ClonedRepoV1 field construction, and any divergence risk for the verifier.',
].join('\n')

const portAct = await agent(PORT_ACT, { label: 'port:clone-activity', phase: 'PortActivity', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL Tier-1 verifier for the clone seam + activity. REFUTE that (A) the TS GitSubprocessCloner constructs the SAME git argv + env + cwd + askpass-body as frozen Python, and (B) the TS clone_repo_into_workspace activity returns a ClonedRepoV1 byte-equal to the frozen Python activity for the same stub-cloned tree.',
  STYLE,
  'Built: ' + JSON.stringify({ portSeam, portAct }).slice(0, 600),
  'A — GIT ARGV/ENV PARITY: independently drive the frozen Python GitSubprocessCloner (' + SRC_CLONER + ', GitSubprocessCloner) with a recording stub for asyncio.create_subprocess_exec (capture argv+env+cwd, return returncode 0) AND the TS GitSubprocessCloner with an injected spawn recorder, via a throwaway tools/parity/_clone_seam_scratch.{py,ts} (UNIQUE names; DELETE after). Use a FIXED token + installation_id. Byte-compare, for BOTH pr_number=42 and pr_number=None: the 3-command argv sequences; the cwds; the env keys/values added (GIT_ASKPASS path-shape, GIT_TERMINAL_PROMPT=0, GIT_CONFIG_NOSYSTEM=1); the askpass script BODY (printf token line + escaping); and assert the token appears in NONE of the argv. Also confirm the validation rejects (bad sha "xyz", non-github url, pr_number=0) raise on BOTH sides.',
  'B — ACTIVITY ClonedRepoV1 PARITY: construct an identical workspace tree on both sides (a stub cloner that writes the SAME set of files — e.g. repo/a.py (100 bytes), repo/sub/b.txt (53 bytes), a symlink that must be SKIPPED). Drive the frozen Python clone_repo_into_workspace_activity (stub cloner + a no-op/stubbed lease+heartbeat — mirror tests/integration/workspace/test_clone_into_workspace_activity.py wiring, or call the inner logic directly if the DB lease is unavoidable; if you must bypass the DB, drive _byte_size_of_dir + the ClonedRepoV1 construction directly and SAY SO) and the TS cloneRepoIntoWorkspace; byte-compare the ClonedRepoV1 (workspace_path/repo_path/head_sha/byte_size). Also: head_sha too short → CloneFailedError on both; oversized → WorkspaceTooLargeError on both.',
  'Run (cd ' + REPO + ' && npx vitest run <the clone tests>) + check_clock_random; tsc clean (delete scratch FIRST). verdict=WEAK if the argv/env/cwd/askpass differs, the token leaks into argv, a validation rejection diverges, or ClonedRepoV1/byte_size diverges; SOUND otherwise. Give the exact diverging command/field. Clean up ALL scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:clone-seam', phase: 'Verify', schema: VERIFY_SCHEMA })

return { portSeam, portAct, verify }
