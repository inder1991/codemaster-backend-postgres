# codemaster-backend — deploy contract

> GENERATED from DEPLOY_CONTRACT (apps/backend/src/deploy_preflight.ts) by scripts/gen_deploy_artifacts.ts — do not edit by hand; run `npm run gen:deploy-artifacts`.
> The boot preflight + `npm run deploy:check` enforce this contract; a deploy that violates it
> exits 1 with the exact fix instead of going Ready-but-dead.

## Bootstrap secrets — BLOCKING (provision in an OpenShift Secret OR Vault)

The ONLY secrets that gate boot. Provision both, from one source (`CODEMASTER_SECRET_SOURCE`).

| Secret | Source | Vault path | Key | Required | Gates |
|---|---|---|---|---|---|
| `CODEMASTER_PG_CORE_DSN` | env | `codemaster/postgres/app` | dsn | **yes** | the primary application database — nothing works without it |
| `CODEMASTER_PG_MAINT_DSN` | env | `codemaster/postgres/maint` | dsn | no | partition maintenance (pg_partman) — unset means partitions stop being maintained |
| `field_encryption.keys` | file | `codemaster/field-encryption/keys` | — | **yes** | field-level encryption keyset — the root of trust for all UI-saved secrets |

## Feature secrets — NON-BLOCKING (UI / env / Vault)

Never block boot; set later via the UI (stored in Postgres, encrypted by the field key), env, or
Vault. `/config-status` reports which are configured vs pending.

| Secret | Source | Vault path | Key | Required | Gates |
|---|---|---|---|---|---|
| `github_app.app_id` | file | `codemaster/github/app` | app_id | no | GitHub App authentication (no PR reviews until configured) |
| `github_app.private_key_pem` | file | `codemaster/github/app` | private_key_pem | no | GitHub App authentication (clone + post review) |
| `github_app.webhook_secret` | file | `codemaster/github/app` | webhook_secret | no | inbound webhook HMAC verification |
| `confluence.base_url` | file | `codemaster/confluence/token` | base_url | no | Confluence ingestion (knowledge corpus) |
| `confluence.token` | file | `codemaster/confluence/token` | token | no | Confluence ingestion (knowledge corpus) |
| `api_auth.session_signing_key` | file | `codemaster/api/auth` | session_signing_key | no | session signing key (auth routes) — auto-generated + persisted if unset |
| `api_auth.csrf_secret` | file | `codemaster/api/auth` | csrf_secret | no | CSRF secret (auth routes) — auto-generated + persisted if unset |

Seed Vault secrets at once with `deploy/seed-vault.sh`, or by hand with its `vault kv put` commands.

## Postgres extensions (self-managed Postgres)

| Extension | Install |
|---|---|
| `pg_partman` | `CREATE EXTENSION IF NOT EXISTS pg_partman WITH SCHEMA partman;` |
| `vector` | `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;` |

## Schemas (created by the migrations)

`core`, `audit`, `cache`, `telemetry`, `partman` — a missing schema means `npm run migrate:up` has not run.

## Config

| Env | Default | Allowed | Required |
|---|---|---|---|
| `CODEMASTER_RUNTIME_MODE` | postgres | postgres \| shadow | no |
| `CODEMASTER_EMBEDDINGS_PROVIDER` | platform | platform \| openai_compat | no |
