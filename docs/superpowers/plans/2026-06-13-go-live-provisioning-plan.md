# codemaster-backend — go-live provisioning: complete implementation plan

**Date:** 2026-06-13 · **Status:** APPROVED design, ready to build · **Build on:** Opus, strict TDD,
branch `feat/deploy-contract-preflight` (off `docs/turnkey-deploy-plan`).
Companion: `2026-06-13-turnkey-deployment-operability.md` (the gap assessment + the existing preflight engine this re-tiers).

## Goal & operating model

**Deploy backend + frontend and have them come up with zero trouble.** The hard rule:

> **You provision exactly TWO things — the Postgres credentials and the field-encryption key —
> each from EITHER an OpenShift Secret OR a Vault path. Everything else (LLM, GitHub, Confluence,
> the superadmin's later changes) is configured through the UI, stored in Postgres encrypted by that
> key, and NEVER blocks the pod from starting or being reachable.**

## Settled decisions (owner-aligned, do not relitigate)

1. **Boot-blocking tier = {DB creds, field-encryption key}** only (+ Vault reachability *iff* those
   come from Vault). GitHub / LLM / Confluence are **non-blocking**.
2. **Source switch:** `CODEMASTER_SECRET_SOURCE = openshift | vault` (default `openshift`); optional
   per-secret overrides `CODEMASTER_PG_SECRET_SOURCE` / `CODEMASTER_FIELD_KEY_SOURCE`. Read ONLY the
   selected source — no fallback; errors name it.
3. **Vault auth = OpenShift service-account (Kubernetes auth).**
4. **Bootstrap secrets are read-only** — never copied into Vault/Postgres.
5. **UI config → Postgres, encrypted by the field key** (switch off Vault Transit).
6. **Superadmin `admin` / `admin`** on first boot, UI-changeable, **loud warning only** (no forced change).
7. **Fuse 17 migrations → one `0001_baseline.sql`** (greenfield confirmed).
8. **Key is provisioned, never auto-generated.**

## Current state (what exists / what gets re-tiered)

EXISTS: users + `super_admin` role + `local_user_repo`; config tables (`core.llm_provider_settings`,
`platform_config`, `global_config`, `org_configs`, `repo_configs`, `config_revisions`); the field
codec (`security/boot_field_keys.ts`, `audit_field_codec.ts`, `api/auth/email_codec.ts`,
`field_encryption_keys_loader.ts`); a Vault HTTP client (`adapters/vault_http.ts`, token-based);
`getPool` + `CODEMASTER_PG_CORE_DSN` read in several places.

ALREADY BUILT (this branch) — **gets re-tiered, not discarded:** `deploy_preflight.ts` (pure evaluator
+ contract + observer + `assertDeployReady`), `deploy_preflight_io.ts`, `deploy_check.ts` +
`npm run deploy:check`, `gen_deploy_artifacts.ts` (doc + seeder + drift test), the helm test, the
first-deploy runbook. Step 3 below re-tiers the contract (drop GitHub/LLM from blocking).

GAPS to build: two-source DB creds, Vault K8s-auth, the re-tier, the UI-config encryption switch,
superadmin bootstrap, migration fusion, chart wiring.

---

## The build — 7 steps (each: objective · files · tests · edge cases · acceptance)

### Step 1 — Source resolver + two-source DB credentials
**Objective:** one switch decides where DB creds come from; resolve a DSN from OpenShift env or Vault.
- **New `config/secret_source.ts`:** `resolveSecretSource(env, overrideKey?) → "openshift"|"vault"` (pure; default openshift; override wins; invalid throws naming the set).
- **New `config/db_credentials.ts`:** `assembleDsn({user,password,host,port,database}) → string` (pure; URL-encodes user/password); `resolveDbDsn(deps) → Promise<string>` — openshift: `CODEMASTER_PG_CORE_DSN` else assemble from `PG_USER`/`PG_PASSWORD` + host/port/db (ConfigMap); vault: SA-read the KV path → `dsn` or `username`+`password` → assemble. Fail loud naming the chosen source + the missing field.
- **Wire:** a single resolution at boot (main.ts) + the runner; the result feeds `getPool`. **Migrate edge:** node-pg-migrate reads `-d CODEMASTER_PG_CORE_DSN` from env — in vault-mode add a tiny `resolve_dsn.ts` (prints the resolved DSN) the migrate Job sources before `migrate:up`.
- **Tests:** resolveSecretSource (default/global/override/invalid); assembleDsn (parts→DSN, special-char encode); resolveDbDsn (openshift full DSN; openshift parts; vault dsn; vault username+password; missing → throws naming source).
- **Edge cases:** both sources populated → selector decides; password with `@`/`/`/`:` → encoded; incomplete parts → names missing field; vault path lacks keys → names them.
- **Acceptance:** DSN resolves identically from a Secret or a Vault path; wrong/missing config → one clear message.

### Step 2 — Vault Kubernetes-auth client (service-account login)
**Objective:** in vault-mode the app authenticates to Vault with its OpenShift SA, no static token.
- **New `adapters/vault_k8s_auth.ts`:** read SA JWT (`CODEMASTER_VAULT_SA_TOKEN_PATH`, default `/var/run/secrets/kubernetes.io/serviceaccount/token`) → `POST {auth path}/login {role, jwt}` → `{client_token, lease_duration}`; cache the token; renew/re-login before expiry and on 403. New env: `CODEMASTER_VAULT_AUTH = kubernetes|token|agent-file`, `CODEMASTER_VAULT_K8S_ROLE`, `CODEMASTER_VAULT_K8S_AUTH_PATH` (default `auth/kubernetes`).
- **Integrate** with `vault_http.ts` so KV reads (DB creds + keyset) use the SA token in kubernetes mode; keep token + agent-file modes.
- **Tests (inject HTTP client + token-file reader):** login request shape (role+jwt); token cached + reused; re-login on expiry/403; missing SA token file → clear error; non-200 login → clear error naming role.
- **Edge cases:** Vault sealed/unreachable (clear error; blocks boot only if DB/key are vault-sourced); SA not bound to role → 403 "SA not authorized for role X"; token TTL renewal; auth-path/role typo.
- **Acceptance:** with the SA bound to a Vault role granting read on the paths, the app reads DB creds + key via SA login; misbinding → one clear error.

### Step 3 — Re-tier the deploy preflight (the inversion)
**Objective:** only DB + key block boot; GitHub/LLM/Confluence become non-blocking + observable.
- **Re-tier `DEPLOY_CONTRACT`:** blocking = DB reachable (connect with the resolved DSN) + field key present/wellformed + schema + extensions (+ Vault reachable iff vault-sourced). Move github/llm/confluence/api-auth out of blocking into an **advisory** set.
- **New `/config-status`** (read-only API): reports each non-blocking config's state (configured via DB/env/vault, or pending) for the UI/operator. NOT wired into `/readyz` (pod is ready without them).
- **`assertDeployReady`** checks only the blocking tier; `deploy:check` + the helm test follow.
- **Tests:** blocking tier fails only on DB/key/schema/extension; `/readyz` green with github/llm unset; `/config-status` reports pending items; DB-unreachable (not just missing creds) blocks with a connect error.
- **Edge cases:** creds present but DB down → block (connect error, not "missing"); key malformed → block; github unset → pod up + config-status "github: pending".
- **Acceptance:** a pod with only DB+key provisioned reaches `/readyz` green; `/config-status` lists what still needs UI config.

### Step 4 — Feature-config surfaces: LLM + GitHub + Confluence (UI-editable, field-codec, 3-source)
**Objective:** all three feature configs are UI-editable, stored in Postgres encrypted by the field
key, resolved **DB > env > Vault > disabled**, and never block boot. **[Decision R7 = (a): GitHub +
Confluence get DB-config surfaces NOW, modeled on the LLM repo.]**
- **LLM:** switch `llm_provider_settings_repo.ts` `api_key_ciphertext` from Vault Transit → field codec
  (the only Transit user — R7). Greenfield → no existing ciphertext to migrate.
- **GitHub:** new `core.github_app_settings` (`app_id` plain; `private_key_pem`, `webhook_secret` as
  field-codec ciphertext) + `github_app_settings_repo.ts` + `GET/PUT /api/admin/github-config`
  (super_admin). The GitHub client resolves creds **DB > env (`CODEMASTER_GITHUB_*`) > Vault file
  (`codemaster/github/app`) > disabled**, lazily at use-time.
- **Confluence:** new `core.confluence_settings` (`base_url` plain; `token`, `email` field-codec) +
  repo + `GET/PUT /api/admin/confluence-config` + the same 3-source resolution (Vault source = the
  existing `codemaster/confluence/token`).
- **Shared resolver** `resolveFeatureConfig(key, {db, env, vault})` → `{value, source}`, used by all
  three and surfaced by `/config-status` (R2).
- New tables ship as dev migrations, then **fold into the fused baseline at Step 6**.
- **Tests:** each repo round-trips via field codec with Vault OFF; resolver precedence (DB > env >
  Vault > disabled, deterministic when a key is in two sources); admin APIs require super_admin + never
  echo secrets; the github/confluence clients consume the resolved creds; zero Vault-Transit calls.
- **Edge cases:** key rotation (versioned); undecryptable ciphertext → clear error, no crash; partial
  config (github `app_id` set but key missing) → reported `invalid`, not a crash.
- **Acceptance:** with Vault OFF, set LLM + GitHub + Confluence via the admin APIs → persisted
  encrypted, decrypted on read, a review uses them; `/config-status` shows all three configured.

### Step 5 — Superadmin bootstrap
**Objective:** first boot seeds `admin`/`admin`; idempotent; loud warning; UI-changeable.
- **New `security/superadmin_bootstrap.ts`:** at boot (after DB + keyset ready), if no `super_admin` user exists, create one — username/password from `config.superadmin.*` (default `admin`/`admin`), argon2-hashed, email keyset-encrypted, role `super_admin`. Emit a **loud warning** (log + surfaced) whenever the password is still the default.
- **Idempotent** via `INSERT … ON CONFLICT (username) DO NOTHING` (handles the multi-replica race).
- **Tests:** seeds when absent; does NOT reset an existing admin (upgrade); password argon2-verifies; concurrent double-seed → one row; default-password → warning emitted.
- **Edge cases:** two replicas boot together (ON CONFLICT); admin already changed creds (never reset); email-encode needs the keyset (ordering: after keyset load).
- **Acceptance:** fresh DB → `admin`/`admin` logs in; upgrade with changed creds → unchanged; default unchanged → warning visible.

### Step 6 — Fuse all migrations → one baseline
**Objective:** a single `0001_baseline.sql` for first go-live. Runs LAST, so it folds in the Step-4
feature-config tables (`github_app_settings`, `confluence_settings`) too.
- **Procedure:** fresh DB → run ALL migrations (the 17 + the Step-4 dev migrations) → `pg_dump
  --schema-only --no-owner --no-privileges` + the `0002_seed` data → assemble one idempotent
  `migrations/0001_baseline.sql` (extensions, schemas, partman config, seed, the new config tables).
  Archive the prior migrations to `migrations/_archive/` until go-live passes (R3).
- **Pin:** `EXPECTED_MIGRATIONS = ["0001_baseline"]`; update the schema_preflight test + the migrations-dir pin test.
- **VERIFY (critical, R3):** normalized + semantic schema diff of {fresh + fused baseline} vs {fresh +
  all prior migrations} → must be empty (extensions/schemas/tables/indexes/constraints/functions/
  grants/seed-rows/journal). A throwaway verify script gates this.
- **Edge cases:** extensions in the baseline (`CREATE EXTENSION`); partman parent/retention config;
  seed rows (roles); node-pg-migrate journal = 1 entry; cold-only guards moot.
- **Acceptance:** fresh DB migrates with one file; schema semantically identical to running all prior
  migrations; `deploy:check`/preflight pass.

### Step 7 — Helm chart wiring + runbook + regenerate artifacts
**Objective:** the chart exposes the two-secret model + both sources + the SA→Vault path; docs match.
- **values.yaml / configmap / deployment:** `CODEMASTER_SECRET_SOURCE`; openshift mode (DSN or PG_USER/PASSWORD from a Secret + host/port/db in ConfigMap; key from a Secret); vault mode (`CODEMASTER_VAULT_AUTH=kubernetes`, role, auth path, SA token mount); `config.superadmin.username/password` (defaults admin/admin); serviceAccount wired for Vault K8s-auth.
- **Re-tier the deploy-check helm test** (DB+key only) + regenerate `deploy-contract.md` + `seed-vault.sh` from the re-tiered contract.
- **NOTES.txt:** the superadmin warning ("logs in as admin/admin — change it in the UI"), the two-secret model.
- **first-deploy.md:** rewrite for the model — provision 2 secrets (pick source), SA→Vault role setup, install (no shadow needed for "up"; still document shadow for safe first-run), log in as admin/admin, configure LLM/GitHub via UI.
- **Acceptance:** `helm install` with only the two secrets (either source) → green pod, UI reachable, admin login; `helm test` validates the two-secret tier.

---

## Frontend touchpoints (codemaster-frontend)

Backend exposes; frontend consumes (align contracts when building 3–5; fetch the repo to match):
- **Login** (superadmin) + **change-password** flow.
- **Config forms:** LLM, GitHub, Confluence → `PUT /api/admin/*-config` → Postgres (field-codec encrypted).
- **`/config-status`** view — what's configured vs pending (drives a setup checklist in the UI).

## Edge-case & scenario catalog (consolidated)

| Scenario | Behavior |
|---|---|
| Both env + Vault hold DB creds | selector decides; no guessing |
| Vault down, source=vault | boot blocked (clear); source=openshift → unaffected |
| SA not bound to Vault role | 403 → "SA not authorized for role X" |
| Key missing / malformed | boot blocked, named |
| Pod restart / redeploy / scale-out | re-reads creds+key from source — nothing lost |
| Multi-replica superadmin seed | ON CONFLICT → one row |
| GitHub/LLM/Confluence unset | pod up, UI reachable, `/config-status` shows pending |
| Webhook before GitHub configured | rejected gracefully, logged; pod fine |
| Migrate in vault-mode | `resolve_dsn` pre-step exports the DSN before `migrate:up` |
| Password special chars | URL-encoded in the assembled DSN |
| Upgrade with changed admin creds | never reset |
| Default admin/admin unchanged | login works + loud warning |
| Key rotation | versioned keyset: decrypt old, encrypt new |

## Definition of done

- `helm install` with **only** DB creds + key (Secret **or** Vault) → pod Ready, `/readyz` green, UI reachable, `admin`/`admin` logs in — **no** GitHub/LLM/Confluence required.
- Configure LLM via the UI (Vault optional) → stored encrypted in Postgres → a review runs.
- **One** migration baseline; schema identical to all-17.
- All steps TDD-green; `helm lint`+`template` clean; `deploy:check` green for the two-secret tier.

## Risks & rollback

- **Fused baseline diverges from the 17** → schema-diff verification (step 6) gates it; keep the 17 in git history for reference.
- **Re-tier weakens a real guard** → the blocking tier still hard-fails on DB/key/schema; non-blocking items are surfaced, not silently dropped.
- **K8s-auth misconfig** → clear 403 messaging; token/agent-file modes remain as fallbacks.
- All work is on an unpushed branch; revert = drop the branch.

## Sequencing

1 → 2 (creds need the Vault reader) → 3 (re-tier uses resolved DSN) → 4 (independent, can parallel 3) →
5 (needs keyset) → 6 (independent) → 7 (chart, last). Each step ships green before the next.

---

## Review refinements — addressed (2026-06-13 adversarial review)

### R1. Field-encryption key lifecycle (root of trust for UI secrets)
- **Format (EXISTING — `security/field_encryption_keys_loader.ts`):** JSON
  `{ "current_version": "vN", "keys": { "v1": "<base64 of 32 random bytes>", "vN": "…" } }`.
  AES-256-GCM (32-byte keys), versioned. `parseKeysetPayload` validates: `current_version` present +
  string; `keys` an object; each value strict-base64 decoding to exactly 32 bytes.
- **Generation:** `openssl rand -base64 32` per key; first keyset
  `{"current_version":"v1","keys":{"v1":"<that>"}}`. Ship `npm run gen:field-key` to emit it.
- **Entropy:** 32 bytes from a CSPRNG only — no passphrases / KDF-derived keys.
- **Storage:** the Secret/Vault entry, read-only (decision 4). The app holds it in memory only.
- **Backup (REQUIRED):** back up the Secret/Vault entry in your secret-backup process. **LOST KEY =
  every UI-saved secret (LLM API key, user emails) is PERMANENTLY UNRECOVERABLE** — the DB holds only
  ciphertext. The runbook must state this in bold.
- **Restore test (DR):** go-live acceptance — restore DB + the SAME keyset → decrypts; restore +
  wrong/missing keyset → fails clearly (see R8).
- **Rotation ceremony:** add `vN+1` to `keys`, set `current_version=vN+1`, update the Secret/Vault
  entry; the codec decrypts old data by its version tag, encrypts new with current. **Retain old
  versions** as long as any ciphertext references them (no destructive rotation).

### R2. `/config-status` contract
- `GET /api/admin/config-status` — **super_admin auth required**; **never returns secret values**.
- `{ items: [{ key, state, source, last_checked_at, message }] }`,
  `state ∈ configured | validated | pending | invalid | unknown`, `source ∈ db | env | vault | none`.
- **`configured`** = a value is present. **`validated`** = present AND an active probe confirmed it
  works (GitHub auth ping / LLM ping). Default reports configured/pending; validated/invalid only when
  a probe ran. The two are distinct — "set" ≠ "works".
- Drives the frontend setup-checklist (R5).

### R3. Migration-fusion gates (stronger than byte-diff)
- Verification = **normalized schema diff + semantic checks**, NOT raw bytes (extension version/owner
  differences create false diffs). Compare, on {fresh+fused} vs {fresh+all-17}: extensions (name
  only), schemas, tables+columns+types, indexes, constraints, functions, grants (ownership-normalized
  via `pg_dump --no-owner --no-privileges`), **seed rows** (row-level SELECT compare), migration
  journal expectation. A throwaway verify script gates step 6.
- **Keep the 17** in `migrations/_archive/` (or git tag `pre-fusion`) until go-live passes; remove after.

### R4 + R5. Two charts; frontend is first-class
- **Decision: TWO charts.** Backend = this repo (`deploy/helm/codemaster-backend`, Service
  `codemaster-backend`). Frontend = `codemaster-frontend` (Next.js; its own `Dockerfile` +
  `deploy/{kind,openshift}` + `contracts/openapi.json`; `.env.example` →
  `BACKEND_API_BASE_URL=http://codemaster-backend.<ns>.svc`).
- **Frontend tasks (first-class):**
  - **OpenAPI sync:** backend publishes its OpenAPI; the frontend's `contracts/openapi.json` is
    regenerated whenever the backend adds /config-status + superadmin + config endpoints (a contract
    step, not an afterthought).
  - **`BACKEND_API_BASE_URL`** → the backend Service DNS (same namespace: `codemaster-backend.<ns>.svc`).
  - **RBAC visibility:** config UI is super_admin-only (backend enforces; frontend hides for others).
  - **Setup-checklist UI** driven by `/config-status`.
  - **Frontend deploy wiring:** its `deploy/openshift` overlay (image, BACKEND_API_BASE_URL, the Route
    for browser access).
- **Go-live verification (runbook):** install BOTH charts; verify **browser login through the frontend
  Route** as admin/admin → reaches the backend — not just backend `/readyz`.

### R6. Readiness vs liveness
- **`/livez` (liveness):** process alive + event loop responsive; depends on NOTHING downstream — a DB
  blip or pending config must NOT trigger liveness restarts (no flapping).
- **`/readyz` (readiness):** DB reachable + key loaded + schema OK (the blocking tier) + runtime loops
  alive — gates TRAFFIC. Pending non-blocking config (github/llm/confluence) does NOT affect `/readyz`
  (the pod is ready to serve the UI + accept config). Audit `/healthz` to ensure it carries liveness
  (no downstream-config checks).

### R7. Vault-Transit inventory (precise — replaces "any other")
- **Confirmed by grep:** the ONLY Vault-Transit-encrypted column is
  `core.llm_provider_settings.api_key_ciphertext` (`llm_provider_settings_repo.ts`). `email_ciphertext`
  is ALREADY the local field codec. **Step 4 switches exactly that one repo; there is no other.**
- **Scope (DECIDED = a):** GitHub app creds + Confluence token get NEW DB-config surfaces NOW
  (columns + field-codec + admin APIs + 3-source resolver), modeled on the LLM repo — see the
  expanded Step 4. They are still **non-blocking** (resolved DB > env > Vault > disabled at use-time).

### R8. Disaster-recovery acceptance (go-live tests)
- **DR-1:** restore a DB backup + provision the SAME keyset → app boots, decrypts saved config → works.
- **DR-2:** restore DB + WRONG or MISSING keyset → app fails CLEARLY at first decrypt ("cannot decrypt
  with current field-encryption keyset — wrong/missing key version"), never silently corrupts/serves garbage.

### R9. Vault Kubernetes-auth setup (operator runbook detail)
- **Namespace:** the app's OpenShift namespace. **SA:** `codemaster-backend` (the deployment's
  serviceAccountName). **Auth path:** `auth/kubernetes` (`CODEMASTER_VAULT_K8S_AUTH_PATH`).
- **Vault role (Vault-admin):** `vault write auth/kubernetes/role/codemaster
  bound_service_account_names=codemaster-backend bound_service_account_namespaces=<ns>
  policies=codemaster-read ttl=1h`.
- **Policy `codemaster-read`:** read on `codemaster/postgres/*` + `codemaster/field-encryption/*`
  (+ any vault-sourced feature config).
- **Token renewal:** renew before lease expiry; re-login on 403/expiry.
- **SA JWT rotation:** OpenShift projected SA tokens are short-lived + auto-rotate — the app RE-READS
  the JWT file on each login (never caches the JWT), so rotation is transparent.

### R10. Config precedence — two rules, do not conflate
- **Bootstrap secrets (DB creds, field key): NO fallback.** Read EXACTLY `CODEMASTER_SECRET_SOURCE`
  (openshift|vault); missing → fail loud naming that source. Deterministic, no surprises.
- **UI-managed feature config (LLM/GitHub/Confluence): fallback chain** — DB (UI) > env
  (ConfigMap/Secret) > Vault > disabled. Layered; UI wins.
- The no-fallback rule applies ONLY to the two bootstrap secrets; feature config is intentionally layered.

### Plan deltas from this review
- New helper `npm run gen:field-key`; new DR acceptance tests (DR-1/DR-2); `/config-status` gets a
  formal contract + admin auth + configured-vs-validated; step 6 verification upgraded to
  normalized+semantic with an archived-migrations safety net; a frontend workstream (OpenAPI sync,
  Route, BACKEND_API_BASE_URL, RBAC, checklist UI) + two-chart runbook; `/livez` vs `/readyz` split;
  the Transit inventory pinned to one repo; the github/confluence-UI-config scope decision surfaced.
