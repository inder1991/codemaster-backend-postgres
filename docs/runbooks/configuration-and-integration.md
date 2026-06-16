# CodeMaster — Configuration & Integration Guide

This is the end-to-end guide for configuring CodeMaster and wiring it to every external system it
talks to: **GitHub** (the PR-review trigger + clone + posting), the **LLM provider** (the reviewer),
the **embedder** (semantic retrieval), **Confluence** (the optional knowledge corpus), **cost caps**
(budget enforcement), and **admin auth**. It explains both sides of every integration — *what you
configure on the third-party side* and *what you enter in the CodeMaster admin UI* — plus the env/Vault
equivalents and copy-pasteable examples.

It is written to be self-contained. For the pure *deployment* procedure (Helm, the two bootstrap
secrets, Postgres) see [`first-deploy.md`](./first-deploy.md); for the authoritative machine-checked
contract of every secret/extension/schema see [`deploy-contract.md`](./deploy-contract.md).

---

## 1. Mental model — how configuration works

### 1.1 Two bootstrap secrets gate boot — everything else is configured *after*

The pod comes up on **only two secrets**:

1. **`CODEMASTER_PG_CORE_DSN`** — the application Postgres DSN.
2. **The field-encryption keyset** (`CODEMASTER_FIELD_ENCRYPTION_KEYSET`) — the root of trust that
   encrypts every secret you later save from the UI.

Everything else — **GitHub, LLM, embedder, Confluence, cost caps** — is **non-blocking**: the pod boots
`Ready` without them and you configure them afterward. A first deploy therefore can't be blocked on
integration config, and you can't get a "Ready but silently does nothing" pod from a missing one.

### 1.2 Three configuration sources, one precedence: **DB > env > Vault**

| Source | How it's set | When to use |
|---|---|---|
| **DB (UI)** | Saved from the admin UI; stored in Postgres, **encrypted with the field key** | The normal path — operators configure live, no redeploy |
| **env** | `CODEMASTER_*` environment variables | CI / scripted / 12-factor deployments |
| **Vault** | KV-v2 secrets under `codemaster/*`, read via the pod's ServiceAccount | Centralized secret management |

**DB wins over env wins over Vault.** A value saved in the UI overrides the same value in env or Vault.
`GET /api/admin/config-status` reports, per integration, whether it is configured and from which source.

### 1.3 Configuration sources & secret storage — **Vault is read-only**

This is important to internalize:

