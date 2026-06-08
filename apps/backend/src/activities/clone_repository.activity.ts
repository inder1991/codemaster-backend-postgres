/**
 * `clone_repository_activity` — 1:1 port of the frozen Python
 * `codemaster/activities/clone_repository.py` (Sprint 5 / S5.1.3): the standalone clone primitive the
 * refresh_semantic_docs workflow proxies as Step 1.
 *
 * Shallow-clones a repo via HTTPS using the GitHub-App installation token into a per-tenant
 * cache-dir layout `<CODEMASTER_CLONE_CACHE_ROOT>/<installation_id>/<repository_id>/`. A size cap
 * (default 1 GiB) and a clone timeout (default 5 min) are enforced defensively; exceeding the size
 * cap WIPES the partial clone before raising (the safety-net invariant — 1:1 with the Python
 * `_wipe(target_dir)` on `CloneSizeCapExceeded`). The caller (the refresh workflow's downstream
 * activity) is responsible for tearing the dir down when the refresh completes.
 *
 * ## Separation: pure core vs activity boundary (1:1 with the Python)
 *
 * The Python separates a pure `perform_clone(...)` from the `@activity.defn
 * clone_repository_activity(...)` so the orchestration is unit-testable WITHOUT a Temporal context
 * or a live git clone. This port keeps that separation:
 *
 *   - {@link performClone} — the PURE orchestration core. Owns the cache-dir layout, the
 *     wipe-on-exists, the size cap (+ wipe on exceed), and delegates the actual git work to an
 *     injected {@link CacheGitCloner} seam (stubbed in tests; production default reuses the
 *     already-ported {@link GitSubprocessCloner}). The install token is passed IN (the boundary
 *     resolves it) — the core never touches Vault / GitHub.
 *   - {@link cloneRepositoryActivity} — the activity boundary. Resolves the repo `full_name`
 *     (installation-scoped) + the numeric GitHub installation id from Postgres, mints the install
 *     token via the injected {@link TokenProvider}, then calls {@link performClone}.
 *
 * ## INVARIANT-11 DIVERGENCE (CLAUDE.md #11, LOCKED) — surfaced for the integrator
 *
 * The frozen Python refresh workflow dispatches this step as THREE string positionals
 * (`args=[str(installation_id), str(repository_id), head_sha]`). CLAUDE.md invariant 11 forbids
 * multi-positional activity dispatch in the TS port, so the activity takes ONE typed
 * {@link CloneRepositoryInputV1}. The refresh_semantic_docs workflow proxy is updated in lockstep to
 * pass the single typed input. (The Python `clone_repository_activity` itself already took a single
 * `payload_dict` it validated as a Pydantic `CloneRequestV1` — but with a DIFFERENT field shape;
 * the Python WORKFLOW's 3-positional call to it is the actual invariant-11 violation this port
 * resolves. See the contract header for the full divergence note.)
 *
 * ## Injected deps (for the integrator to wire — see {@link CloneRepositoryDeps})
 *
 *   - `cloner: CacheGitCloner` — the git-driver seam. Production default
 *     {@link defaultCacheCloner} reuses {@link GitSubprocessCloner} (the already-ported subprocess
 *     git cloner): a one-shot cloner whose token provider returns the resolved install token. Tests
 *     inject a recording stub.
 *   - `resolveRepo` — resolves `{ fullName, githubInstallationId }` from `core.repositories` ⨝
 *     `core.installations` (installation-scoped). Production default {@link defaultResolveRepo} runs
 *     ONE tenancy-filtered query on the shared ADR-0062 pool. Tests inject a stub.
 *   - `getToken: TokenProvider` — the GitHub-App installation token provider (numeric installation
 *     id → token). The INTEGRATOR wires the lazy `GitHubAppTokenProvider` (same as the review
 *     cloner's `getToken`); there is no production default here (no Vault-backed provider lives in
 *     this module).
 *
 * ## SANDBOX SAFETY
 * This module is an ACTIVITY (runs in the worker process, NOT the workflow V8 isolate). It does git
 * subprocess / DB / fs / clock work — all of which is forbidden in a workflow body but fine here.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { byteSizeOfDir } from "#backend/integrations/git/byte_size.js";
import { GitSubprocessCloner } from "#backend/integrations/git/cloner.js";
import { type TokenProvider } from "#backend/integrations/github/api_client.js";

import { getPool, withPgTransaction } from "#platform/db/database.js";

import { CloneRepositoryInputV1 } from "#contracts/clone_repository.v1.js";

/** Default per-clone size cap — 1 GiB. Mirrors `clone_repository.DEFAULT_MAX_BYTES`. */
export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
/** Default clone timeout — 5 minutes. Mirrors `clone_repository.DEFAULT_TIMEOUT_SECONDS`. */
export const DEFAULT_TIMEOUT_SECONDS = 300;
/** Default cache root — `/clone-cache`. Overridable via `CODEMASTER_CLONE_CACHE_ROOT`. */
export const DEFAULT_CLONE_CACHE_ROOT = "/clone-cache";
/** The working-tree subdir the reused GitSubprocessCloner checks out into (cloner.ts `REPO_SUBDIR`). The
 *  clone-returned path is `<targetDir>/<this>` — the REPO ROOT the refresh activity walks. */
