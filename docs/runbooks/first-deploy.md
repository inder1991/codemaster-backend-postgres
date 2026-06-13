# codemaster-backend — first deploy (quickstart)

Goal: go from nothing to a working PR review. Follow these steps top to bottom. The deploy contract
(every secret/extension/schema/config) is in [`deploy-contract.md`](./deploy-contract.md); this is the
*procedure*. The boot preflight + `npm run deploy:check` validate each step and tell you the exact fix
if something is missing — so you never get a "Ready but does nothing" pod.

**The turnkey promise:** the pod comes up on **only two secrets — the DB credentials and the
field-encryption key**. Everything else (LLM, GitHub, Confluence) is non-blocking and configured *after*
the pod is up, from the admin UI (`/admin/setup`), env, or Vault. So a first deploy can't be blocked on
integration config.

## 0. Prerequisites

- **Self-managed Postgres** (you control extensions). Managed RDS/CloudSQL is not supported (needs
  `pg_partman`).
- A way to provide the **two bootstrap secrets** — DB credentials + the field-encryption key — via
  **either** an OpenShift/Kubernetes Secret **or** Vault (step 3 covers both). Vault is OPTIONAL.
- An **ingress/Route** that can receive GitHub webhooks over HTTPS (for PR reviews).
- (Later, via the UI) a **GitHub App** + **LLM credentials** — not needed for the pod to come up.

## 1. Provision Postgres

On your Postgres instance, create the database and install the two extensions (the single baseline
migration creates the `core/audit/cache/telemetry/partman` schemas + seed):

```sql
CREATE EXTENSION IF NOT EXISTS pg_partman WITH SCHEMA partman;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
```

You need two DSNs: the app DSN (`CODEMASTER_PG_CORE_DSN`) and — recommended — a maintenance DSN
(`CODEMASTER_PG_MAINT_DSN`) for `pg_partman`. Migrations run with DDL/owner privileges; the runtime
needs only DML. **Never point migrations at a shared/cluster DB.** PgBouncer **transaction** mode is fine:
every advisory lock the app takes is transaction-scoped (`pg_try_advisory_xact_lock`), released at
commit/rollback — so the pool can hand the connection to another client between transactions.

> Migrations are a **single fused baseline** (`migrations/0001_baseline.sql`, up-only). The pre-install
> migrate Job applies it; on a fresh DB it is one step.

## 2. Generate the field-encryption key

This key (the root of trust for every UI-saved secret) is one of the two bootstrap secrets. Generate a
32-byte AES-256 key and wrap it in the keyset envelope:

```bash
KEY=$(openssl rand -base64 32)
KEYSET=$(printf '{"current_version":"v1","keys":{"v1":"%s"}}' "$KEY")
echo "$KEYSET"   # store this — losing it makes all UI-saved (encrypted) config unrecoverable
```

## 3. Provide the two bootstrap secrets — pick ONE source

`secretSource` (a chart value, default `openshift`) selects where the pod reads the **DB credentials +
the field-encryption keyset**. Both modes are first-class.

### Mode A — OpenShift / Kubernetes Secret (simplest; no Vault)

Create a Secret with the bootstrap values, then reference it from the chart via `extraEnvFrom`:

```bash
kubectl -n <ns> create secret generic codemaster-bootstrap \
  --from-literal=CODEMASTER_PG_CORE_DSN='postgresql://user:pass@pg-host:5432/codemaster' \
  --from-literal=CODEMASTER_FIELD_ENCRYPTION_KEYSET="$KEYSET" \
  --from-literal=CODEMASTER_SESSION_SIGNING_KEY="$(openssl rand -hex 32)" \
  --from-literal=CODEMASTER_CSRF_SECRET="$(openssl rand -hex 32)"
```

Chart values:

```yaml
secretSource: openshift          # the default
extraEnvFrom:
  - secretRef:
      name: codemaster-bootstrap
```

> The Vault-Agent variant is also `secretSource: openshift` — set `vault.mode: agent` and the Injector
> renders the same env vars into the sourced runtime-env; the chart then sets `CODEMASTER_FIELD_KEY_SOURCE
> =vault-agent` so the keyset is read from the rendered file. See `values.yaml` `vault:`.

### Mode B — Vault via the OpenShift ServiceAccount (Vault Kubernetes auth)