- **CodeMaster never *writes* to Vault.** It only *reads* from it (via the pod's ServiceAccount). The
  only things in Vault are what *you* seed there.
- **Every secret you save through the UI is written to Postgres, field-encrypted** (AES-256-GCM
  envelope) — into `core.github_app_settings`, `core.llm_provider_settings`,
  `core.embedder_provider_settings`, `core.confluence_settings`, and `core.auth_secrets`. Never to Vault.
- **The field-encryption key is the root of trust.** Lose it and all UI-saved secrets become
  unrecoverable (re-enter them after re-provisioning the key). The session-signing + CSRF keys
  auto-generate and persist (field-encrypted, in `core.auth_secrets`) on first boot if unset — again,
  in the DB, not Vault.
- **Rotating a credential** = just re-save it in the UI (DB source wins over env/Vault). Field-key
  rotation is a separate operation (the keyset supports versioned keys).

So you can run CodeMaster with **read-only Vault access** holding only the two bootstrap secrets, and
configure every integration from the UI into Postgres.

### 1.4 Where each integration is configured in the UI

| Integration | Admin UI page | Backend endpoint(s) |
|---|---|---|
| GitHub App | **`/admin/setup`** (GitHub form) | `GET/POST /api/admin/github-config` |
| LLM provider(s) | **`/admin/llm`** (Providers / Model catalog / Job routing tabs) | `/api/admin/llm-provider-config` (+ `/preflight`, `/test-credentials`), `/api/admin/llm-models`, `/api/admin/llm-purpose-routing` |
| Embedder | **`/admin/llm`** (Embedding tab) | `GET/POST /api/admin/embedder-config` (+ `/test`) |
| Confluence | **`/admin/setup`** (Confluence form) + **`/admin/confluence/*`** | `GET/POST /api/admin/confluence-config` (+ `/test`), `/api/admin/integrations/confluence-spaces` |
| Cost caps | **`/cost-caps`** | `/api/admin/cost-caps` (+ `/settings`, `/changes`) |
| Config status | **`/admin/setup`** checklist | `GET /api/admin/config-status` (authenticated) |

---

## 2. Prerequisites

- A **running, `Ready` CodeMaster deployment** (the two bootstrap secrets provisioned, migrations
  applied). See [`first-deploy.md`](./first-deploy.md).
- An **HTTPS ingress / route** that can receive GitHub webhooks (`https://<your-host>/v1/github/webhook`).
  Locally, a tunnel (smee.io / ngrok) stands in for the ingress — see [`../RUN-LOCAL.md`](../RUN-LOCAL.md).
- **Admin access** to your GitHub org (or GitHub Enterprise Server) to create + install a GitHub App.
- **LLM credentials** — an Anthropic API key, or AWS Bedrock access (region + credentials).
- *(Optional)* Confluence Cloud or Server/DC with an API token, for knowledge-augmented reviews.

---

## 3. First login + admin access

1. Open the CodeMaster UI at your ingress host. (The admin/auth surface is gated by
   **`CODEMASTER_AUTH_ROUTES_ENABLED`** — it must be **enabled** for the UI to exist; the local no-Vault
   boot in `RUN-LOCAL.md` deliberately turns it *off*.)
2. Log in with the bootstrapped super-admin: **username `admin`, password `admin`**. Created on first
   boot, never clobbered afterward.
3. **Change the password immediately** — the pod logs a loud warning while the default is in use.

**Roles** (authoritative precedence, high → low):

```
super_admin > platform_owner > platform_operator > knowledge_curator > security_auditor > org_owner > reader
```

- **`super_admin`** is the bootstrapped account; it exists **only** as a `core.local_users` row (never an
  LDAP group / role grant) and is the implicit highest privilege.
- The other roles are assigned via role grants. An LDAP/SSO group→role mapping exists
  (`codemaster-admin-<role>` group names map to the role of the same name) for deployments that wire
  SSO. Integration config (GitHub/LLM/Confluence/embedder) requires `platform_owner`/`super_admin`.
- **CSRF**: the UI uses double-submit — `GET /api/auth/csrf` → token, sent as `x-csrf-token` on mutating
  requests with the session cookie. (Relevant only if you script the API.)

---

## 4. GitHub integration (the core)

Two halves: **(A)** create + install a GitHub App, **(B)** enter its three credentials into CodeMaster.

### 4.1 Create the GitHub App

On GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App** (org-level:
`https://github.com/organizations/<ORG>/settings/apps/new`). For **GitHub Enterprise Server**, do this on
your GHE instance — CodeMaster supports a configurable GitHub host/API base URL (default `github.com`;
set the host via chart values / env — see `deploy-contract.md`).

- **GitHub App name** — e.g. `CodeMaster Reviewer`.
- **Homepage URL** — any valid URL (your CodeMaster host is fine).
- **Webhook**
  - **Active**: ✓.
  - **Webhook URL**: `https://<your-host>/v1/github/webhook` — note the exact path **`/v1/github/webhook`**.
  - **Webhook secret**: generate one and **save it** — you'll enter the same value into CodeMaster.
    Example: `openssl rand -hex 32`. CodeMaster verifies every delivery's `X-Hub-Signature-256` HMAC
    against this secret and rejects mismatches.
  - **Content type**: `application/json`.
  - **SSL verification**: **Enable** (the default).
- **Where can this GitHub App be installed?** — "Only on this account" for a single org; "Any account"
  if you'll install it across orgs (one App + key serves many installations — see §4.5).

### 4.2 Set the App permissions

Under **Permissions → Repository permissions**, set exactly these (least privilege):

| Permission | Level | Why |
|---|---|---|
| **Contents** | **Read-only** | Clone the repo to analyze the diff |
| **Pull requests** | **Read & write** | Post the review + inline comments, the fix-prompt comment, and the PR-description summary |
| **Metadata** | **Read-only** | Mandatory for all GitHub Apps |
| **Checks** | **Read & write** | Post the review as a Check Run on the PR (always `neutral` conclusion) |

> **Two gotchas:**
> - **Checks: Read & write is easy to miss.** Without it the review still posts (as a PR review +
>   comments), but the Check Run step fails non-fatally (`post_check_run failed; review already
>   delivered`). Grant it for the Check Run.
> - The **fix-prompt** is posted via the PR's issue-comments endpoint
>   (`POST /repos/{o}/{r}/issues/{n}/comments`); **Pull requests: Read & write covers it** (verified) — no
>   separate "Issues" permission is required.

### 4.3 Subscribe to events

Under **Subscribe to events**, check **Pull request**. That's the only event needed. CodeMaster acts on:

- **`opened`**, **`reopened`**, **`synchronize`** (new commits) → a review is allocated.
- **`ready_for_review`** → the trigger for a PR opened as a **draft** (drafts are **not** reviewed until
  marked ready).

### 4.4 Generate the private key + note the App ID

- **Private keys → Generate a private key** → GitHub downloads a `.pem` (this is `private_key_pem`).
- Note the **App ID** (a number) at the top of the App settings page (this is `app_id`).

### 4.5 Install the App

- **Install App → choose your org →** **All repositories** or **Only select repositories** (the repos to
  review).
- You don't record an installation id: CodeMaster authenticates as the App (shared `app_id` + key) and
  derives the **per-org installation id automatically from each webhook's `installation.id`**, so one App
  serves many orgs (see [`../adr/0073-per-review-github-installation-routing.md`](../adr/0073-per-review-github-installation-routing.md)).

### 4.6 Enter the credentials into CodeMaster

**Via the UI** — `/admin/setup` → **GitHub** form:

| Field | Value |
|---|---|
| **App ID** | the numeric App ID (§4.4) |
| **Private key (PEM)** | the full `.pem` contents incl. the `-----BEGIN/END-----` lines |
| **Webhook secret** | the exact secret from §4.1 |

Save → `POST /api/admin/github-config` → stored field-encrypted in `core.github_app_settings`.

**Or via Vault** (read-only is fine; CodeMaster only reads it). Seed once with the maintainer's Vault
admin token:

```bash
vault kv put secret/codemaster/github/app \
  app_id="123456" \
  private_key_pem=@codemaster-reviewer.private-key.pem \
  webhook_secret="$(openssl rand -hex 32)"
```

**Or via env**: provided through your secret source (see `deploy-contract.md`). Resolution is **DB > env > Vault**.

### 4.7 Verify GitHub end-to-end

1. Open (or reopen) a PR on an installed repo; if it's a draft, mark it **ready for review**.
2. Within ~1–2 minutes a review + inline comments + a Check Run appear on the PR.
3. GitHub → **App → Advanced → Recent Deliveries** shows each webhook + its response. A `2xx` = accepted;
   a `401`/`400` points at a webhook-secret/signature mismatch — click the delivery to see the request
   headers (`X-Hub-Signature-256`) and the response body.

---

## 5. LLM provider (the reviewer)

Without an LLM, no reviews are produced. Configure on **`/admin/llm`**.

### 5.1 Providers

`/admin/llm` supports a **Primary** and an optional **Secondary** provider (configured independently for
failover/secondary routing). Each provider's `provider` value is one of:

- **`anthropic_direct`** — the Anthropic API. Supply the **API key**.
- **`bedrock`** — AWS Bedrock. Supply the **region** + AWS credentials/endpoint.

Use **Test credentials** (`/api/admin/llm-provider-config/test-credentials`) and the **preflight**
(`/preflight`) before saving (`POST /api/admin/llm-provider-config`) — they validate and surface a clear
error rather than failing mid-review. (Default to the latest, most capable Claude models.)

### 5.2 Model catalog + purpose (job) routing

- **Model catalog** (`/api/admin/llm-models`) — the models available to the providers.
- **Job/purpose routing** (`/api/admin/llm-purpose-routing`) — maps each review **purpose** to a model.
  The routing UI assigns the **4 executable purposes**:
  - **`review_finding`** — the core PR review,
  - **`walkthrough`** — the PR walkthrough/summary,
  - **`analysis_curator`** — the curator/reranker stage,
  - **`fix_prompt`** — the suggested-fix prompt.

  (The GET reads a fuller 8-value purpose vocabulary for back-compat, but only these four are
  assignable — assigning any other persists a no-op pin no consumer reads.)

### 5.3 Cost-control note

LLM spend is metered and **capped** (see §8). If a cap is hit, reviews fail closed — a budget issue, not
an LLM-config issue.

---

## 6. Embedder (semantic retrieval)

The embedder produces the vectors for code/knowledge retrieval (incl. Confluence RAG). Configure on
**`/admin/llm` → the Embedding tab** (`EmbedderConfigCard`).

### 6.1 Provider

Two modes (`CODEMASTER_EMBEDDINGS_PROVIDER`):

- **`platform`** (default) — the built-in platform embedder.
- **`openai_compat`** — point at any **OpenAI-compatible** embeddings server. The Embedding-tab card owns
  the **Base URL**, **model**, and an **optional API key** (e.g. Ollama / vLLM / a hosted endpoint). Use
  **Test** (`/api/admin/embedder-config/test`) to validate, then Save (`POST /api/admin/embedder-config`)
  → stored field-encrypted in `core.embedder_provider_settings`.

### 6.2 Embedding dimension — set ONCE, before ingesting

- `CODEMASTER_EMBEDDING_DIMENSION` (default **1024**) drives the runtime `EMBEDDING_DIM`.
- For a **non-1024** model, size the (empty) pgvector columns once against the owner/migration DSN:
  `npm run set-embedding-dimension -- <N>` (refuses to run against a non-empty corpus — greenfield only).
- pgvector's HNSW index caps at **2000 dimensions** — a native >2000 model must output ≤2000 (Matryoshka
  truncation).