export const CLONE_CHECKOUT_SUBDIR = "repo";

/** Resolve the cache root from the env at CALL TIME (so tests can override per-test). Mirrors the
 *  Python `CLONE_CACHE_ROOT = Path(os.environ.get("CODEMASTER_CLONE_CACHE_ROOT", "/clone-cache"))`. */
function cloneCacheRoot(): string {
  const fromEnv = process.env["CODEMASTER_CLONE_CACHE_ROOT"];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_CLONE_CACHE_ROOT;
}

// ─── Typed errors (1:1 with the Python clone error taxonomy) ─────────────────────────────────────

/** Base for clone failures. Mirrors `clone_repository.CloneError`. */
export class CloneError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CloneError";
  }
}

/** The clone exceeded the configured size cap mid-operation. Mirrors `CloneSizeCapExceeded`. */
export class CloneSizeCapExceeded extends CloneError {
  public constructor(message: string) {
    super(message);
    this.name = "CloneSizeCapExceeded";
  }
}

// ─── Seams ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The cache-clone git-driver seam. Production reuses {@link GitSubprocessCloner}; tests inject a
 * recording stub. Unlike the review-pipeline {@link import("#backend/integrations/git/cloner.js").GitCloner}
 * (which mints its OWN token from a numeric id), this seam takes the install token directly — the
 * activity boundary already resolved it, keeping the pure core free of Vault/GitHub access.
 */
export type CacheGitCloner = {
  clone(args: {
    /** The cache workspace `<cacheRoot>/<installation_id>/<repository_id>` to clone into. */
    targetDir: string;
    /** The `owner/repo` GitHub full name (resolved at the activity boundary). */
    repoFullName: string;
    /** The commit to land. */
    headSha: string;
    /** The GitHub-App installation token (resolved at the activity boundary). */
    installationToken: string;
    /** The clone timeout budget in seconds. */
    timeoutSeconds: number;
  }): Promise<void>;
};

/** The repo-identity resolution the activity boundary performs before cloning. */
export type RepoResolution = {
  /** `owner/repo` from `core.repositories.full_name`. */
  fullName: string;
  /** Numeric GitHub-App installation id from `core.installations.github_installation_id`. */
  githubInstallationId: number;
};

/** Resolve `{ fullName, githubInstallationId }` for a `(installation_id, repository_id)` pair. */
export type ResolveRepoFn = (args: {
  installationId: string;
  repositoryId: string;
}) => Promise<RepoResolution>;

// ─── Pure orchestration core ─────────────────────────────────────────────────────────────────────

