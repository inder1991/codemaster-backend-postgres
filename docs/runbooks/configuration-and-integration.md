# CodeMaster — Configuration & Integration Guide

This is the end-to-end guide for configuring CodeMaster and wiring it to every external system it
talks to: **GitHub** (the PR-review trigger + clone + posting), the **LLM provider** (the reviewer),
the **embedder** (semantic retrieval), **Confluence** (the optional knowledge corpus), **cost caps**
(budget enforcement), and **admin auth**. It explains both sides of every integration — *what you
configure on the third-party side* and *what you enter in the CodeMaster admin UI* — plus the env/Vault
equivalents.

It is written to be self-contained. For the pure *deployment* procedure (Helm, the two bootstrap
secrets, Postgres) see [`first-deploy.md`](./first-deploy.md); for the authoritative machine-checked
contract of every secret/extension/schema see [`deploy-contract.md`](./deploy-contract.md). This guide
references both but repeats what you need so you don't have to jump around.

---

## 1. Mental model — how configuration works

Read this first; it explains *why* the steps below are shaped the way they are.

### 1.1 Two bootstrap secrets gate boot — everything else is configured *after*

CodeMaster's "turnkey promise": the pod comes up on **only two secrets**:

1. **`CODEMASTER_PG_CORE_DSN`** — the application Postgres DSN.
2. **The field-encryption keyset** (`CODEMASTER_FIELD_ENCRYPTION_KEYSET`) — the root of trust that
   encrypts every secret you later save from the UI.

Everything else — **GitHub, LLM, embedder, Confluence, cost caps** — is **non-blocking**. The pod
boots `Ready` without them and you configure them afterward from the admin UI. A first deploy can
therefore never be blocked on integration config, and you can't get a "Ready but silently does
nothing" pod from a missing integration.

### 1.2 Three configuration sources, one precedence: **DB > env > Vault**

Every feature secret can be supplied three ways, and the runtime resolves each one independently in
this order:

| Source | How it's set | When to use |
|---|---|---|
| **DB (UI)** | Saved from the admin UI; stored in Postgres, **encrypted with the field key** | The normal path — operators configure live, no redeploy |
| **env** | `CODEMASTER_*` environment variables | CI / scripted / 12-factor deployments |
| **Vault** | KV-v2 secrets under `codemaster/*`, read via the pod's ServiceAccount | Centralized secret management |

**DB wins over env wins over Vault.** So a value saved in the UI overrides the same value in env or
Vault. `GET /api/admin/config-status` (and the unauthenticated `/config-status`) report, per
integration, whether it is configured and **from which source**.

### 1.3 The field-encryption key is the root of trust

Every secret you save through the UI (GitHub key, LLM key, Confluence token, …) is encrypted with the
field-encryption keyset (AES-256-GCM envelope) before it touches the database. **If you lose this key,
all UI-saved secrets become unrecoverable** and must be re-entered. Back it up the moment you generate
it (see `first-deploy.md` §2). The session signing key and CSRF secret auto-generate and persist
(field-encrypted) on first boot if you don't pin them.

### 1.4 Where each integration is configured in the UI

| Integration | Admin UI page | Backend endpoint(s) |
|---|---|---|
| GitHub App | **`/admin/setup`** (GitHub form) | `GET/POST /api/admin/github-config` |
| LLM provider(s) | **`/admin/llm`** (Providers / Model catalog / Job routing tabs) | `/api/admin/llm-provider-config` (+ `/preflight`, `/test-credentials`), `/api/admin/llm-models`, `/api/admin/llm-purpose-routing` |
| Embedder | **`/admin/llm`** (Embedding tab) | `GET/POST /api/admin/embedder-config` (+ `/test`) |
| Confluence | **`/admin/setup`** (Confluence form) + **`/admin/confluence/*`** | `GET/POST /api/admin/confluence-config` (+ `/test`), `/api/admin/integrations/confluence-spaces` |
| Cost caps | **`/cost-caps`** | `/api/admin/cost-caps` (+ `/settings`, `/changes`) |
| Config status | **`/admin/setup`** checklist | `GET /api/admin/config-status` |

---

## 2. Prerequisites

- A **running, `Ready` CodeMaster deployment** (the two bootstrap secrets provisioned, migrations
  applied). See [`first-deploy.md`](./first-deploy.md).
