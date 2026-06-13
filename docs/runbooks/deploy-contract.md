# codemaster-backend — deploy contract

> GENERATED from DEPLOY_CONTRACT (apps/backend/src/deploy_preflight.ts) by scripts/gen_deploy_artifacts.ts — do not edit by hand; run `npm run gen:deploy-artifacts`.
> The boot preflight + `npm run deploy:check` enforce this contract; a deploy that violates it
> exits 1 with the exact fix instead of going Ready-but-dead.

## Secrets (seed in Vault)

| Secret | Source | Vault path | Key | Required | Gates |
|---|---|---|---|---|---|
| `CODEMASTER_PG_CORE_DSN` | env | `codemaster/postgres/app` | dsn | **yes** | the primary application database — nothing works without it |
| `CODEMASTER_PG_MAINT_DSN` | env | `codemaster/postgres/maint` | dsn | no | partition maintenance (pg_partman) — unset means partitions stop being maintained |
| `github_app.app_id` | file | `codemaster/github/app` | app_id | **yes** | GitHub App authentication — no PR reviews are possible without it |
| `github_app.private_key_pem` | file | `codemaster/github/app` | private_key_pem | **yes** | GitHub App authentication (clone + post review) |
| `github_app.webhook_secret` | file | `codemaster/github/app` | webhook_secret | **yes** | inbound webhook HMAC verification |
| `field_encryption.keys` | file | `codemaster/field-encryption/keys` | keys | no | field-level encryption keyset (eager-loaded at boot when auth routes are on) |
| `api_auth` | file | `codemaster/api/auth` | — | no | session / auth-route secrets (required only when auth routes are enabled) |

`source=file` secrets are Vault-Agent-rendered files (one JSON object per Vault path);
`source=env` secrets are injected as environment variables. Seed everything at once with
`deploy/seed-vault.sh`, or by hand with the `vault kv put` commands it contains.

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