/** Recursively remove `dir` (missing-ok). Mirrors the Python `_wipe` (`shutil.rmtree(ignore_errors=True)`). */
async function wipe(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * PURE clone orchestration — 1:1 with the Python `perform_clone`. Computes the cache-dir layout,
 * wipes a stale target, delegates the actual git clone to the injected {@link CacheGitCloner}, then
 * enforces the size cap (wiping the partial clone on exceed). Returns the on-disk clone path STRING
 * (the Python returns a `CloneResultV1`; the TS port returns the bare path per the refresh workflow's
 * `Promise<string>` proxy shape — the byte_size / head_sha the Python model carried are not consumed
 * by the refresh workflow).
 *
 * @throws {CloneSizeCapExceeded} the cloned tree exceeds `maxBytes` (the partial clone is wiped first).
 * @throws any error the cloner raises (e.g. GitCloneFailedError / GitCloneTimeoutError) — propagated
 *         so the workflow's non-retryable / retry curve applies.
 */
export async function performClone(
  req: {
    installationId: string;
    repositoryId: string;
    repoFullName: string;
    headSha: string;
    installationToken: string;
    maxBytes?: number;
    timeoutSeconds?: number;
  },
  deps: { cloner: CacheGitCloner },
): Promise<string> {
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutSeconds = req.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  const targetDir = path.join(cloneCacheRoot(), req.installationId, req.repositoryId);

  // Wipe a stale target then (re)create the parent — mirrors the Python
  // `if target_dir.exists(): _wipe(...)` + `target_dir.parent.mkdir(parents=True, exist_ok=True)`.
  await wipe(targetDir);
  await fs.mkdir(path.dirname(targetDir), { recursive: true });

  await deps.cloner.clone({
    targetDir,
    repoFullName: req.repoFullName,
    headSha: req.headSha,
    installationToken: req.installationToken,
    timeoutSeconds,
  });

  // Size cap — wipe the partial clone before raising (the Python safety-net invariant). Measured over
  // `targetDir` (the parent), which holds the whole clone footprint (the `repo/` working tree + the
  // transient askpass dir) — 1:1 with the Python which size-walks the clone target.
  const byteSize = await byteSizeOfDir(targetDir);
  if (byteSize > maxBytes) {
    await wipe(targetDir);
    throw new CloneSizeCapExceeded(
      `clone of ${req.repoFullName} reached ${byteSize} bytes, exceeds cap ${maxBytes}`,
    );
  }

  // Return the REPO-ROOT working tree, NOT the bare `targetDir`. The reused GitSubprocessCloner (and the
  // test stub) check the tree out at `<targetDir>/repo` (cloner.ts REPO_SUBDIR), so the bare `targetDir`
  // is one level ABOVE the repo root. The refresh activity walks the returned path directly
  // (`discoverKnowledgeDocs({ workspace })` → `join(workspace, doc.relative_path)`); returning `targetDir`
  // would surface every doc with a `repo/` PREFIX, which `isInScope` (README.md / docs/ …) then drops —
  // silently discovering ZERO knowledge docs. The Python `perform_clone` clones DIRECTLY into target_dir
  // and returns it as the repo root; returning `<targetDir>/repo` here is the faithful equivalent.
  return path.join(targetDir, CLONE_CHECKOUT_SUBDIR);
}

// ─── Production defaults ─────────────────────────────────────────────────────────────────────────

/**
 * REAL production default for {@link CacheGitCloner} — reuses {@link GitSubprocessCloner} (the
 * already-ported subprocess git cloner). A one-shot cloner is constructed per call whose
 * `TokenProvider` returns the install token the boundary already resolved (so the askpass +
 * token-redaction machinery + the transport-timeout seam are all reused, NOT re-implemented).
 *
 * `GitSubprocessCloner.clone` lands the clone at `<targetDir>/repo` and validates the `repoUrl`
 * shape (`https://github.com/<owner>/<repo>`); we build it from the resolved `full_name`. The numeric
 * installation id passed to it is a sentinel `1` — the cloner only uses it to call the token provider,
 * which here ignores it and returns the pre-resolved token. NO `pr_number` (the refresh path clones a
 * branch head by SHA, not a PR ref).
 */
export const defaultCacheCloner: CacheGitCloner = {
  async clone(args): Promise<void> {
    const tokenProvider: TokenProvider = async () => args.installationToken;
    const cloner = new GitSubprocessCloner({
      tokenProvider,
      timeoutSeconds: args.timeoutSeconds,
    });
    await cloner.clone({
      workspace: args.targetDir,
      repoUrl: `https://github.com/${args.repoFullName}`,
      headSha: args.headSha,
      installationId: 1, // sentinel: the one-shot tokenProvider ignores it and returns the resolved token.
      paths: [],
      prNumber: null,
    });
  },
};

/**
 * REAL production default for {@link ResolveRepoFn}. Runs ONE installation-scoped query joining
 * `core.repositories` (full_name) to `core.installations` (numeric github_installation_id) on the
 * shared ADR-0062 pool resolved from `CODEMASTER_PG_CORE_DSN`.
 *
 * Tenancy: the SELECT filters on `installation_id` (the repositories row is tenant-scoped; the join
 * to installations is by the SAME UUID). Default-deny — a missing/foreign repo yields NO row and the
 * resolver raises {@link CloneError} rather than cloning an unauthorized repo.
 *
 * @throws {Error}      `CODEMASTER_PG_CORE_DSN` unset.
 * @throws {CloneError} no installation-scoped repository row (default-deny).
 */
export async function defaultResolveRepo(args: {
  installationId: string;
  repositoryId: string;
}): Promise<RepoResolution> {
  const dsn = process.env["CODEMASTER_PG_CORE_DSN"];
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set and no resolveRepo injected; cannot resolve the repo full_name",
    );
  }
  const pool = getPool(dsn);
  return withPgTransaction(pool, async (client) => {
    // Tenancy-filtered: installation_id is in the WHERE clause (and is the join key to installations).
    const res = await client.query<{ full_name: string; github_installation_id: string }>(
      "SELECT r.full_name, i.github_installation_id " +
        "FROM core.repositories r " +
        "JOIN core.installations i ON i.installation_id = r.installation_id " +
        "WHERE r.repository_id = $1 AND r.installation_id = $2",
      [args.repositoryId, args.installationId],
    );
    const row = res.rows[0];
    if (row === undefined) {
      throw new CloneError(
        `repository_id=${args.repositoryId} not found for installation_id=${args.installationId}; cannot clone`,
      );
    }
    return {
      fullName: row.full_name,
      // github_installation_id is a bigint → pg returns it as a string; coerce to number.
      githubInstallationId: Number(row.github_installation_id),
    };
  });
}

