# Per-Review GitHub Installation Routing — Implementation Plan

> **For agentic workers:** TDD per task — red test, watch it fail, green, refactor. Steps use checkbox (`- [ ]`).

**Goal:** Remove the `CODEMASTER_GITHUB_INSTALLATION_ID` pod-wide env pin so one worker pool serves all 100 orgs; the per-PR numeric GitHub installation id flows from the webhook → review row → workflow payload → each GitHub activity's typed input, and the token is minted for *that* installation.

**Architecture:** One process-wide `GitHubAppTokenProvider` holds only the **App credential** (app_id + private key from Vault) and already mints/caches **per-installation** (`getToken(installationId)`, LRU 1000). The bug is the *binding point*: the cloner binds the env id at construction, and five post-activities mint from the env id. The fix threads the per-review `github_installation_id` (already in the workflow payload) into each activity input and uses it at the mint/clone call. The App identity stays one-per-environment (CLAUDE.md inv. 4); the **installation** is per-review.

**Tech Stack:** Zod contracts (`libs/contracts`), Temporal TS SDK workflow/activities, `GitHubAppTokenProvider`, `GitSubprocessCloner`, `GitHubApiReviewClient`.

**Greenfield note:** The TS backend has **no production replay history** (first deploy). Per the port's collapse-all-patched-gates decision, adding a required field to an activity input does **not** need a `*_v2` activity + `workflow.patched()` gate (CLAUDE.md inv. 11's breaking-input rule applies only against in-flight workflows, of which there are none).

---

## Change surface

| File | Change |
|------|--------|
| `libs/contracts/src/post_check_run_input.v1.ts` (+ the 4 sibling post/placeholder/update inputs) | add `githubInstallationId: number` (`.int().positive()`) |
| `libs/contracts/src/clone_repo_into_workspace*.v1.ts` | add `githubInstallationId: number` (if not already carried) |
| `apps/backend/src/integrations/git/cloner.ts` | move `githubInstallationId` from constructor → `clone()` param |
| `apps/backend/src/activities/{post_check_run,post_review_results,post_review_placeholder,delete_review_placeholder,update_pr_description_summary}.activity.ts` | delete `readGithubInstallationId()`; source `installationId` from `input.githubInstallationId` |
| `apps/backend/src/activities/enrich_pr_files.activity.ts` | delete vestigial `readGithubInstallationId()` call + helper |
| `apps/backend/src/activities/clone_repo_into_workspace.activity.ts` | pass `input.githubInstallationId` to `cloner.clone()` |
| `apps/backend/src/worker/build_activities.ts` | delete `readGithubInstallationId()`; `buildClonerDeps()`/`makeClonerDepsResolver()` drop the id arg; fix-prompt review client sourced from input (or per-call); drop the env requirement |
| `apps/backend/src/workflows/review_pull_request.workflow.ts` | pass `payload.github_installation_id` into the 5 post_* inputs + the clone input; preserve existing fail-open null-gating |
| `deploy/local-kind/10-backend.yaml` | remove `CODEMASTER_GITHUB_INSTALLATION_ID` from the ConfigMap |
| `docs/adr/00NN-per-review-github-installation-routing.md` | the ADR the Python deferred ("Multi-tenant routing tracked in ADR-NN") |

## Non-blocking follow-ups (flagged, NOT in this change)

- **GHES base URL.** The token provider + API clients default to `https://api.github.com`; an on-prem GHES host needs `https://<ghes-host>/api/v3` (injectable `baseUrl`). Track as `FOLLOW-UP-ghes-base-url-config` — orthogonal to routing (routing works on any base URL). Decide the smoke target (github.com test org vs GHES) before the live smoke.
- **Null `github_installation_id`.** Real GitHub-App webhooks always carry `installation.id`, so this is null only for synthetic/legacy triggers. The 5 post_* activities follow the workflow's existing fail-open structure: if the id is null we skip/degrade the post rather than mint under a wrong id (strictly more correct than the env model, which always posted under the pod's single id).

## Tasks (TDD, each its own red→green→commit)

### Task 1: Contracts — add `githubInstallationId` to the 5 post_* inputs (+ clone input)
- [ ] Red: a contract test asserts `PostCheckRunInputV1.parse({...without githubInstallationId})` throws and `{...with}` round-trips; repeat per input.
- [ ] Green: add the field (`z.number().int().positive()`).
- [ ] Commit.

### Task 2: `cloner.ts` — id per-call
- [ ] Red: a test constructs `GitSubprocessCloner({ tokenProvider })` (no id) and asserts `clone({..., githubInstallationId})` calls `tokenProvider(thatId)` (recorder stub).
- [ ] Green: move the field; keep the `>=1` guard in `clone()`.
- [ ] Commit.

### Task 3–7: each post_* + enrich + clone activity — source id from input
- [ ] Red: per activity, a test that the GitHub call mints for `input.githubInstallationId` (not env); env unset must NOT throw.
- [ ] Green: delete `readGithubInstallationId()`; use `input.githubInstallationId`.
- [ ] Commit per activity.

### Task 8: `build_activities.ts` — drop the env pin
- [ ] Red: `build_activities.test.ts` no longer requires `CODEMASTER_GITHUB_INSTALLATION_ID`; cloner deps build without an id.
- [ ] Green: remove the reader; `buildClonerDeps()` builds the cloner with the token provider only.
- [ ] Commit.

### Task 9: workflow — thread the id into the 5 dispatches + clone
- [ ] Red: a workflow-level test asserts each post_* dispatch input carries `payload.github_installation_id`.
- [ ] Green: thread it; preserve null fail-open.
- [ ] Commit.

### Task 10: deployment + ADR
- [ ] Remove the env from the ConfigMap; write the ADR; `make`-equivalent lint/typecheck green.
- [ ] Commit.