- An **HTTPS ingress / route** that can receive GitHub webhooks (`https://<your-host>/v1/github/webhook`).
  Locally, a tunnel (smee.io / ngrok) stands in for the ingress — see [`../RUN-LOCAL.md`](../RUN-LOCAL.md).
- **Admin access** to your GitHub org (or GitHub Enterprise Server) so you can create + install a
  GitHub App.
- **LLM credentials** — an Anthropic API key, or AWS Bedrock access (region + credentials).
- *(Optional)* Confluence Cloud or Server/DC with an API token, if you want knowledge-augmented reviews.

---

## 3. First login + admin access

1. Open the CodeMaster UI at your ingress host.
2. Log in with the bootstrapped super-admin: **username `admin`, password `admin`**. The account is
   created on first boot and never clobbered afterward.
3. **Change the password immediately** — the pod logs a loud warning for as long as the default is in
   use.

**Auth model (for reference):**
- **Roles**: `reader`, `operator`, `owner`, `super_admin`, `security_auditor`. Integration config
  (GitHub/LLM/Confluence/embedder) requires `owner`/`super_admin`.
- **CSRF**: the UI uses double-submit — `GET /api/auth/csrf` returns a token; mutating requests send it
  as `x-csrf-token` alongside the session cookie. (The UI does this for you; relevant only if you script
  the API.)
- **Sessions** are signed with `api_auth.session_signing_key` (auto-generated + persisted if unset).

---

## 4. GitHub integration (the core)

This is what turns a pull request into a review. There are two halves: **(A)** create + install a
GitHub App, and **(B)** enter its three credentials into CodeMaster.

### 4.1 Create the GitHub App

On GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App** (org-level:
`https://github.com/organizations/<ORG>/settings/apps/new`). For **GitHub Enterprise Server**, do this
on your GHE instance instead — CodeMaster supports a configurable GitHub host/API base URL (default
`github.com`; set the host via chart values / env for GHE — see `deploy-contract.md`).

Fill in:

- **GitHub App name** — e.g. `CodeMaster Reviewer`.
- **Homepage URL** — any valid URL (your CodeMaster host is fine).
- **Webhook**
  - **Active**: ✓ checked.
  - **Webhook URL**: `https://<your-host>/v1/github/webhook` — note the exact path **`/v1/github/webhook`**.
  - **Webhook secret**: generate a strong random secret and **save it** — you'll enter the same value
    into CodeMaster. e.g. `openssl rand -hex 32`. CodeMaster verifies every delivery's
    `X-Hub-Signature-256` HMAC against this secret and rejects mismatches.
  - **Content type**: `application/json`.

### 4.2 Set the App permissions

Under **Permissions → Repository permissions**, set exactly these (least privilege):

| Permission | Level | Why |
|---|---|---|
| **Contents** | **Read-only** | Clone the repo to analyze the diff |
| **Pull requests** | **Read & write** | Post the review, inline comments, the fix-prompt comment, and the PR-description summary |
| **Metadata** | **Read-only** | Mandatory for all GitHub Apps |
| **Checks** | **Read & write** | Post the review as a Check Run on the PR (always `neutral` conclusion) |

> **Checks: Read & write is easy to miss.** Without it the review still posts (as a PR review +
> comments), but the Check Run step fails (non-fatal — logged as `post_check_run failed; review
> already delivered`). Grant it to get the Check Run.

### 4.3 Subscribe to events

Under **Subscribe to events**, check **Pull request**. That's the only event needed. CodeMaster acts on
these PR actions:

- **`opened`**, **`reopened`**, **`synchronize`** (new commits pushed) → a review is allocated.
- **`ready_for_review`** → the trigger for a PR that was opened as a **draft** (drafts are **not**
  reviewed until marked ready).

### 4.4 Generate the private key + note the App ID

- After creating the App, scroll to **Private keys → Generate a private key**. GitHub downloads a
  `.pem` file — this is `private_key_pem`. Keep it secret.
- At the top of the App's settings page, note the **App ID** (a number) — this is `app_id`.

### 4.5 Install the App

- On the App page: **Install App → choose your org →** select **All repositories** or **Only select
  repositories** (the repos you want reviewed).