- Changing the dimension *after* ingesting is a day-2 **blue/green re-embed**, via the lifecycle
  endpoints (`/api/admin/embedder/reembed/{start,status,validate,activate,rollback,cancel,…}`) and the
  Embedding-tab lifecycle panel.

---

## 7. Confluence (optional knowledge corpus / RAG)

Optional; lets reviews cite your team's documented standards. Configure creds on **`/admin/setup`**
(Confluence form), then manage spaces + governance under **`/admin/confluence/*`**.

### 7.1 Credentials

`/admin/setup` → **Confluence** form (`POST /api/admin/confluence-config`, with a **Test** button →
`/api/admin/confluence-config/test`):

| Field | Cloud | Server / Data Center |
|---|---|---|
| **Base URL** | must end in **`/wiki`** (e.g. `https://your-org.atlassian.net/wiki`) | your instance base URL |
| **API token** | an Atlassian API token | a Personal Access Token (sent as **Bearer**) |

For **Cloud**, the auth also needs the Atlassian **account email**, which selects Cloud-style **Basic**
auth — it is supplied via **`CODEMASTER_CONFLUENCE_AUTH_EMAIL`** (env) and is forwarded by the
connectivity test. With an email present → Basic auth (Cloud); without → Bearer (Server/DC). The
**`/wiki`** suffix on a Cloud base URL is required or the v2 API 404s.

