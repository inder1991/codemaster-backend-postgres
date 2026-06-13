#!/usr/bin/env bash
# GENERATED from DEPLOY_CONTRACT (apps/backend/src/deploy_preflight.ts) by scripts/gen_deploy_artifacts.ts — do not edit by hand; run `npm run gen:deploy-artifacts`.
#
# One-shot Vault seeder: fill the <PLACEHOLDER>s (and the @*.pem file refs), then run once.
# Manual alternative: run each `vault kv put` below by hand.
set -euo pipefail
: "${VAULT_ADDR:?set VAULT_ADDR (e.g. https://vault.vault:8200)}"
: "${VAULT_TOKEN:?set VAULT_TOKEN}"
# KV-v2 mount (the chart's vault paths sit under this). Override if your mount differs. This is the SAME
# env var the app reads (vault_reader_factory) — keep them in lockstep, else the app reads a different mount.
MOUNT="${CODEMASTER_VAULT_KV_MOUNT:-secret}"

# codemaster/postgres/app (REQUIRED) — the primary application database — nothing works without it
vault kv put "${MOUNT}/codemaster/postgres/app" dsn='<DSN>'

# codemaster/postgres/maint (optional) — partition maintenance (pg_partman) — unset means partitions stop being maintained
vault kv put "${MOUNT}/codemaster/postgres/maint" dsn='<DSN>'

# codemaster/field-encryption/keys (REQUIRED) — field-level encryption keyset — the root of trust for all UI-saved secrets
vault kv put "${MOUNT}/codemaster/field-encryption/keys" keys='<KEYS>'

# codemaster/github/app (optional) — GitHub App authentication (no PR reviews until configured)
vault kv put "${MOUNT}/codemaster/github/app" app_id='<APP_ID>' private_key_pem=@codemaster-github-app.pem webhook_secret='<WEBHOOK_SECRET>'

# codemaster/confluence/token (optional) — Confluence ingestion (knowledge corpus)
vault kv put "${MOUNT}/codemaster/confluence/token" token='<TOKEN>'

# codemaster/api/auth (optional) — session signing key (auth routes)
vault kv put "${MOUNT}/codemaster/api/auth" session_signing_key='<SESSION_SIGNING_KEY>' csrf_secret='<CSRF_SECRET>'

echo "✓ seeded — now run 'npm run deploy:check' (or let the pod preflight) to verify."
