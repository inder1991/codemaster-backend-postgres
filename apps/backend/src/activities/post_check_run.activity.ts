/**
 * `postCheckRun` activity — Phase-2.1 core-loop activity #5. Posts a `codemaster/review` GitHub
 * check-run alongside every review so PR authors see a status indicator next to the merge button even
 * when there are zero findings.
 *
 * ## Conclusion is ALWAYS "neutral" (CLAUDE.md invariant 9)
 *
 * codemaster is advisory and NEVER blocks a merge. The `conclusion` is pinned to `"neutral"` both in
 * the {@link GhCheckRunClient} type and at every call site below.
 *
 * ## Idempotent find→update/create
 *
 * If a check-run with the same name (`codemaster/review`) already exists at the same head SHA, the
 * activity UPDATEs it in place (one rolling run) rather than creating a duplicate. The
 * {@link doPostCheckRun} decision: validate non-empty summary + head_sha (else throw); look up the
 * existing run; PATCH-or-POST; return `{check_run_id, was_update}`.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The single positional input is the {@link PostCheckRunInputV1} envelope, introduced during the port.
 *
 * ## Pure logic vs. real wiring
 *
 * {@link doPostCheckRun} has the {@link GhCheckRunClient} INJECTED — the Tier-1 parity oracle drives it
 * over a scripted STUB client so the find→update/create LOGIC is verifiable WITHOUT any real GitHub
 * round-trip. {@link postCheckRun} is the registered activity that constructs the REAL
 * {@link GitHubApiCheckRunClient} over a {@link GitHubApiClient} (Vault token provider + per-review
 * installation id). The REST round-trips are covered by the recording-stub test against the
 * GitHubApiClient transport.
 */

import { FetchGitHubHttpClient, GitHubApiClient } from "#backend/integrations/github/api_client.js";
import {
  CHECK_RUN_NAME,
  GitHubApiCheckRunClient,
  type CheckRunStatus,
  type GhCheckRunClient,
} from "#backend/integrations/github/check_run_client.js";
import { GitHubAppTokenProvider } from "#backend/integrations/github/token_provider.js";

import { WallClock } from "#platform/clock.js";

import type { PostCheckRunInputV1, PostedCheckRunV1 } from "#contracts/posted_check_run.v1.js";

/**
 * The `_do_post_check_run` orchestration:
 *
 *   if not summary:  throw  "summary must be non-empty"
 *   if not headSha:  throw  "head_sha must be set"
 *   existing = findExistingCheckRun(owner, repo=repoName, head_sha=headSha, name=CHECK_RUN_NAME)
 *   if existing != null:
 *     updateCheckRun(owner, repo=repoName, check_run_id=existing, status, conclusion="neutral", summary)
 *     return { check_run_id: existing, was_update: true }
 *   newId = createCheckRun(owner, repo=repoName, head_sha=headSha, name=CHECK_RUN_NAME, status,
 *                          conclusion="neutral", summary)
 *   return { check_run_id: newId, was_update: false }
 *
 * The {@link GhCheckRunClient} is INJECTED so the parity oracle drives the same orchestration the
 * activity runs. `status` defaults to "completed"; `conclusion` is ALWAYS "neutral".
 */
export async function doPostCheckRun({
  prMeta,
  headSha,
  summary,
  owner,
  repoName,
  ghClient,
  status = "completed",
}: {
  prMeta: PostCheckRunInputV1["pr_meta"];
  headSha: string;
  summary: string;
  owner: string;
  repoName: string;
  ghClient: GhCheckRunClient;
  status?: CheckRunStatus;
}): Promise<PostedCheckRunV1> {
  // `prMeta` is carried in the signature to match the workflow-body dispatch shape, but the
  // byte-significant logic does NOT read it — the check-run targets owner/repo/head_sha directly.
  // Mark it intentionally-unread rather than dropping it from the contract-shaped args.
  void prMeta;
  // The empty-string checks live HERE (not in the contract) so they raise early,
  // and so the parity oracle's "empty summary / empty head_sha → raises" cases byte-match.
  if (summary === "") {
    throw new Error("summary must be non-empty");
  }
  if (headSha === "") {
    throw new Error("head_sha must be set");
  }

  const existing = await ghClient.findExistingCheckRun({
    owner,
    repo: repoName,
    headSha,
    name: CHECK_RUN_NAME,
  });
  if (existing !== null) {
    await ghClient.updateCheckRun({
      owner,
      repo: repoName,
      checkRunId: existing,
      status,
      conclusion: "neutral",
      summary,
    });
    return { schema_version: 1, check_run_id: existing, was_update: true };
  }

  const newId = await ghClient.createCheckRun({
    owner,
    repo: repoName,
    headSha,
    name: CHECK_RUN_NAME,
    status,
    conclusion: "neutral",
    summary,
  });
  return { schema_version: 1, check_run_id: newId, was_update: false };
}

/**
 * The registered activity. Takes the single typed {@link PostCheckRunInputV1} envelope (invariant 11),
 * constructs the REAL {@link GitHubApiCheckRunClient} over a {@link GitHubApiClient} (Vault token provider
 * + the per-review numeric installation id from the input), and delegates to {@link doPostCheckRun}.
 * Per-review routing (replaces the removed `CODEMASTER_GITHUB_INSTALLATION_ID` env pin): ONE token provider
 * → ONE GitHubApiClient → wrapped in the check-run client at the input's installation id.
 */
export async function postCheckRun(input: PostCheckRunInputV1): Promise<PostedCheckRunV1> {
  // Per-review routing: the numeric installation id comes from the input. Defensive null guard — the
  // check-run posts only after a successful clone (which fail-closes on null), so this should never fire.
  const installationId = input.github_installation_id;
  if (installationId === null) {
    throw new Error(
      "github_installation_id is null in the post_check_run input — cannot post without a per-review " +
        "installation id (per-review routing).",
    );
  }
  const clock = new WallClock();
  // One GitHub HTTP transport shared by the token-provider's JWT→installation-token mint AND the
  // GitHubApiClient's check-run calls. fromEnv resolves creds DB > env > Vault, building VaultHttpPort
  // LAZILY only if DB+env miss — so an openshift-no-Vault pod never eagerly constructs it. (Review P1
  // parity: do NOT pre-build `VaultHttpPort.fromEnv()` — it throws VAULT_ADDR-unset before resolution.)
  const githubHttp = new FetchGitHubHttpClient({});
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({
    http: githubHttp,
    clock,
  });
  const api = new GitHubApiClient({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
    http: githubHttp,
    clock,
  });
  const ghClient = new GitHubApiCheckRunClient({ api, installationId });

  return doPostCheckRun({
    prMeta: input.pr_meta,
    headSha: input.head_sha,
    summary: input.summary,
    owner: input.owner,
    repoName: input.repo_name,
    ghClient,
  });
}
