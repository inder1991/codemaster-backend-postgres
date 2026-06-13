# codemaster-backend — first deploy (quickstart)

Goal: go from nothing to a working PR review. Follow these steps top to bottom. The deploy contract
(every secret/extension/schema/config) is in [`deploy-contract.md`](./deploy-contract.md); this is the
*procedure*. The boot preflight + `npm run deploy:check` validate each step and tell you the exact fix
if something is missing — so you never get a "Ready but does nothing" pod.

## 0. Prerequisites

- **Self-managed Postgres** (you control extensions). Managed RDS/CloudSQL is not supported (needs
  `pg_partman`).
- **HashiCorp Vault** reachable from the cluster (the chart's default secret source).
- A **GitHub App** (step 2) and **LLM credentials** (Anthropic or AWS Bedrock).
- An **ingress** that can receive GitHub webhooks over HTTPS.

## 1. Provision Postgres

On your Postgres instance, create the database and install the two extensions (the migrations create
the `core/audit/cache/telemetry/partman` schemas):

```sql
CREATE EXTENSION IF NOT EXISTS pg_partman WITH SCHEMA partman;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
```

You need two DSNs: the app DSN (`CODEMASTER_PG_CORE_DSN`) and — recommended — a maintenance DSN
(`CODEMASTER_PG_MAINT_DSN`) for `pg_partman`. Migrations run with DDL/owner privileges; the runtime
needs only DML. **Never point migrations at a shared/cluster DB.** PgBouncer **transaction** mode is fine:
every advisory lock the app takes is transaction-scoped (`pg_try_advisory_xact_lock`), released at
commit/rollback — so the pool can hand the connection to another client between transactions.

## 2. Create the GitHub App

Create a GitHub App with (confirm against your security review):

- **Permissions:** Contents → Read, Pull requests → Read & write, Metadata → Read.
- **Subscribe to events:** Pull request.
- **Webhook URL:** `https://<your-ingress-host>/<webhook-path>` (HTTPS required by GitHub).
- Generate a **private key** (PEM) and a **webhook secret**; note the **App ID**.

Install the App on the repos/orgs you want reviewed.

## 3. Seed Vault

Fill in the placeholders and run the generated one-shot seeder (or run its `vault kv put` lines by
hand — they are the manual procedure):

```bash
export VAULT_ADDR=https://vault.your-domain:8200
export VAULT_TOKEN=...            # a token with write on the secret/ mount
bash deploy/seed-vault.sh         # see deploy/seed-vault.sh — fill <PLACEHOLDER>s + the @*.pem ref first
```

This seeds the DSNs, the GitHub App (`app_id`/`private_key_pem`/`webhook_secret`), the
field-encryption keyset, and api-auth secrets. The exact paths/keys are in
[`deploy-contract.md`](./deploy-contract.md).

## 4. Set the REQUIRED Helm overrides

Everything else has a safe default. You MUST set:

```yaml
image:
  repository: <your-registry>/codemaster-backend   # the default is a placeholder
  digest: sha256:...                                # pin in prod
vault:
  addr: https://vault.your-domain:8200              # empty => crashloop
config:
  runtime:
    mode: shadow                                    # START in shadow (step 5)
# wire the Vault paths under vault.agent.fileSecrets / envSecrets per deploy-contract.md
```

## 5. Install in SHADOW mode (safe first deploy)

`shadow` runs the full runtime **observe-only** — no reviews posted, no side effects — so a first
deploy can't do harm while you confirm wiring:

```bash
helm install codemaster ./deploy/helm/codemaster-backend -f your-values.yaml
```

The migrate Job runs first (pre-install hook). If Postgres prereqs are missing, it fails here with a
clear error.

## 6. Validate

```bash
helm test codemaster          # runs deploy:check in-cluster + the /healthz,/readyz smoke
kubectl -n <ns> logs job/...  # or: kubectl exec ... -- node apps/backend/src/deploy_check.js
```

`deploy:check` prints a numbered remediation list for anything missing (each with its fix). When it
passes and `/readyz` is green, you're wired correctly.

## 7. Go live

Flip the runtime to `postgres` and upgrade:

```bash
helm upgrade codemaster ./deploy/helm/codemaster-backend -f your-values.yaml \
  --set config.runtime.mode=postgres
```

Open a PR on an installed repo — a review should post within ~1–2 minutes.

## Cost caps

Defaults: **$5,000/day global**, **$1,000/day per-org** (fail-closed at the limit). Override per-org
via the admin API; see [`deploy-contract.md`](./deploy-contract.md).

## Troubleshooting

- **Pod crashloops at boot with a "deploy preflight failed" list** — read it; each line names the
  missing secret/extension/config and its fix. Re-seed / re-provision and restart.
- **Pod Ready but no reviews** — confirm the GitHub App webhook reaches the ingress and
  `github_app.webhook_secret` matches; check `deploy:check` passes.
- **`pg_partman` errors at migrate** — the extension is not installed on your Postgres (step 1).
