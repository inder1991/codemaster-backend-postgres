/**
 * `clone_repository_activity` (Sprint 5 / S5.1.3) — the standalone clone primitive the
 * refresh_semantic_docs workflow proxies as Step 1.
 *
 * Shallow-clones a repo via HTTPS using the GitHub-App installation token into a per-tenant
 * cache-dir layout `<CODEMASTER_CLONE_CACHE_ROOT>/<installation_id>/<repository_id>/`. A size cap
 * (default 1 GiB) and a clone timeout (default 5 min) are enforced defensively; exceeding the size
 * cap WIPES the partial clone before raising (the safety-net invariant). The caller (the refresh
 * workflow's downstream activity) is responsible for tearing the dir down when the refresh completes.
 *
 * ## Separation: pure core vs activity boundary
 *
 * Separates a pure `perform_clone(...)` from the activity boundary so the orchestration is
 * unit-testable WITHOUT a Temporal context or a live git clone:
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
 * The refresh workflow originally dispatched this step as THREE string positionals. CLAUDE.md
 * invariant 11 forbids multi-positional activity dispatch, so the activity takes ONE typed
 * {@link CloneRepositoryInputV1}. The refresh_semantic_docs workflow proxy is updated in lockstep to
 * pass the single typed input. See the contract header for the full divergence note.
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

/** Default per-clone size cap — 1 GiB. */
export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
/** Default clone timeout — 5 minutes. */
export const DEFAULT_TIMEOUT_SECONDS = 300;
/** Default cache root — `/clone-cache`. Overridable via `CODEMASTER_CLONE_CACHE_ROOT`. */
export const DEFAULT_CLONE_CACHE_ROOT = "/clone-cache";
/** The working-tree subdir the reused GitSubprocessCloner checks out into (cloner.ts `REPO_SUBDIR`). The
 *  clone-returned path is `<targetDir>/<this>` — the REPO ROOT the refresh activity walks. */
export const CLONE_CHECKOUT_SUBDIR = "repo";

/** Resolve the cache root from the env at CALL TIME (so tests can override per-test): reads
 *  `CODEMASTER_CLONE_CACHE_ROOT`, defaulting to `/clone-cache`. */
function cloneCacheRoot(): string {
  const fromEnv = process.env["CODEMASTER_CLONE_CACHE_ROOT"];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_CLONE_CACHE_ROOT;
}

// ─── Typed errors ─────────────────────────────────────────────────────────────────────────────────

/** Base for clone failures. */
export class CloneError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CloneError";
  }
}

/** The clone exceeded the configured size cap mid-operation. */
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

/** Recursively remove `dir` (missing-ok). */
async function wipe(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * PURE clone orchestration. Computes the cache-dir layout, wipes a stale target, delegates the
 * actual git clone to the injected {@link CacheGitCloner}, then enforces the size cap (wiping the
 * partial clone on exceed). Returns the on-disk clone path STRING (bare path per the refresh
 * workflow's `Promise<string>` proxy shape).
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

  // Wipe a stale target then (re)create the parent.
  await wipe(targetDir);
  await fs.mkdir(path.dirname(targetDir), { recursive: true });

  await deps.cloner.clone({
    targetDir,
    repoFullName: req.repoFullName,
    headSha: req.headSha,
    installationToken: req.installationToken,
    timeoutSeconds,
  });

  // Size cap — wipe the partial clone before raising (safety-net invariant). Measured over
  // `targetDir` (the parent), which holds the whole clone footprint (the `repo/` working tree + the
  // transient askpass dir).
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
  // silently discovering ZERO knowledge docs. The clone goes DIRECTLY into target_dir
  // and target_dir is the repo root; returning `<targetDir>/repo` here is the faithful equivalent.
  return path.join(targetDir, CLONE_CHECKOUT_SUBDIR);
}

// ─── Production defaults ─────────────────────────────────────────────────────────────────────────

/**
 * REAL production default for {@link CacheGitCloner} — reuses {@link GitSubprocessCloner}. A one-shot
 * cloner is constructed per call whose `TokenProvider` returns the install token the boundary already
 * resolved (reuses the askpass + token-redaction + transport-timeout machinery).
 *
 * `GitSubprocessCloner.clone` lands the clone at `<targetDir>/repo`; the numeric installation id
 * passed is a sentinel `1` — the one-shot provider ignores it. NO `pr_number` (the refresh path clones
 * a branch head by SHA, not a PR ref).
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
 * `clone_repository_activity` boundary. Takes the SINGLE typed {@link CloneRepositoryInputV1}
 * (invariant 11). Resolves the repo `full_name` + numeric installation id, mints the install token
 * for the numeric id, then calls {@link performClone}. Returns the on-disk clone path STRING.
 */
export async function cloneRepositoryActivity(
  input: CloneRepositoryInputV1,
  deps: CloneRepositoryDeps,
): Promise<string> {
  // Re-validate independently at the boundary (don't trust the dispatcher).
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