The pod logs in to Vault with its projected ServiceAccount JWT — **no static token**. Set up the Vault
side once:

```bash
# 1. Enable + configure Kubernetes auth (one-time, by a Vault admin; kubernetes_host is your API server,
#    e.g. https://kubernetes.default.svc from in-cluster, or the external API URL).
vault auth enable kubernetes
vault write auth/kubernetes/config kubernetes_host="https://kubernetes.default.svc"

# 2. A policy granting READ on the two bootstrap paths.
vault policy write codemaster-bootstrap - <<'EOF'
path "secret/data/codemaster/postgres/app"        { capabilities = ["read"] }
path "secret/data/codemaster/field-encryption/keys" { capabilities = ["read"] }
EOF

# 3. Bind the pod's ServiceAccount to a role with that policy.
vault write auth/kubernetes/role/codemaster-backend \
  bound_service_account_names=codemaster-backend \
  bound_service_account_namespaces=<ns> \
  policies=codemaster-bootstrap ttl=1h

# 4. Seed the secrets (KV-v2).
vault kv put secret/codemaster/postgres/app dsn='postgresql://user:pass@pg-host:5432/codemaster'
vault kv put secret/codemaster/field-encryption/keys keys="$KEYSET"
```

Chart values:

```yaml
secretSource: vault
vault:
  addr: https://vault.your-domain:8200
  kubernetes:
    role: codemaster-backend       # the Vault role bound to the pod's ServiceAccount
  kvMount: secret                  # the KV-v2 mount the bootstrap secrets live under
```

The chart mounts the SA token automatically in this mode, and the migrate Job resolves the DSN from
Vault (via `resolve_dsn`) before running migrations.

## 4. Set the REQUIRED Helm overrides

Everything else has a safe default. Beyond the `secretSource` block from step 3, you MUST set:

```yaml
image:
  repository: <your-registry>/codemaster-backend   # the default is a placeholder
  digest: sha256:...                                # pin in prod
config:
  runtime:
    mode: shadow                                    # START in shadow (step 5)
```

## 5. Install in SHADOW mode (safe first deploy)

`shadow` runs the full runtime **observe-only** — no reviews posted, no side effects — so a first
deploy can't do harm while you confirm wiring:

```bash
helm install codemaster ./deploy/helm/codemaster-backend -f your-values.yaml
```

The migrate Job runs first (pre-install hook). If Postgres prereqs are missing, it fails here with a
clear error.

## 6. Validate + log in

```bash
helm test codemaster          # runs deploy:check in-cluster + the /healthz,/readyz smoke
```

`deploy:check` prints a numbered remediation list for anything missing (each with its fix). When it
passes and `/readyz` is green, you're wired correctly.

**Log in to the admin UI** with the bootstrapped super-admin — username `admin`, password `admin`. The
pod logs a loud warning while the default password is in use; **change it via the UI immediately**. (The
account is created on first boot and never clobbered after.)

## 7. Configure integrations via the UI (non-blocking)

The pod is up without GitHub/LLM/Confluence. Configure them from the admin UI — `/admin/setup` shows a
checklist of what's configured and from which source, plus the GitHub + Confluence forms. LLM lives on
`/admin/llm`. (You can also provision these via env or Vault; the runtime resolves each DB > env > Vault.)
For PR reviews you need a **GitHub App** (Contents: Read, Pull requests: Read & write, Metadata: Read;
subscribe to Pull request events; webhook → `https://<ingress>/<webhook-path>`) and **LLM credentials**.

## 8. Go live

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
  missing secret/extension/config and its fix. Re-provision and restart. Only the DB credentials + the
  field-encryption key block boot.
- **`vault mode` boot fails to reach Vault** — confirm `vault.addr`, that the pod's ServiceAccount is
  bound to `vault.kubernetes.role`, and that the role's policy grants read on the bootstrap paths.
- **Pod Ready but no reviews** — confirm GitHub is configured (`/admin/setup` shows it), the webhook
  reaches the ingress, and the webhook secret matches; check `deploy:check` passes.
- **`pg_partman` errors at migrate** — the extension is not installed on your Postgres (step 1).
- **Lost the field-encryption key** — UI-saved (encrypted) config is unrecoverable; re-provision the key
  and re-enter the integrations via `/admin/setup`.
