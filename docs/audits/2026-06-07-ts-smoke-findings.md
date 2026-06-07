# TS backend — first live PR→review smoke findings (2026-06-07)

First end-to-end smoke of the TypeScript backend (single-pod combined deploy, kind, real GitHub App
`codemaster-dev-1` / installation `138629103` on `inder1991/inventory-service`, AnthropicDirect LLM).
Captured here so the manual workarounds used to get the smoke moving are tracked as **proper follow-ups**,
not silently normalized.

## F-1 (PROPER FIX OWED) — auto-registration journey is not wired (the bootstrap gap)

**Symptom:** a verified `pull_request` webhook for `inventory-service` logged
`webhook.pr_repo_unresolved_drift` and started **no review** — the backend had no `core.installations`
row for `138629103` and no `core.repositories` row for the repo (only a `__platform_sentinel__` install).

**Root cause:** the installation/repo **auto-registration journey is deferred/stubbed** in the TS port.
`apps/backend/src/ingest/github_webhook_persistence.ts` carries explicit STUBs for "the repair-drift
dispatcher (Stage 2)" + "the reconcile/sync emitters (Stage 4)". The Python
(`codemaster/ingest/github_webhook_persistence.py`) has the full handlers — `_maybe_emit_installation_reconcile`,
the `installation_repositories` (added/removed) → `reconcile_repositories` workflow route (ADR-0054 / CLAUDE.md
invariant 16), and the `pull_request`-drift → `RepairInstallationRepositoriesWorkflow` hydrate path.

**Tactical workaround used for the smoke (REMOVE once F-1 lands):** hand-seeded `core.installations`
(`138629103`/`inder1991`) + `core.repositories` (`inventory-service`, enabled) via SQL.

**Proper fix:** port the deferred work — DEFERRED tasks **S2 (repair dispatcher)** + **S4 (reconcile/sync
emitters)** + the `installation`/`installation_repositories` webhook handlers, so installing the App (or
adding a repo) auto-registers the installation + repos via `upsertRepository` / `reconcileRepositoriesActivity`
/ `hydrateInstallationRepositoriesActivity` (ADR-0054 mutation paths). No manual seeding.

## F-2 (DESIGN DECISION OWED) — default-enable vs CLAUDE.md invariant 10

The platform owner wants **`repositories.enabled = true` by DEFAULT** on registration ("install the App ⇒
the repo is reviewed"), matching CodeRabbit-style behavior. The current design ships the **opposite**:
CLAUDE.md **invariant 10** = *"Default deny everywhere — repos disabled"* (staged rollout across ~3,000
repos). Changing the default to enabled-on-install is a deliberate **amendment to invariant 10** → needs an
ADR. Fold into F-1's registration path (set `enabled = true` at auto-registration).

## Ancillary setup that was manual (lower priority — config, not gaps)

- **Embedder DSN:** the worker fail-louds without `CODEMASTER_QWEN_DSN`; set `stub://recording` (dev
  sentinel) in the ConfigMap. By design (ADR-0059), not a gap.
- **LLM provider row:** `core.llm_provider_settings` was empty; seeded the AnthropicDirect/`primary` row
  (Vault-Transit-encrypted). In prod the admin UI/API writes this — fine for a smoke.
- **Pod resource requests:** lowered to fit the memory-tight shared kind node.

## What the smoke DID prove (green so far)

Single combined pod (API + review worker + outbox dispatcher, fail-loud) healthy; Vault-backed secrets; the
**real GitHub webhook verified end-to-end** (App → smee → backend `/v1/github/webhook` → `204`, signature
valid) — i.e. the per-review-routing + webhook-ingestion + secret plumbing all compose. The review itself is
the next thing to observe once F-1's repo is resolvable (seeded for now).

---

## Second pass (2026-06-07 PM) — FULL review posted on PR #131 + degradation audit

The spine now runs **end-to-end**: webhook → S3 PR-metadata persist → clone → classify → chunk → **LLM
review** → aggregate → **post** (review comment + 2 inline findings, incl. the seeded SQL-injection blocker
with a policy citation). Bugs found + FIXED on the way: git missing from the image; the camelCase→snake
dispatch-contract drift; placeholder default-off; the S3 `pull_requests`/`gh_users`/`pr_state_transitions`
writer; and the `anthropic_direct` provider gap (the cache ignored `provider` and always built Bedrock).

A 3-agent degradation audit of run `019ea2ac-…` then surfaced these:

### F-4 (FIXED) — deterministic static-analysis layer absent from the image
`ruff` + `gitleaks` binaries were not installed (only `git`); `eslint` was a devDependency stripped by
`npm ci --omit=dev`; and the bundled configs (`ruff.toml`, `eslint.config.mjs`) were never copied into
`dist`. Net: every review degraded to LLM-only with `failed_startup` on the deterministic linters.
**Fix:** Dockerfile now installs `ruff`/`gitleaks` release binaries + global `eslint` (1:1 with the frozen
Python image), and `scripts/build_copy_static_analysis_configs.mjs` copies the configs into `dist`.

### F-5 (FIXED, code) / OWED (config) — check-run 403 + App permissions
`post_check_run` 403'd (`Resource not accessible by integration`) — the dev App lacks `checks:write` — and
retried a *permanent* permission error 3×. **Fix (code):** `GitHubForbiddenError` added to
`postCheckRun.nonRetryableErrorTypes` (fail fast; the check-run is advisory per invariant 9). **Owed
(config, operator):** the dev App `codemaster-dev-1` is missing `checks:write` (+ diverges on `contents:read`
/ `issues:write`); grant per the new `deploy/github/app-manifest.yaml`. The review body + inline comments
post fine without it.

### F-6 (FIXED) — fix-prompt theme-synthesis failures were silent
The `deterministic_fallback` path swallowed LLM/infra errors silently (the frozen Python warns). **Fix:** a
structured WARN (`fix_prompt.theme_synthesis_failed`) so an error-driven fallback is distinguishable from a
no-themes-returned one. (The original fallback was itself a symptom of the now-fixed `anthropic_direct` gap.)

### F-7 (DEFERRED, tracked) — `core.retrieval_traces` has no writer
No `persist_retrieval_trace` activity was ported; the admin retrieval inspector has no data. This is a
**large** port (HybridRetriever trace instrumentation) and the retrieval returns empty anyway in this env
(0 `knowledge_chunks` / `confluence_chunks`, stub embedder), so it stays **Pattern-A deferred** (table
exists, no writer; consumer = the also-deferred admin inspector). Tracked: `persist RetrievalTraceV2`.

### Confirmed by-design / NOT bugs (no action)
Confluence/knowledge retrieval empty (0 corpus + stub embedder); `delivery_outcome`/lifecycle columns NULL
(`CODEMASTER_LIFECYCLE_WRITES_ENABLED` dormant-ship default, 1:1 Python); `pr_files.language` NULL (faithful
port); `cross-installation … Phase B` WARN (informational); `eslint skipped 0/0` (correct on a Python PR);
`topic:security` visibility drop (intended default-deny).

### Caveat — what #131 did NOT validate
#131 was a *minimal* ad-hoc PR. It proved the spine but **not** the policy-engine config *features*,
`knowledge.file_patterns` retrieval, or Confluence retrieval — those need the **seeded-fixture PR** the
`.codemaster.yaml` is written against, plus a seeded Confluence corpus + a real embedder.
