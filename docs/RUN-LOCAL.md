# Run codemaster-backend locally on macOS — no Homebrew, no Vault

> **Verified working 2026-06-08** on macOS with Node v25.4.0, Docker 28.5, Temporal CLI 1.7.1
> (Server 1.31.0), and the `codemaster-postgres:dev` image. Every command below was executed and
> the endpoints returned the output shown.

## What this gets you

A **fully-booted backend** — the single combined process: HTTP API + Temporal **review worker** +
**outbox-dispatcher** — running against a throwaway Postgres and a local Temporal dev server.

- **No Vault** is required (auth/admin routes are off; the embedder uses a stub).
- **No Homebrew** is required (Node + Docker + a one-line Temporal CLI install).

It boots, serves `/healthz`/`/readyz`, runs all internal workflows + schedules, and is ready to
process reviews. It will **not** perform a *real* GitHub PR review yet — that needs Vault + a GitHub
App + an Anthropic key (see the last section).

---

## 0. Prerequisites (no Homebrew)

| Need | How to get it without brew |
|---|---|
| **Docker running** | Docker Desktop / OrbStack / Colima — install the `.dmg` from the vendor (this is what brew's cask does anyway). Verify: `docker version`. |
| **Node.js 22+** | Installer `.pkg` from nodejs.org, or **nvm**: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh \| bash && nvm install 22`. Verify: `node -v`. |
| **git** | `xcode-select --install` (almost always already present). |
| **Temporal CLI** | Official one-liner: `curl -sSf https://temporal.download/cli.sh \| sh` then `export PATH="$HOME/.temporalio/bin:$PATH"`. Verify: `temporal --version`. |
| **`codemaster-postgres:dev` image** | Postgres 16 **with the `vector` (pgvector) + `pg_partman` extensions** — the migration baseline (`migrations/0001_baseline.sql`) requires both. This image ships with the dev tooling. *(Any PostgreSQL 16 image with those two extensions also works; plain `postgres:16` does **not**.)* |

`ruff` / `gitleaks` / `eslint` are **not** needed to boot — they are only spawned when a review runs
and fail **open** if absent. Skip them for a plain local run.

---

## 1. Start the infra (two throwaway containers + a dev server)

Ports here (`5439`, `7240`) are arbitrary free ports — pick any free ports; these avoid clashing with
a local kind cluster that often holds `5434`/`7233`.

```sh
# Throwaway Postgres (with pgvector + pg_partman) on host port 5439
docker run -d --name cmlocal-pg -e POSTGRES_PASSWORD=devpass -e POSTGRES_USER=postgres \
  -p 5439:5432 codemaster-postgres:dev

# wait until it's ready
until docker exec cmlocal-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

# Local Temporal dev server (in-memory; leave it running). Separate terminal, or background it.
export PATH="$HOME/.temporalio/bin:$PATH"
temporal server start-dev --ip 127.0.0.1 --port 7240 --ui-port 8240 --namespace default
#   → Temporal UI at http://localhost:8240
```

---

## 2. Configure the app

```sh
git clone https://github.com/inder1991/codemaster-backend   # or use your checkout
cd codemaster-backend
npm install                                                  # prebuilt native deps; no Xcode needed
mkdir -p ~/.codemaster/workspaces ~/.codemaster/clone-cache  # Linux defaults aren't writable on macOS
```

Create **`.env`** (the app does **not** auto-load it — you `source` it in step 3). This is the exact
verified minimal config:

```sh
CODEMASTER_PG_CORE_DSN=postgresql://postgres:devpass@localhost:5439/postgres
TEMPORAL_ADDRESS=localhost:7240
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=review-default        # pin so producer + worker agree (else 0 reviews)
CODEMASTER_EMBEDDINGS_PROVIDER=platform
CODEMASTER_QWEN_DSN=stub://recording      # stub = no external embedder service
CODEMASTER_WORKSPACE_ROOT=/Users/<you>/.codemaster/workspaces
CODEMASTER_CLONE_CACHE_ROOT=/Users/<you>/.codemaster/clone-cache
CODEMASTER_API_HOST=0.0.0.0
CODEMASTER_API_PORT=8080
CODEMASTER_SECURE_COOKIES=false
CODEMASTER_AUTH_ROUTES_ENABLED=false      # OFF ⇒ no Vault needed to boot
```

> A ready-to-copy template lives at `.env.example`. `.env` is git-ignored.

---

## 3. Migrate + run

```sh
# load the env into THIS shell (the app reads process.env, not .env)
set -a; source .env; set +a

npm run migrate:up                         # one-time per fresh DB; baseline is irreversible
npx tsx apps/backend/src/main.ts           # the combined process (API + workers)
```

Migrations end with `Migrations complete!`. The app prints the workers reaching `state: RUNNING` and
`schedule ensured: …` for each of the 7 schedules.

---

## 4. Verify (in another terminal)

```sh
curl -s localhost:8080/healthz   # → 200  {"version":"0.1.0", postgres/vault status ...}
curl -s localhost:8080/readyz    # → 200  {"ready":true,"reason":null}
curl -s localhost:8080/version   # → {"version":"0.1.0","node_version":"v25.x", ...}
```

Expected app-log lines (proves the worker joined Temporal):

```
Worker state changed { taskQueue: 'review-default',     state: 'RUNNING' }
Worker state changed { taskQueue: 'outbox-dispatcher',  state: 'RUNNING' }
schedule ensured: codemaster-mutex-janitor
schedule ensured: codemaster-review-run-reaper
schedule ensured: refresh-confluence-corpus
schedule ensured: mark-stale-confluence-chunks
schedule ensured: codemaster-run-id-retention
schedule ensured: codemaster-partition-maintenance
schedule ensured: codemaster-workspace-retention
```

---

## 5. Stop / clean up

```sh
pkill -f "tsx apps/backend/src/main.ts"                 # stop the app
pkill -f "temporal server start-dev .* --port 7240"    # stop Temporal
docker rm -f cmlocal-pg                                 # remove the throwaway Postgres (data is ephemeral)
```

---

## Doing a *real* PR review (needs Vault + a GitHub App)

The minimal boot above does everything except call GitHub/Anthropic. For an end-to-end
webhook → review → comment you additionally need:

1. A dev **Vault**: `vault server -dev -dev-root-token-id=devroot -dev-listen-address=0.0.0.0:8200`
   (the Vault binary also installs without brew — download from releases.hashicorp.com).
2. Seed the KV paths (shapes in `deploy/local-kind/seed-vault.sh`):
   `secret/codemaster/github/app` (app_id, private_key_pem, webhook_secret),
   `secret/codemaster/llm/anthropic` (api_key),
   `secret/codemaster/field-encryption/keys`, `secret/codemaster/api/auth`.
3. In `.env` set `VAULT_ADDR=http://localhost:8200`, `VAULT_TOKEN=devroot`,
   `CODEMASTER_VAULT_SECRET_SOURCE=vault-api` (and `CODEMASTER_AUTH_ROUTES_ENABLED=true` for the admin API).
4. Expose `localhost:8080` to GitHub (smee.io / ngrok) as the App's webhook URL.

Full end-to-end runbook: `docs/runbooks/2026-06-06-orchestrator-live-dual-run.md`.

---

## Troubleshooting

- **`too many clients` / connection errors** — the throwaway Postgres `max_connections` is 100; fine
  for one local process.
- **Worker processes zero reviews** — `TEMPORAL_TASK_QUEUE` must be set (the producer and the worker
  default to *different* queues otherwise). The `.env` above pins it.
- **`/var/lib/...` or `/clone-cache` permission errors** — set `CODEMASTER_WORKSPACE_ROOT` /
  `CODEMASTER_CLONE_CACHE_ROOT` to writable paths under your home (done above) and `mkdir -p` them.
- **App exits immediately** — Temporal must be reachable before the app starts (the worker fails loud
  if it can't connect); start `temporal server start-dev` first.
- **Migration fails on `CREATE EXTENSION`** — your Postgres lacks `vector`/`pg_partman`; use
  `codemaster-postgres:dev` (or a PG16 image with both extensions).
