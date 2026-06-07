#!/usr/bin/env bash
# Seed the in-namespace dev Vault with the secrets the TS backend needs to BOOT + the LLM transit key.
# DEV ONLY (zero field-encryption key, throwaway auth secrets). Re-runnable (overwrites).
#
# Optional real-PR creds (export before running to enable the live review chain):
#   GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_WEBHOOK_SECRET, GITHUB_APP_PRIVATE_KEY_PATH, ANTHROPIC_API_KEY
set -euo pipefail
NS=codemaster-backend
POD=$(kubectl -n "$NS" get pod -l app.kubernetes.io/name=vault -o jsonpath='{.items[0].metadata.name}')
ex() { kubectl -n "$NS" exec "$POD" -- sh -c "VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=devroot $*"; }
exi() { kubectl -n "$NS" exec -i "$POD" -- sh -c "VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=devroot $*"; }

echo "==> Enabling kv-v2 (secret/) + transit (idempotent)"
ex "vault secrets enable -path=secret kv-v2" 2>/dev/null || true
ex "vault secrets enable transit" 2>/dev/null || true

echo "==> Transit key 'llm_provider_settings' (LLM credential encrypt/decrypt)"
ex "vault write -f transit/keys/llm_provider_settings" >/dev/null

# Field-encryption keyset — nested 'keys' object MUST survive (loader reads it raw), so pipe JSON via stdin.
echo "==> secret/codemaster/field-encryption/keys (dev-only zero v1 key)"
printf '%s' '{"current_version":"v1","keys":{"v1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}' \
  | exi "vault kv put secret/codemaster/field-encryption/keys -" >/dev/null

echo "==> secret/codemaster/api/auth (session signing key + CSRF secret, >=32 chars)"
ex "vault kv put secret/codemaster/api/auth \
      session_signing_key=dev-session-signing-key-0123456789-abcdef \
      csrf_secret=dev-csrf-secret-0123456789-abcdef-0123456789" >/dev/null

# ─── Optional: real-PR-review credentials (GitHub App + Anthropic) ──────────────────────────────────
if [[ -n "${GITHUB_APP_ID:-}" && -n "${GITHUB_APP_PRIVATE_KEY_PATH:-}" ]]; then
  echo "==> secret/codemaster/github/app (real GitHub App creds)"
  PEM=$(cat "$GITHUB_APP_PRIVATE_KEY_PATH")
  # Field names MUST match the token provider's reads: GitHubAppTokenProvider.fromEnv reads `app_id` +
  # `private_key_pem` from secret/codemaster/github/app (token_provider.ts). installation_id is NOT read here
  # (per-review routing — it comes from the webhook payload); webhook_secret is read by the ingest handler.
  exi "vault kv put secret/codemaster/github/app \
        app_id='${GITHUB_APP_ID}' \
        installation_id='${GITHUB_INSTALLATION_ID:-}' \
        webhook_secret='${GITHUB_WEBHOOK_SECRET:-}' \
        private_key_pem=-" <<<"$PEM" >/dev/null || true
fi
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "==> secret/codemaster/llm/anthropic"
  ex "vault kv put secret/codemaster/llm/anthropic api_key='${ANTHROPIC_API_KEY}'" >/dev/null || true
fi

echo "==> Seed complete. Verifying:"
ex "vault kv get -format=json secret/codemaster/field-encryption/keys" | head -c 200; echo
ex "vault kv list secret/codemaster" || true
