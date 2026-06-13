#!/usr/bin/env bash
# GENERATED from DEPLOY_CONTRACT (apps/backend/src/deploy_preflight.ts) by scripts/gen_deploy_artifacts.ts — do not edit by hand; run `npm run gen:deploy-artifacts`.
#
# One-shot Vault seeder: fill the <PLACEHOLDER>s (and the @*.pem file refs), then run once.
# Manual alternative: run each `vault kv put` below by hand.
set -euo pipefail
: "${VAULT_ADDR:?set VAULT_ADDR (e.g. https://vault.vault:8200)}"
: "${VAULT_TOKEN:?set VAULT_TOKEN}"
# KV-v2 mount (the chart's vault paths sit under this). Override if your mount differs.
MOUNT="${CODEMASTER_VAULT_MOUNT:-secret}"

# codemaster/postgres/app (REQUIRED) — the primary application database — nothing works without it
vault kv put "${MOUNT}/codemaster/postgres/app" dsn='<DSN>'

# codemaster/postgres/maint (optional) — partition maintenance (pg_partman) — unset means partitions stop being maintained
vault kv put "${MOUNT}/codemaster/postgres/maint" dsn='<DSN>'

# codemaster/github/app (REQUIRED) — GitHub App authentication — no PR reviews are possible without it
vault kv put "${MOUNT}/codemaster/github/app" app_id='<APP_ID>' private_key_pem=@codemaster-github-app.pem webhook_secret='<WEBHOOK_SECRET>'

# codemaster/field-encryption/keys (optional) — field-level encryption keyset (eager-loaded at boot when auth routes are on)
vault kv put "${MOUNT}/codemaster/field-encryption/keys" keys='<KEYS>'

# codemaster/api/auth (optional) — session / auth-route secrets (required only when auth routes are enabled)
vault kv put "${MOUNT}/codemaster/api/auth" value='<VALUE>'

echo "✓ seeded — now run 'npm run deploy:check' (or let the pod preflight) to verify."
