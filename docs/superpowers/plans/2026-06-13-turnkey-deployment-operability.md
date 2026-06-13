# Turnkey Deployment & Configuration — first-deploy operability plan

**Date:** 2026-06-13
**Author:** platform engineering
**Status:** PROPOSED (planning only — no implementation started)

## North star

**Any engineer — not just a codemaster expert — can go from zero to a working PR review by
filling in a handful of values, and the system validates itself and tells them exactly what is
wrong and how to fix it.**

Today a `helm install` can *succeed* (pod goes Ready) while the system cannot function — the
classic **"green pod, dead product."** The operator discovers each missing prerequisite one
fail-loud boot (or one silent no-op) at a time, by reverse-engineering the code. This plan converts
that into: *one preflight + one runbook + strong defaults = a deploy that either works or tells you
precisely why not.*

## Design principles

1. **Minimize required inputs.** Every value that *can* have a safe default *has* one. The engineer
   overrides a small, explicit "REQUIRED" set (image, DB connection, the secrets) and nothing else.
2. **Single source of truth for config + secrets.** One declarative contract — no reverse-engineering
   from crash messages.
3. **Fail loud, early, and *actionable*.** Preflight runs before `/readyz` and names the exact
   missing thing + the exact fix (Vault path + key, extension name + SQL, the value to set).
4. **Safe by default.** First deploy lands in **shadow mode** (observe-only, no side effects); the
   engineer watches it run, then flips one value to go live.
5. **Guided, copy-pasteable.** The runbook hands them commands, not concepts.

## Scope

**In scope:** the secrets/config/DB deploy contract + boot preflight; DB prerequisites; GitHub-App
onboarding; LLM/embeddings config; required-overrides minimization; run-model operability; shadow-first;
the quickstart runbook; sharp-edge fixes.

**Out of scope (explicitly deferred):** dashboards, alerts, metrics/telemetry, OTel — per owner steer.
Day-2 alerting is a separate effort and is NOT part of turnkey first-deploy.

## What already exists (build on it, don't rebuild)

- A real Helm chart with `vault.mode` ∈ {agent, token, external}, `agent.envSecrets`/`fileSecrets`
  wiring, ConfigMap, PDB, probes, the migrate Job as a pre-install/pre-upgrade hook.
- A **fail-loud schema-revision preflight** (`schema_preflight.ts`) — the pattern to generalize.
- **Eager field-encryption-key load at boot** — another fail-loud-before-serving precedent.
- **Partial** `NOTES.txt` pre-flight warnings (embeddings, vault.mode, vault.addr).
- `values.schema.json` validates value *shapes* at install time.
- **Shadow mode** (`CODEMASTER_RUNTIME_MODE=shadow`) already exists — it just isn't surfaced as the
  recommended first step.

## The gaps (grounded in the code)

| # | Gap | Evidence | First-deploy impact |
|---|-----|----------|---------------------|
| 1 | **Secrets contract implicit + scattered** | App reads 6+ Vault paths (`codemaster/api/auth`, `codemaster/github/app` → `app_id`+`private_key`+`webhook_secret`, `codemaster/embedder/qwen`, `codemaster/confluence/token`, `codemaster/review`) + the field-encryption keyset, split across `envSecrets` AND `fileSecrets`. No authoritative manifest. | Engineer wires Vault by trial-and-error against boot crashes. |
| 2 | **Postgres prereqs hard + managed-DB-hostile** | Baseline needs `CREATE EXTENSION pg_partman` (in a `partman` schema) + `vector` (`public.vector(1024)`), 5 schemas, `gen_random_uuid`. A second DSN `CODEMASTER_PG_MAINT_DSN` is **commented out** in `values.yaml`. | `pg_partman` is absent on stock RDS/CloudSQL → migrate-hook fails mid-install. Unwired maint DSN → partition maintenance silently dies (Day-2 bloat). |
| 3 | **GitHub-App onboarding undocumented** | App reviews via a GitHub App (`app_id`/`private_key`/`webhook_secret`, webhook → ingress). None in the chart's domain. | Pod Ready, reviews nothing. The true "dead product" trap. |
| 4 | **LLM/embeddings contract invisible** | Anthropic/Bedrock creds + cost cap; embeddings must emit **1024-dim** to match pgvector. | Reviews fail or silently degrade; cost-cap fail-open/closed behavior unknown. |
| 5 | **Required overrides are failing placeholders** | `image.repository` = `nexus.acme.com/...`; `vault.addr` empty. | ImagePullBackOff / crashloop with no checklist. |
| 6 | **Run-model operability unstated** | One pod = HTTP + runner + scheduler + outbox; replicas coordinate via DB lease+fence. Memory floor: magika TFJS 624MB + tree-sitter + LLM buffers vs 1536MB old-space / 2Gi limit. | Under-provision → OOM; uncertainty about double-firing crons / scaling. |
| 7 | **Sharp edges** | `NOTES.txt` still says "Temporal review worker" (stale); migrate cold-only guards refuse on populated tables; shadow-first not surfaced. | Confusing signals during first deploy. |

