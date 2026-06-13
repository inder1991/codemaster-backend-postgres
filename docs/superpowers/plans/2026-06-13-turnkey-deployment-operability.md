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

## REVISED go-live provisioning model (owner-aligned 2026-06-13)

The conversation refined the model. The operating principle is now a hard **two-tier** split:

> **You provision exactly TWO things — the DB credentials and the field-encryption key — each from
> EITHER an OpenShift Secret OR a Vault path (your choice). Everything else (LLM, GitHub, Confluence,
> superadmin changes) is set later through the UI, stored in Postgres encrypted by that key, and
> NEVER blocks the pod from coming up.**

Settled decisions:
1. **Boot-blocking tier = {DB creds, field-encryption key}** only (+ Vault reachability *iff* those come
   from Vault). GitHub/LLM/Confluence are **non-blocking** — the pod boots + the UI is reachable
   without them; absence degrades only *that feature*. (This INVERTS the first preflight cut, which
   made GitHub required — those move to non-blocking.)
2. **Source selector:** one env switch `CODEMASTER_SECRET_SOURCE = openshift | vault` (default
   `openshift`), with optional per-secret overrides (`CODEMASTER_PG_SECRET_SOURCE`,
   `CODEMASTER_FIELD_KEY_SOURCE`). The app reads ONLY the selected source; clear errors name it.
   `openshift` = env from a Secret (full `CODEMASTER_PG_CORE_DSN`, or `PG_USER`+`PG_PASSWORD` + host/
   port/db from the ConfigMap); `vault` = SA login → read the KV path.
3. **Vault auth = OpenShift service account (Kubernetes auth):** read the pod SA JWT →
   `auth/kubernetes/login {role, jwt}` → token → KV reads; renew on expiry. New
   `CODEMASTER_VAULT_AUTH = kubernetes | token | agent-file` (keeps existing modes). The SA→role→
   policy→path binding is Vault-admin setup (runbook).
4. **Bootstrap secrets are READ-ONLY** — the app never copies the key/DB creds into Vault or Postgres
   (key-next-to-ciphertext anti-pattern; DB creds are circular). One source of truth; re-provisioning
   to a different source is an explicit operator action (copy + flip the switch).
