# ADR-0073 — Per-review GitHub installation routing (retire the `CODEMASTER_GITHUB_INSTALLATION_ID` env pin)

**Status:** Accepted
**Date:** 2026-06-07
**Supersedes the deferred "ADR-NN" referenced by the frozen Python** (`vendor/codemaster-py/.../git/cloner.py`: *"Single-installation per pod … Multi-tenant routing is tracked in ADR-NN"*).

## Context

codemaster authenticates to GitHub as a **GitHub App installation**: to clone a private repo or post a
review it mints an *installation access token* (App JWT → `POST /app/installations/{id}/access_tokens`),
which requires knowing **which installation** (i.e. which org). A GitHub App has **one installation per org**,
so a deployment serving N orgs needs N installation ids — but a single shared App private key.

The frozen Python (and the initial TS port) bound **one** installation id at **worker-construction time**,
read from `CODEMASTER_GITHUB_INSTALLATION_ID`, into every GitHub-touching collaborator (cloner +
post/check-run/placeholder/delete/update/fix-prompt activities). Consequence: **one worker pod can only
serve one org.** Serving 100 orgs would require 100 worker deployments — one env value each. The Python
documented this as a v1 simplification with multi-tenant routing deferred to an unwritten ADR.

The per-PR installation id is **already available** at runtime: the GitHub webhook carries `installation.id`,
it is persisted on the review row, and the review workflow payload already carries it as the numeric
`github_installation_id` (`review_pull_request.v1.ts`). The activities simply ignored it and read the env.

## Decision

**Thread the per-PR numeric `github_installation_id` through each GitHub activity's typed input** and mint
the token for *that* installation per-invocation. The App credential (app id + private key) stays the single
per-environment secret (CLAUDE.md invariant 4 — single active GitHub host). One worker pool serves all orgs;
the `GitHubAppTokenProvider`'s existing per-installation LRU token cache (1000 entries) absorbs the fan-out.

This is a **deliberate, justified divergence** from the frozen Python (which binds at construction). It is
sound because the per-review id is already in the payload and two activities (`enrich_pr_files_v2`,
`fetch_manifest_snapshots`) already consumed it via input — the change completes a divergence the port began.

### Field convention

Every GitHub activity input carries `github_installation_id: z.number().int().gte(0).nullable().default(null)`:

- **Numeric** — the GitHub-API installation id. **Distinct** from the internal **UUID** `installation_id`
  (the tenant FK used for persistence/tenancy). These coexist in several envelopes; conflating them mints
  tokens under the wrong identity. The codebase's `installation_id_uuid` / `installation_id_int`
  dual-naming convention guards the workflow seams.
- **Nullable** — faithful to the nullable workflow-payload field. The receiving activity enforces presence
  (see Null policy); the contract does not reject null.
- **`.default(null)`** — keeps the KEY *required at construction*, so every dispatch site must thread the id
  explicitly. A forgotten dispatch fails to compile — no silent omission of the env-pin replacement.

### Null policy

- **Clone** (spine core loop, dispatched unconditionally): **fail-closed** — `CloneFailedError("missing
  github_installation_id")` on null. A silent skip would produce an empty workspace and a false-clean review.
- **Posts** (`post_review_results`, `post_check_run`, `update_pr_description_summary`): defensive throw on
  null — they run only after a successful clone, so a null id is unreachable in practice.
- **Best-effort** (`post_review_placeholder`, `delete_review_placeholder`, fix-prompt comment): skip the post
  on null (swallowed by the existing not-configured / advisory try-catch) — non-fatal.

### Parity-test re-scoping

Four input contracts (clone, placeholder, delete, generate_fix_prompt) are byte-validated against the frozen
Python via a live oracle. The TS-only `github_installation_id` would break the diff. Resolution: the parity
tests now **strip `github_installation_id` from the canonical diff** so all SHARED fields stay byte-identical
to the oracle, plus a dedicated round-trip assertion for the new field. **The frozen Python is NOT modified**
— the divergence is intentional and lives only on the TS side.

## Consequences

- One worker pool serves all orgs; no per-org deployment. `CODEMASTER_GITHUB_INSTALLATION_ID` is removed from
  the worker composition root and must not be set in any deployment ConfigMap.
- Greenfield (no production replay history) → no `*_v2` activity + `workflow.patched()` ceremony was needed
  for the additive input-field change (CLAUDE.md invariant 11's breaking-shape rule applies only against
  in-flight workflows, of which there are none pre-first-deploy).
- **Provenance is chunk/installation-granularity** — the cited id vouches which installation the token was
  minted for, not a finer scope.

## Follow-up (NOT in this change)

- **`FOLLOW-UP-ghes-base-url-config`** — the token provider + API clients default to `https://api.github.com`.
  An on-prem GitHub Enterprise Server host needs `https://<ghes-host>/api/v3` (injectable `baseUrl`).
  Orthogonal to routing (routing works on any base URL); decide the smoke target (github.com test org vs
  GHES) before the live smoke.

## References

- Plan: `docs/superpowers/plans/2026-06-07-per-review-installation-routing.md`
- Commits: contracts+threading, cloner, activity swaps, fix-prompt seam + env-pin removal, doc cleanup.