> Vault equivalent (read-only seed): `secret/codemaster/confluence/token` keys `base_url`, `token`.

### 7.2 Add spaces + ingest

Add the space(s) via the spaces UI (`/api/admin/integrations/confluence-spaces`). Ingestion runs on a
schedule (and on demand): pages are chunked, embedded (§6), and stored for retrieval.

### 7.3 Governance — default corpus vs label-scoped, and per-page approval

- A page labeled **`default`** is destined for the **default corpus** (consulted on *every* review). To
  protect it, a `default`-labeled page must be **explicitly approved** before its chunks are stored/used
  — enforced by a DB invariant (a default chunk exists **iff** an approval exists).
- **Non-default** labels are **label-scoped** — used only when a review's scope matches.

**Approving a default page** (`/admin/confluence/spaces/{integration_id}/pages`): the view lists the
space's **live** pages from Confluence (so even never-ingested pages appear) with a lifecycle chip
(`not_ingested`/`ingested` × `none`/`approved`/`revoked`). Approve → CodeMaster records the approval and
dispatches a resync → the page is fetched, chunked, embedded, stored → now citable (e.g. `SEP/<page_id>`).
Supporting views: **`/admin/confluence/default-corpus`**, **`taxonomy-gaps`**, **`quarantined-chunks`**.

---

## 8. Cost caps (budget enforcement)