- You do **not** need to record the installation id. CodeMaster authenticates as the App (shared
  `app_id` + private key) and derives the **per-org installation id automatically from each webhook's
  `installation.id`** at review time, so one App serves many orgs/installations
  (see [`../adr/0073-per-review-github-installation-routing.md`](../adr/0073-per-review-github-installation-routing.md)).

### 4.6 Enter the credentials into CodeMaster

Go to **`/admin/setup`** → the **GitHub** form, and enter:

| Field | Value |
|---|---|
| **App ID** | the numeric App ID from §4.4 |
| **Private key (PEM)** | the full contents of the downloaded `.pem` (including the `-----BEGIN/END-----` lines) |
| **Webhook secret** | the exact secret you set in §4.1 |

Save. This `POST`s to `/api/admin/github-config` and stores all three field-encrypted in Postgres.
`/admin/setup`'s checklist will flip GitHub to *configured*.

**Equivalent non-UI sources** (same three keys; DB > env > Vault):
- **Vault** (KV-v2): path `codemaster/github/app`, keys `app_id`, `private_key_pem`, `webhook_secret`.
- **env**: provided via your secret source; see `deploy-contract.md`.

### 4.7 Verify GitHub end-to-end

1. Open (or reopen) a PR on an installed repo. If it's a draft, mark it **ready for review**.
2. Within ~1–2 minutes a CodeMaster review + inline comments + a Check Run should appear on the PR.
3. If nothing happens, see **Troubleshooting** (§9) — the usual causes are a webhook that isn't
   reaching the ingress, a secret mismatch, or GitHub not yet showing as configured.
4. GitHub's **App → Advanced → Recent Deliveries** shows each webhook and its response — a `2xx` means
   CodeMaster accepted it; a `401`/`400` points at a secret/signature problem.

---

## 5. LLM provider (the reviewer)

Without an LLM, no reviews are produced. Configure on **`/admin/llm`**.

### 5.1 Providers

`/admin/llm` supports a **Primary** and an optional **Secondary** provider (independent failover/secondary
routing). Each provider is **Anthropic** or **AWS Bedrock**:

- **Anthropic** — supply the **API key**.
- **AWS Bedrock** — supply the **region** + AWS credentials/endpoint.

Use **Test credentials** (`/api/admin/llm-provider-config/test-credentials`) and the **preflight**
(`/preflight`) before saving (`POST /api/admin/llm-provider-config`) — they validate the credentials and
surface a clear error rather than failing mid-review.

### 5.2 Model catalog + purpose routing

- **Model catalog** (`/api/admin/llm-models`) — the set of models available to the providers above.
- **Job/purpose routing** (`/api/admin/llm-purpose-routing`) — maps each review **purpose** to a model:
  - `review` — the core PR review,
  - `walkthrough` — the PR walkthrough/summary,
  - `fix-prompt` — the suggested-fix prompt.

  Point them at your chosen models (defaults to the latest, most capable Claude models is recommended).

### 5.3 Cost-control note

LLM spend is tracked and **capped** — see §7. If a cap is hit, reviews fail closed; that's a budget
issue, not an LLM-config issue.

---

## 6. Embedder (semantic retrieval)

The embedder produces the vectors used for code/knowledge retrieval (and Confluence RAG). Configure on
**`/admin/llm` → the Embedding tab** (the `EmbedderConfigCard`).

### 6.1 Provider credentials

The card owns the **Base URL**, the **model**, and an **optional API key**. CodeMaster speaks the
**OpenAI-compatible** embeddings API, so any compatible server works (e.g. Ollama, vLLM, a hosted
endpoint). Use **Test** (`/api/admin/embedder-config/test`) to validate, then Save (`POST
/api/admin/embedder-config`); creds are stored field-encrypted in Postgres.

- env equivalent: `CODEMASTER_EMBEDDINGS_PROVIDER` = `platform` (default) | `openai_compat`.

### 6.2 Embedding dimension — set ONCE, before ingesting

The dimension must match your model and is fixed for the corpus:

- `CODEMASTER_EMBEDDING_DIMENSION` (default **1024**) drives the runtime `EMBEDDING_DIM`.
- For a **non-1024** model you also size the (empty) pgvector columns once, against the owner/migration
  DSN: `npm run set-embedding-dimension -- <N>`. It refuses to run against a non-empty corpus
  (greenfield only).
