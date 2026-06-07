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