LLM spend is metered and enforced **fail-closed**. Configure on **`/cost-caps`** (`/api/admin/cost-caps`,
`/settings`, `/changes`).

- **First-time setup**: if no caps exist, the page shows a first-time setup card to bootstrap defaults.
- **Defaults** (editable): **global $5,000/day** (`DEFAULT_GLOBAL_CAP_CENTS = 500_000`), **per-org
  $1,000/day** (`DEFAULT_PER_ORG_CAP_CENTS = 100_000`), plus a configurable **hard ceiling**. When a cap
  is reached, further LLM calls fail closed (reviews stop until the next window or a cap change).
- **Per-org overrides** raise/lower a specific org's cap; **pending changes** (`/changes`) gate cap edits
  before they apply. The page shows **today's spend** + **projected** spend so you can see headroom.

---

## 9. What a review actually does (so you know what's optional)

When a PR triggers a review, the pipeline clones the repo and runs **static-analysis tools** —
`ruff`, `gitleaks`, `eslint` — alongside the LLM review. These tools **fail open if absent**: they're
spawned only during a review and a missing binary degrades gracefully (no Tier-1 linter findings) rather
than failing the review. They are **not** something you configure; they ship with the runtime image. The
review then retrieves relevant code/knowledge (embedder + Confluence), runs the LLM passes (§5.2), and
posts the review + inline comments + fix-prompt + Check Run + PR-description summary.

---

## 10. Verify end-to-end + troubleshooting

### 10.1 The config checklist

`/admin/setup` shows every integration's status + source. Same data via API:

```bash
# CSRF + login first if scripting; then:
curl -s -b cookies.txt https://<your-host>/api/admin/config-status | jq
# →
# {
#   "schema_version": 1,
#   "github":     { "configured": true,  "source": "db" },
#   "llm":        { "configured": true,  "source": "db" },
#   "confluence": { "configured": false, "source": null },
#   "embedder":   { "configured": true,  "source": "env" }
# }
```

Aim for GitHub + LLM configured at minimum; embedder + Confluence enable retrieval-augmented reviews;
cost caps gate spend.

### 10.2 Health checks

```bash
curl -s https://<your-host>/healthz   # liveness + dependency status
curl -s https://<your-host>/readyz    # → {"ready":true,"reason":null}
curl -s https://<your-host>/version
```

### 10.3 The end-to-end smoke (worked example)

```
1. Open PR #42 on an installed repo (or mark a draft "ready for review").
2. GitHub delivers a `pull_request` webhook → CodeMaster returns 2xx (see Recent Deliveries).
3. ~1–2 min later, on the PR you see:
     - a Review with inline comments,
     - a Check Run "CodeMaster" (conclusion: neutral),
     - a fix-prompt comment, and an updated PR-description summary.
```

### 10.4 Common issues

| Symptom | Likely cause / fix |
|---|---|
| **Pod `Ready` but no reviews** | GitHub not configured (`/admin/setup`), webhook not reaching the ingress, or webhook-secret mismatch. Check GitHub → App → Recent Deliveries. |
| **Webhook deliveries return `401`/`400`** | Webhook-secret mismatch (re-enter in `/admin/setup`) or missing `X-GitHub-Event`. |
| **Review posts but no Check Run** | App missing **Checks: Read & write** (§4.2). Non-fatal; grant it. |
| **`✗ Connectivity test isn't available`** (Confluence/embedder) | Probe adapter not wired in this build, or creds not saved yet. Save creds first. |
| **Confluence test 404 / fails (Cloud)** | Base URL must end in **`/wiki`**, and `CODEMASTER_CONFLUENCE_AUTH_EMAIL` must be set (Basic auth). |
| **No reviews after a cost-cap change** | A cap may be hit (fail-closed). Check `/cost-caps` today's spend vs the cap. |
| **Embedding errors / empty retrieval** | The configured dimension must match the model's and be set **before** ingesting (§6.2). |
| **LLM credential errors** | Use `/admin/llm` → Test credentials / preflight; fix the key/region before saving. |
| **Admin UI / login missing entirely** | `CODEMASTER_AUTH_ROUTES_ENABLED` is off (§3). |

---

## Appendix A — Admin endpoint reference