5. **UI config → Postgres, encrypted by the field-encryption KEY (not Vault Transit).** Switch
   `core.llm_provider_settings` (+ any other Vault-Transit'd config) from Transit to the field codec,
   so UI-config of secrets works WITH OR WITHOUT Vault. Precedence at use-time: DB (UI) > env
   (ConfigMap/Secret) > Vault > disabled. Effective immediately, survives restarts/scaling.
6. **Superadmin bootstrap:** on first boot, if no superadmin exists, seed `admin` / `admin` (argon2-
   hashed), changeable via UI. Idempotent (never resets on upgrade). [OPEN: force-change-on-first-
   login vs loud-warning-only — defaulting to a loud warning per "changeable afterwards".]
7. **Fuse all 17 migrations → one `0001_baseline.sql`** (greenfield confirmed — no existing
   deployment). Verify the fused schema == running all 17. `EXPECTED_MIGRATIONS = ["0001_baseline"]`.
8. **Keyset = provisioned (Option A)**, never auto-generated (auto-gen + non-persist = data loss on
   restart; a constant default = shared-key breach). It lives in the Secret/Vault you control; the app
   reads it at every boot, holds it in memory only, never persists it.

Most machinery EXISTS: users + `super_admin` role + `local_user_repo`; DB-stored config tables
(`llm_provider_settings`/`platform_config`/`global_config`/`org_configs`/`repo_configs`); the field
codec (`boot_field_keys`/`audit_field_codec`/`email_codec`); a Vault HTTP client. The work is
RE-TIERING + adding source-adapters (two-source creds, K8s-auth) + the encryption switch + superadmin
seed + migration fusion — not a rewrite. The deploy_preflight already built must be re-tiered (drop
GitHub/LLM from blocking; keep DB + keyset).

REVISED build sequence (each TDD): (1) source-resolver + `CODEMASTER_SECRET_SOURCE` (DB creds two-
source) → (2) Vault K8s-auth client → (3) re-tier deploy_preflight to {DB, keyset} blocking; the rest
to a non-blocking `/config-status` → (4) UI-config encryption switch (Transit → field codec) → (5)
superadmin bootstrap → (6) fuse migrations → (7) chart wiring (Secret + Vault SA modes, the switch) +
runbook update.

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
- **Secret seeding — BOTH paths** (owner decision 2026-06-13): (a) a **one-shot seeding helper**
  (a script / optional Helm Job) that writes the entire expected Vault tree from the contract in one
  command, for turnkey setup; AND (b) **manual documentation** of every path/key so a security-managed
  Vault can be seeded by hand. The helper is generated FROM the contract so the two never drift.
- **Boot-time preflight** (generalize `schema_preflight.ts` + the eager-key load): before `/readyz`,
  validate (a) every required secret present + well-formed, (b) DB extensions/schemas present,
  (c) required config set + coherent (e.g. embeddings dim = 1024, cost cap present). On failure: exit
  fail-loud naming the **exact** path/key/extension + the one-line fix. A `--check`/dry-run entrypoint
  so it can run as a `helm test` or a pre-deploy gate without serving traffic.
- **`helm template … | the expected Vault tree`** so the operator seeds everything in one pass.

*Acceptance:* a misconfigured deploy prints a single actionable list of what's missing; a correct one
passes preflight and serves. No reverse-engineering required.

### Phase 2 — Postgres prerequisites made easy
**Target: self-managed Postgres only** (owner decision 2026-06-13). We assume the operator controls
the instance, so `pg_partman` is installable — NO RDS/CloudSQL alternative design is needed. This
keeps Phase 2 docs-and-preflight, not a partitioning redesign.

- Promote `CODEMASTER_PG_MAINT_DSN` to a **first-class** value (uncommented, documented, schema'd).
- **DB preflight** (part of Phase 1's validator): assert `pg_partman` + `vector` extensions and the
  `core/audit/cache/telemetry/partman` schemas exist; if not, emit the exact `CREATE EXTENSION` SQL +
  who must run it.
- **DB-prereq runbook**: PG version, the two extensions + how to install them on a self-managed
  instance, the migration-vs-runtime privilege split, connection-pool sizing (HTTP + 3 loops ×
  replicas), and the **PgBouncer transaction-mode caveat** (advisory locks).

*Acceptance:* an engineer knows before installing exactly what to provision on their self-managed
Postgres; the migrate hook never fails on a missing extension without a clear remediation.

### Phase 3 — Guided onboarding runbook + minimized overrides
- **`REQUIRED OVERRIDES` checklist** (NOTES.txt + runbook): the short list the engineer MUST set
  (image, DB DSNs, vault.addr, the secrets) — everything else defaulted.
- **GitHub-App setup runbook**: exact permissions + `pull_request` events + the webhook URL
  (`https://<ingress>/…`) + the Vault paths to seed; plus a post-deploy self-check that verifies the
  App credentials + webhook reachability.
- **LLM/embeddings contract**: creds, region, model IDs, and the 1024-dim embeddings coupling.
- **Cost cap** (owner decision 2026-06-13): the defaults are already correct — **$5,000/day global**
  (`DEFAULT_GLOBAL_CAP_CENTS = 500_000`) + **$1,000/day per-org** (`DEFAULT_PER_ORG_CAP_CENTS =
  100_000`), overridable via DB. No value change; the turnkey work is to **surface both in the deploy
  contract + chart** (visible + tunable without code) and document the per-org override path. The cap
  is fail-CLOSED at the limit (raises `BedrockBudgetExceededError`) with a sane default, so there is
  no "unset" hazard to preflight — just confirm the values are shown to the operator.
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

## Resolved decisions (2026-06-13)

- **Postgres target:** **self-managed only** — `pg_partman` is installable, no managed-DB alternative
  needed. Phase 2 is docs + preflight, not a partitioning redesign.
- **Secret seeding:** **both** — ship a one-shot seeding helper AND document the manual path; generate
  the helper from the contract so they never drift.
- **Cost-cap default:** keep **$5,000/day global + $1,000/day per-org** (already the compiled
  defaults); fail-closed at the limit. Work = surface + document, not change.
