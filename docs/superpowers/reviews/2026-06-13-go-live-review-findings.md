# Go-live provisioning — adversarial review findings (2026-06-13)

Review of the go-live implementation on `feat/deploy-contract-preflight` (diff `docs/turnkey-deploy-plan..HEAD`,
Steps 1–3 + 4a + 4b). Five independent review lenses (integration-completeness, crypto/secrets, auth/access,
migration/schema, claims-vs-reality+edge) over the full diff; 38 raw findings de-duplicated + cross-corroborated;
high-impact items verified in-code on Opus. Supersedes the earlier author self-review ("no defects"), which was wrong.

## Meta-finding

**Steps 3–4 built the pieces; the integration into the real boot / runtime / chart paths is largely missing.**
The author self-review validated pieces in isolation and the full battery (~3,350 tests) passed only because **it
exercises the old paths** — there are no tests for openshift-no-Vault boot, runtime DB-config resolution, or
config-status-after-PUT. Four of five lenses converged on this class independently. The plan's three headline goals
are **not yet delivered**: openshift-no-Vault boot, Vault-SA auth, and UI-config-used-at-runtime.

## P0 — headline goals not delivered (each corroborated by 3–4 lenses)

- **A. openshift-no-Vault boot is broken.** `api/server.ts:75` loads the field key via `VaultHttpPort.fromEnv()`,
  bypassing the source-aware `installFieldKeyRegistryAtBoot` (only `background_runner_main` calls it).
  `deploy_preflight.ts` models `field_encryption.keys` as `source:"file"` only → **false-positive crash on a correct
  openshift deploy**. The registry also installs *after* HTTP bind → a null-registry request window.
  **Fix:** `main.ts` installs the field key once, source-aware, before bind; `server.ts` consumes the installed
  registry; the preflight field-key check becomes source-aware (env keyset in openshift).
- **B. Vault K8s-auth isn't integrated or chart-deployable.** SA-login is wired only for the DB DSN; field-key +
  server Vault reads still use static-token `VaultHttpPort.fromEnv()`. Helm never sets `CODEMASTER_SECRET_SOURCE`
  (only the *old* `CODEMASTER_VAULT_SECRET_SOURCE`), doesn't mount the SA token or render role/path; `resolve_dsn.ts`
  has no migrate call site. **Fix:** route all Vault reads through SA-auth in k8s mode + the chart wiring (Step 7).
- **C. UI-saved GitHub config is never used at runtime.** Vault-only across **all** sites: `token_provider`,
  `webhook_secret_provider`, `cron_handlers`, `event_handlers` (×2), `in_process_ports`. The DB repo is imported only
  by the admin CRUD route; `resolveLayered` is **dead code (zero call sites, verified)**; the route comment lies
  ("DB > env > Vault at use-time"). **Fix:** build `resolveGitHubAppConfig` (uses `resolveLayered`), wire into every
  token site; remove the false comment.

## P1

- **Dead `opts.vault` 503 guard** (`admin_routes.ts:2150/2261/2487`) — verified. After the 4a swap the handlers use the
  registry, not vault, but still 503 when `opts.vault` is undefined → **LLM config writes dead in no-Vault deploys.**
  Fix: drop `opts.vault` from the three guards, keep `getPreflightValidator`.
- **`/config-status` ignores the DB tier** + has no LLM `advisory` entry → setup-checklist wrong after a PUT. Fix:
  `configStatusProvider` queries the github + llm repos.
- **`github-config` PUT emits no audit event** — no forensic record for the platform's most sensitive secret. Fix:
  `opts.audit` with `action: github_app_settings.rotated`, no secrets in `after`.
- **`seed-vault.sh` writes `value=` for `api/auth`** but the code needs `session_signing_key` + `csrf_secret` →
  **running the generated seeder breaks auth boot.** (borderline P0.) Fix: the `api_auth` contract/generator entry.

## P2

- **Vault auth resilience** (`vault_k8s_auth.ts` / `vault_kv_reader.ts`): `lease_duration:0` → per-call re-login storm
  (3 lenses); 403-retry doesn't distinguish policy-denial from expiry (2 lenses); no in-flight login dedup →
  concurrent cold-start double-login. Fix: floor the lease, fast-fail on policy-denial, memoize the in-flight login.
- **`github-config` PUT validation**: only string checks — accepts empty/malformed/unbounded PEM, non-numeric app_id.
  Add length + format guards + a DB `CHECK (app_id ~ '^\s*[0-9]+\s*$')` on `0049`.
- **Crypto hardening**: `current_version` unvalidated (empty → degenerate `kms2::`); boot self-check exercises only the
  audit AAD, not the new LLM/GitHub column AADs.
- **`github_app_settings_repo.read()` lacks `LIMIT 1`** (defensive on the platform singleton).
- **`CODEMASTER_VAULT_MOUNT` (seeder) vs `CODEMASTER_VAULT_KV_MOUNT` (code) mismatch** — silent on default, breaks on override.
- **Stale Vault-Transit JSDoc** on `llm_provider_settings_repo.ts` (lines 1–30, 117, 258) — misdirects a Transit audit.

## P3

- `assembleDsn` host/port/database not URL-encoded (operator-controlled, latent).
- `resolve_dsn.ts` writes the DSN (with password) to stdout — prefer a tightly-permissioned temp env file.
- `CODEMASTER_SECRET_SOURCE` defaults to the weaker `openshift` (config footgun) — enforce as a required Helm value.
- Keyset closure holds raw key material process-lifetime; refresh WARN may log key-version names; `sanitizeAgentFileName`
  hyphen/underscore collision.
- `first-deploy.md` PgBouncer session-mode justification is **factually wrong** (all advisory locks are `_xact_`, work in
  transaction mode).
- Step-6 fusion blocks on the not-yet-built `confluence_settings` migration; `0049.last_rotated_by_user_id` has no FK
  (by design, like `llm_provider_settings` — document for the fusion).

## Clean confirmations (verified, no defect)

AAD uniqueness (5 distinct per-column AADs), ciphertext routing, key rotation/versioning, no secret leakage in
GET/error/preflight responses, CSRF + role guards correct, no infinite retry loop, no tenancy cross-read, the
source-source whitelist (throws on unrecognized).

## Fix order

1. **P0-A boot unification** — field-key install in `main.ts` before bind; source-aware preflight. (test-first: openshift-no-Vault boot)
2. **P0-C runtime resolution** — wire `resolveLayered` → all GitHub token sites + webhook; **P1 dead-guard**; comment fix. (test: runtime DB-resolution)
3. **P1 config-status DB + audit event + seeder api_auth fix.** (test: config-status-after-PUT)
4. **P0-B + chart/SA wiring** (Step 7).
5. **P2 hardening** — Vault resilience, validation, JSDoc, mount-var.
6. **P3** cleanup + Step-6 fusion prerequisites.

Every fix lands with the **integration test that would have caught it** — the coverage gap that let all of this through.