- pgvector's HNSW index caps at **2000 dimensions** — a native >2000 model must output ≤2000
  (Matryoshka truncation).

Changing the dimension *after* content is ingested is a **day-2 blue/green re-embed** operation, exposed
via the embedder lifecycle endpoints (`/api/admin/embedder/reembed/{start,status,validate,activate,rollback,…}`)
and the Embedding-tab lifecycle panel — not a value you flip in place.

---

## 7. Confluence (optional knowledge corpus / RAG)

Confluence is optional; it lets reviews cite your team's documented standards. Configure creds on
**`/admin/setup`** (Confluence form), then manage spaces + governance under **`/admin/confluence/*`**.

### 7.1 Credentials

`/admin/setup` → **Confluence** form (`POST /api/admin/confluence-config`, with a **Test** button →
`/api/admin/confluence-config/test`):

| Field | Cloud | Server / Data Center |
|---|---|---|
| **Base URL** | must end in **`/wiki`** (e.g. `https://your-org.atlassian.net/wiki`) | your instance base URL |
| **Auth email** | the Atlassian account email (enables **Basic** auth) | leave empty |
| **API token** | an Atlassian API token | a Personal Access Token (used as **Bearer**) |

> The presence of **Auth email** is what selects Cloud-style **Basic** auth vs Server/DC **Bearer**.
> For Cloud, the **`/wiki`** suffix on the base URL is required or the v2 API calls 404.
> Vault equivalent: path `codemaster/confluence/token`, keys `base_url`, `token` (+ email for Cloud).

### 7.2 Add spaces

Add the Confluence space(s) to ingest via the spaces UI (`/api/admin/integrations/confluence-spaces`).
Ingestion runs on a schedule (and on demand). Pages are chunked, embedded (§6), and stored for
retrieval.

### 7.3 Governance — default corpus vs label-scoped, and per-page approval

CodeMaster gates what becomes "always-on" knowledge:

- A page labeled **`default`** is destined for the **default corpus** (consulted on *every* review). To
  protect that corpus, a `default`-labeled page must be **explicitly approved** before its chunks are
  stored/used. This is enforced by a database invariant (a default chunk exists **iff** an approval
  exists).
- **Non-default** labels are **label-scoped** — stored and used only when a review's scope matches.

**Approving a default page** (the live-approval flow):
`/admin/confluence/spaces/{integration_id}/pages` lists the space's **live** pages (fetched from
Confluence, so even never-ingested pages appear) with a lifecycle chip
(`not_ingested` / `ingested` × `none` / `approved` / `revoked`). Approve a page → CodeMaster records the
approval and dispatches a page-resync → the page is fetched, chunked, embedded, and stored → it's now in
the default corpus and citable (e.g. `SEP/<page_id>`).

Supporting views: **`/admin/confluence/default-corpus`** (what's approved), **`taxonomy-gaps`**,
**`quarantined-chunks`** (pages that repeatedly failed ingest).

---

## 8. Cost caps (budget enforcement)

LLM spend is metered and enforced **fail-closed**. Configure on **`/cost-caps`** (`/api/admin/cost-caps`,
`/settings`, `/changes`).

- **First-time setup**: if no caps exist, the page shows a first-time setup card to bootstrap defaults.
- **Caps** (all editable, set on first boot): a **global daily cap**, a **per-org default daily cap**,
  and a **hard ceiling**. Default global cap is **$5,000/day**. When a cap is reached, further LLM calls
  fail closed (reviews stop until the next window or a cap change).
- **Per-org overrides**: raise/lower a specific org's cap.
- **Pending changes**: cap changes flow through a change list (`/changes`) for review before they apply.
- The page also shows **today's spend** and **projected** spend so you can see headroom.

---

## 9. Verify end-to-end + troubleshooting

### 9.1 The config checklist

`/admin/setup` shows a checklist of every integration and whether it's configured (and from which
source). `GET /api/admin/config-status` is the same data via API. Aim for GitHub + LLM configured at
minimum; embedder + Confluence enable retrieval-augmented reviews; cost caps gate spend.

### 9.2 The end-to-end smoke