## The plan — phased

### Phase 1 — The Deploy Contract + Preflight (the anchor)
The single highest-leverage change: a declarative contract + a boot-time validator.

- **Deploy contract doc** (`docs/runbooks/deploy-contract.md`): every secret (Vault path, keys,
  format, required/optional, feature it gates), every required config value, every DB prereq — one
  table, the source of truth.
- **`vault.basePath` value** that *derives* the standard paths (override one prefix, not ten entries);
  keep explicit overrides possible.
- **Boot-time preflight** (generalize `schema_preflight.ts` + the eager-key load): before `/readyz`,
  validate (a) every required secret present + well-formed, (b) DB extensions/schemas present,
  (c) required config set + coherent (e.g. embeddings dim = 1024, cost cap present). On failure: exit
  fail-loud naming the **exact** path/key/extension + the one-line fix. A `--check`/dry-run entrypoint
  so it can run as a `helm test` or a pre-deploy gate without serving traffic.
- **`helm template … | the expected Vault tree`** so the operator seeds everything in one pass.

*Acceptance:* a misconfigured deploy prints a single actionable list of what's missing; a correct one
passes preflight and serves. No reverse-engineering required.

### Phase 2 — Postgres prerequisites made easy
- Promote `CODEMASTER_PG_MAINT_DSN` to a **first-class** value (uncommented, documented, schema'd).
- **DB preflight** (part of Phase 1's validator): assert `pg_partman` + `vector` extensions and the
  `core/audit/cache/telemetry/partman` schemas exist; if not, emit the exact `CREATE EXTENSION` SQL +
  who must run it.
- **DB-prereq runbook**: PG version, extensions + the managed-DB story (RDS/CloudSQL: pg_partman
  availability + alternatives), the migration-vs-runtime privilege split, connection-pool sizing
  (HTTP + 3 loops × replicas), and the **PgBouncer transaction-mode caveat** (advisory locks).

*Acceptance:* an engineer on RDS/CloudSQL knows before installing whether their DB will work and what
to provision; the migrate hook never fails on a missing extension without a clear remediation.

### Phase 3 — Guided onboarding runbook + minimized overrides
- **`REQUIRED OVERRIDES` checklist** (NOTES.txt + runbook): the short list the engineer MUST set
  (image, DB DSNs, vault.addr, the secrets) — everything else defaulted.
- **GitHub-App setup runbook**: exact permissions + `pull_request` events + the webhook URL
  (`https://<ingress>/…`) + the Vault paths to seed; plus a post-deploy self-check that verifies the
  App credentials + webhook reachability.
- **LLM/embeddings contract**: creds, region, model IDs, the cost-cap default behavior, the 1024-dim
  coupling.
- **Shadow-first guidance**: documented as the recommended first deploy; flip `runtime.mode` to go live.

*Acceptance:* a new engineer follows the runbook top-to-bottom and reaches a posted review without
tribal knowledge.

### Phase 4 — Sharp-edge fixes + the 5-minute quickstart
- Fix the stale `NOTES.txt` "Temporal review worker" line (→ "Postgres background runtime").
- Document the migrate cold-only-guard behavior (refuses on populated tables).
- A **quickstart**: minimal `values-quickstart.yaml` + a copy-paste sequence (seed Vault → install →
  shadow → verify → go live).

*Acceptance:* the quickstart, followed verbatim, yields a working shadow deploy.

## Definition of done (the turnkey bar)

- An engineer with **no codemaster knowledge**, given the runbook, goes **zero → a posted review** by
  setting only the REQUIRED-overrides list.
- **Every** misconfiguration (missing secret, missing extension, wrong dim, unset cap, placeholder
  image) is caught by preflight **before** serving, each with a one-line fix.
- First deploy is **safe** (shadow) by default.
- The deploy contract is the **single source of truth** — no code-reading to find a required value.

## Open questions for the owner

- **pg_partman on managed PG:** do we target self-managed/containerized Postgres (pg_partman
  available) or must we support stock RDS/CloudSQL? If the latter, partition maintenance needs an
  alternative — a real design decision, not just docs.
- **Secret seeding:** ship a helper (script/Job) that seeds the Vault tree from the contract, or
  document-only?
- **Cost-cap default:** fail-open or fail-closed when unset — confirm intended behavior before we
  preflight it.