| Area | Endpoints |
|---|---|
| Config status | `GET /api/admin/config-status` (authenticated) |
| GitHub | `GET/POST /api/admin/github-config` |
| LLM | `GET/POST /api/admin/llm-provider-config` · `/preflight` · `/test-credentials` · `GET/POST /api/admin/llm-models` · `GET/POST/PUT /api/admin/llm-purpose-routing` |
| Embedder | `GET/POST /api/admin/embedder-config` · `/test` · `GET /api/admin/embedder/{state,coverage}` · `/api/admin/embedder/reembed/{start,status,validate,activate,rollback,cancel,manual-retire,gc}` · `/retrieval-mode` |
| Confluence | `GET/POST /api/admin/confluence-config` · `/test` · `/api/admin/integrations/confluence-spaces` (+ `/{id}/pages`, `/{id}/pages/{page_id}/approval`) |
| Cost caps | `GET /api/admin/cost-caps` · `/settings` · `/changes` |
| Webhook (GitHub → CodeMaster) | `POST /v1/github/webhook` |
| Health | `GET /healthz` · `GET /readyz` · `GET /version` |

## Appendix B — Secret/config sources

**Vault is read-only**: CodeMaster only *reads* these paths; UI-saved secrets are written to the
`core.*_settings` / `core.auth_secrets` tables (field-encrypted), never to Vault. Resolution is
**DB (UI) > env > Vault**.

| Secret | Vault path | Keys | DB table (UI source) | Blocks boot? |
|---|---|---|---|---|
| Postgres DSN | `codemaster/postgres/app` | `dsn` | — | **yes** |
| Postgres maint DSN | `codemaster/postgres/maint` | `dsn` | — | no |
| Field-encryption keyset | `codemaster/field-encryption/keys` | (whole secret) | — | **yes** |
| GitHub App | `codemaster/github/app` | `app_id`, `private_key_pem`, `webhook_secret` | `core.github_app_settings` | no |
| Confluence | `codemaster/confluence/token` | `base_url`, `token` | `core.confluence_settings` | no |
| API auth | `codemaster/api/auth` | `session_signing_key`, `csrf_secret` (auto-gen → DB if unset) | `core.auth_secrets` | no |
| LLM / embedder | (n/a — DB/env) | — | `core.llm_provider_settings`, `core.embedder_provider_settings` | no |

**Key config env**:

```bash
# Bootstrap (blocking)
CODEMASTER_PG_CORE_DSN=postgresql://user:pass@pg-host:5432/codemaster
CODEMASTER_FIELD_ENCRYPTION_KEYSET='{"current_version":"v1","keys":{"v1":"<base64-32-byte-key>"}}'

# Auth + runtime
CODEMASTER_AUTH_ROUTES_ENABLED=true      # gates the whole admin/auth surface
CODEMASTER_RUNTIME_MODE=postgres         # postgres | shadow (default postgres)

# Optional integration env (else configure in the UI)
CODEMASTER_EMBEDDINGS_PROVIDER=openai_compat   # platform | openai_compat
CODEMASTER_EMBEDDING_DIMENSION=1024            # set ONCE before ingesting
CODEMASTER_CONFLUENCE_AUTH_EMAIL=you@org.com   # enables Cloud Basic auth
```

Example Vault seed (run once by a Vault admin; CodeMaster reads these read-only):

```bash
vault kv put secret/codemaster/postgres/app dsn='postgresql://user:pass@pg-host:5432/codemaster'
printf '%s' "$KEYSET" | vault kv put secret/codemaster/field-encryption/keys -
vault kv put secret/codemaster/github/app app_id=123456 private_key_pem=@app.pem webhook_secret=...
vault kv put secret/codemaster/confluence/token base_url=https://org.atlassian.net/wiki token=...
```

## Appendix C — Related docs

- [`first-deploy.md`](./first-deploy.md) — the deployment procedure (Helm, bootstrap secrets, Postgres).
- [`deploy-contract.md`](./deploy-contract.md) — the authoritative, machine-checked contract.
- [`../RUN-LOCAL.md`](../RUN-LOCAL.md) — run locally on macOS, incl. a real PR review via a webhook tunnel.
- [`../adr/0073-per-review-github-installation-routing.md`](../adr/0073-per-review-github-installation-routing.md) — how one App serves many org installations.