Open a PR on an installed repo (mark drafts ready) → expect a review + inline comments + a Check Run
within ~1–2 minutes.

### 9.3 Common issues

| Symptom | Likely cause / fix |
|---|---|
| **Pod `Ready` but no reviews** | GitHub not configured (`/admin/setup`), the webhook isn't reaching the ingress, or the webhook secret doesn't match. Check GitHub → App → Recent Deliveries. |
| **Webhook deliveries return `401`/`400`** | Webhook secret mismatch (re-enter in `/admin/setup`), or missing `X-GitHub-Event`. |
| **Review posts but no Check Run** | The App is missing **Checks: Read & write** (§4.2). Non-fatal; grant it. |
| **`✗ Connectivity test isn't available`** (Confluence/embedder) | The credential-probe adapter isn't wired in this build, or creds aren't saved yet. Save creds first; if it persists, the probe is a deploy-time follow-up. |
| **Confluence test 404 / fails (Cloud)** | Base URL must end in **`/wiki`**, and **Auth email** must be set (Basic auth) for Cloud. |
| **No reviews after a cost-cap change** | A cap may be hit (fail-closed). Check `/cost-caps` today's spend vs the cap. |
| **Embedding errors / empty retrieval** | The configured dimension must match the model's, and must be set **before** ingesting (§6.2). |
| **LLM credential errors** | Use `/admin/llm` → Test credentials / preflight; fix the key/region before saving. |

---

## Appendix A — Admin endpoint reference

| Area | Endpoints |
|---|---|
| Config status | `GET /api/admin/config-status` · public `GET /config-status` |
| GitHub | `GET/POST /api/admin/github-config` |
| LLM | `GET/POST /api/admin/llm-provider-config` · `/preflight` · `/test-credentials` · `GET/POST /api/admin/llm-models` · `GET/POST /api/admin/llm-purpose-routing` |
| Embedder | `GET/POST /api/admin/embedder-config` · `/test` · `GET /api/admin/embedder/{state,coverage}` · `/api/admin/embedder/reembed/{start,status,validate,activate,rollback,cancel,manual-retire,gc}` · `/retrieval-mode` |
| Confluence | `GET/POST /api/admin/confluence-config` · `/test` · `/api/admin/integrations/confluence-spaces` (+ `/{id}/pages`, `/{id}/pages/{page_id}/approval`) |
| Cost caps | `GET /api/admin/cost-caps` · `/settings` · `/changes` |
| Webhook (GitHub → CodeMaster) | `POST /v1/github/webhook` |
| Health | `GET /healthz` · `GET /readyz` · `GET /version` |

## Appendix B — Secret/config sources

Resolution is **DB (UI) > env > Vault** for every feature secret.

| Secret | Vault path | Keys | Blocks boot? |
|---|---|---|---|
| Postgres DSN | `codemaster/postgres/app` | `dsn` | **yes** |
| Postgres maint DSN | `codemaster/postgres/maint` | `dsn` | no |
| Field-encryption keyset | `codemaster/field-encryption/keys` | (whole secret) | **yes** |
| GitHub App | `codemaster/github/app` | `app_id`, `private_key_pem`, `webhook_secret` | no |
| Confluence | `codemaster/confluence/token` | `base_url`, `token` (+ email for Cloud) | no |
| API auth | `codemaster/api/auth` | `session_signing_key`, `csrf_secret` (auto-gen if unset) | no |

Key config env: `CODEMASTER_RUNTIME_MODE` (`postgres`|`shadow`, default `postgres`),
`CODEMASTER_EMBEDDINGS_PROVIDER` (`platform`|`openai_compat`), `CODEMASTER_EMBEDDING_DIMENSION`
(default `1024`).

## Appendix C — Related docs

- [`first-deploy.md`](./first-deploy.md) — the deployment procedure (Helm, bootstrap secrets, Postgres).
- [`deploy-contract.md`](./deploy-contract.md) — the authoritative, machine-checked secret/extension/schema/config contract.
- [`../RUN-LOCAL.md`](../RUN-LOCAL.md) — run locally on macOS, incl. a real PR review via a webhook tunnel.
- [`../adr/0073-per-review-github-installation-routing.md`](../adr/0073-per-review-github-installation-routing.md) — how one App serves many org installations.