// ─── Activity boundary ───────────────────────────────────────────────────────────────────────────

/**
 * Injected collaborators. All three are OPTIONAL for `cloner`/`resolveRepo` (REAL production
 * defaults); `getToken` is REQUIRED — there is no Vault-backed token provider in this module, so the
 * INTEGRATOR wires the lazy `GitHubAppTokenProvider`.
 */
export type CloneRepositoryDeps = {
  /** Git-driver seam. Production default: {@link defaultCacheCloner} (reuses GitSubprocessCloner). */
  cloner?: CacheGitCloner;
  /** Repo-identity resolver. Production default: {@link defaultResolveRepo} (one tenancy-scoped query). */
  resolveRepo?: ResolveRepoFn;
  /** GitHub-App installation token provider (numeric id → token). Wired by the integrator. */
  getToken: TokenProvider;
};

/**
 * `clone_repository_activity` boundary — 1:1 with the Python `@activity.defn`. Takes the SINGLE
 * typed {@link CloneRepositoryInputV1} (invariant 11). Resolves the repo `full_name` + numeric
 * installation id, mints the install token for the numeric id, then calls {@link performClone}.
 * Returns the on-disk clone path STRING (the refresh workflow's Step-1 `Promise<string>` shape).
 */
export async function cloneRepositoryActivity(
  input: CloneRepositoryInputV1,
  deps: CloneRepositoryDeps,
): Promise<string> {
  // Re-validate independently at the boundary (don't trust the dispatcher) — 1:1 with the Python
  // `CloneRequestV1.model_validate(payload_dict)` re-validation idiom.
  const req = CloneRepositoryInputV1.parse(input);

  const cloner = deps.cloner ?? defaultCacheCloner;
  const resolveRepo = deps.resolveRepo ?? defaultResolveRepo;

  const { fullName, githubInstallationId } = await resolveRepo({
    installationId: req.installation_id,
    repositoryId: req.repository_id,
  });

  const installationToken = await deps.getToken(githubInstallationId);

  return performClone(
    {
      installationId: req.installation_id,
      repositoryId: req.repository_id,
      repoFullName: fullName,
      headSha: req.head_sha,
      installationToken,
    },
    { cloner },
  );
}

/**
 * Test/verifier {@link CacheGitCloner} stub. Writes a marker file into `<targetDir>/repo` so the
 * activity's byte-size walk observes a real, deterministic on-disk footprint without a real git
 * round-trip. Mirrors the role of the review-pipeline `StubCloner`.
 */
export class StubCacheCloner implements CacheGitCloner {
  private readonly bodyBytes: number;

  public constructor({ bodyBytes = 16 }: { bodyBytes?: number } = {}) {
    this.bodyBytes = bodyBytes;
  }

  public async clone(args: {
    targetDir: string;
    repoFullName: string;
    headSha: string;
    installationToken: string;
    timeoutSeconds: number;
  }): Promise<void> {
    const repoDir = path.join(args.targetDir, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, "MARKER.bin"), Buffer.alloc(this.bodyBytes, 0x61));
  }
}
