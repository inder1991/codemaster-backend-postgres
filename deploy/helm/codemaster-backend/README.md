# codemaster-backend Helm chart

Production Helm chart for the codemaster TypeScript backend — the **single combined pod**
that runs the HTTP API + the Temporal **review worker** + the **outbox-dispatcher** worker
in one fail-loud process (`apps/backend/src/main.ts`). The schema migration runs as a
**pre-install / pre-upgrade Helm hook**; secrets are injected by **HashiCorp Vault Agent**
(never cleartext).

Self-contained: no library-chart dependency, so it ships from this repo.

> Scope: this chart deliberately ships **no NetworkPolicy, egress rules, or service-mesh**
> resources — those are owned elsewhere / deferred to the production-bound phase.

## TL;DR

```sh
# Production (Vault Agent injected secrets, hardened non-root pod):
helm upgrade --install codemaster-backend deploy/helm/codemaster-backend \
  -n codemaster-backend --create-namespace \
  --set image.repository=nexus.acme.com/codemaster/codemaster-backend \
  --set image.digest=sha256:... \
  --set config.temporal.address=temporal-frontend.temporal.svc:7233 \
  --set config.temporal.namespace=codemaster

# Local kind (current root dev image, dev Vault token, in-cluster Temporal):
helm upgrade --install codemaster-backend deploy/helm/codemaster-backend \
  -n codemaster-backend -f deploy/helm/codemaster-backend/values-kind.yaml
```

## What you get

| Concern | Default |
|---|---|
| Workload | 1 Deployment (API + both workers), `replicaCount: 2` |
| Rollout | `RollingUpdate maxUnavailable:0 / maxSurge:1` + `PodDisruptionBudget minAvailable:1` (renders at ≥2 replicas) |
| Autoscaling | HPA (opt-in, `autoscaling.enabled`) |
| Drain | `terminationGracePeriodSeconds: 300` (Temporal drains in-flight reviews) + `preStop` sleep |
| Probes | startup `/healthz` (generous, covers Vault+tree-sitter+Temporal boot), readiness `/readyz`, liveness `/healthz` |
| Security | non-root `1001`, `readOnlyRootFilesystem`, drop ALL caps, `seccomp: RuntimeDefault`, SA token not mounted |
| Secrets | **Vault Agent** — file secrets read natively, env secrets (PG DSN) sourced from a rendered env-file |
| Config | every app env var is a `values.yaml` knob; non-secret env → ConfigMap (rolls pods on change) |
| Migration | `npm run migrate:up` as a pre-install/pre-upgrade hook (`agent-pre-populate-only`) |
| Validation | `values.schema.json` (enum/typed) + loud `NOTES.txt` pre-flight warnings |
| `helm test` | curls `/healthz` + `/readyz` through the Service |

## Secrets (no cleartext)

The app reads secrets two ways; the chart wires **both** via Vault Agent (`vault.mode: agent`):

1. **File secrets** — GitHub App key, field-encryption keys, auth (session/CSRF) secrets,
   Confluence token. The app reads them natively from `{vault.secretsDir}/<file>` in
   `agent-file` mode. The chart gives each an **explicit per-secret template**
   `{{ .Data.data | toJSON }}` (the flat inner map `FileKvReader` expects, per ADR-0071) —
   **not** the Agent built-in `agent-inject-default-template: json`, which renders the full
   KV-v2 envelope `{"data":{…},"metadata":{…}}` and makes `FileKvReader` fail closed.
   Configure via `vault.agent.fileSecrets[]`. `file` **must** equal the app's sanitized name
   (the KV logical path with every non-alphanumeric char → `_`), e.g.
   `secret/data/codemaster/github/app` → `codemaster_github_app`.
2. **Env secrets** — the **Postgres DSN** (`CODEMASTER_PG_CORE_DSN`), embedder API key,
   Langfuse key. The app reads these from the **environment**, so the Agent renders them
   into one `runtime-env` file (single-quoted `export VAR='…'` lines, shell-safe against
   `$`/backtick/`"`) which the container entrypoint `source`s before `exec`. Configure via
   `vault.agent.envSecrets[]`. (Caveat: a DSN containing a literal single quote is not
   supported by the sourced env-file.)

> **Field-encryption keyset:** even in agent mode the app loads the field-encryption keyset
> over the **Vault HTTP API** at boot (when `config.api.authRoutesEnabled=true`) because that
> nested payload can't be flattened to an agent-file. So agent mode **also requires**
> `vault.addr` to be set — the chart injects the Agent's token at `{vault.secretsDir}/token`
> (`agent-inject-token`) but the *address* must be in env.

### Vault prerequisites (agent mode)

Before an `agent`-mode install succeeds you must have, in Vault:

1. A Kubernetes-auth **role** named `vault.agent.role` (default `codemaster-backend`) bound to
   this release's ServiceAccount (`<fullname>`) in its namespace.
2. All KV-v2 **paths** populated with their expected keys: the four `fileSecrets` paths, plus
   each `envSecrets` path/key (default `secret/data/codemaster/postgres/app` key `dsn`). A
   missing path leaves the Agent init-container blocking the pod indefinitely (invisible to Helm).
3. The **Vault Agent Injector** mutating webhook installed in-cluster — otherwise the
   annotations are silently ignored and the pod boots with no secrets (fail-loud crashloop).

You must provision those before install. `NOTES.txt` warns on the Helm-visible gaps.

Other strategies:

- `vault.mode: token` — **dev/kind only.** `vault-api` mode with a static `VAULT_TOKEN`
  + DSN from a chart-managed (or `existingSecret`) Secret.
- `vault.mode: external` — the chart injects nothing; bring your own via
  `extraEnv` / `extraEnvFrom` / `extraVolumes` (e.g. external-secrets-operator
  syncing Vault → a K8s Secret).

## Security context & the image

Hardened by default: `runAsNonRoot:true`, `runAsUser:1001`, `readOnlyRootFilesystem:true`.
This requires an **image built from the updated `Dockerfile`** (adds `USER 1001` + `$HOME`
+ chowns; the app writes only to the three mounted scratch volumes, verified). The
`values-kind.yaml` overlay relaxes to root + writable rootfs so it works with the current
dev image until that image is rebuilt + rolled.

Writable scratch (the only paths the process writes) are `emptyDir` volumes:
`config.workspaceRoot`, `config.cloneCacheRoot`, and `/tmp` — sized via `scratch.*`.

## Observability

The app exposes **no Prometheus `/metrics` endpoint** (OTel exporter wiring is deferred),
so this chart adds **no scrape port / annotation** by design. Langfuse LLM tracing is
optional (`config.langfuse.*`); its API key is a secret (provision via `vault.agent.envSecrets`).

## Readiness & rollout caveat

`/readyz` is **shallow**: it returns Ready the instant the HTTP socket binds, which is
*before* the Temporal review worker connects and polls (the combined pod listens first, then
starts the workers). So "Ready" means *HTTP is up*, not *the review worker is live*. Because
the rollout uses `maxUnavailable:0`, the chart sets a tunable **`minReadySeconds` (default 20)**
so a new pod must survive the worker-connect window before the rollout advances — a time-based
proxy until the app exposes a worker-readiness seam. Liveness (`/healthz`) likewise only
detects a fully-wedged event loop, not a hung-but-alive worker (no `/metrics` yet).

## Migrations & recovery

`migrate:up` runs as a **pre-install / pre-upgrade hook**, so the app never starts against an
un-migrated schema. Down-migrations are **disabled by design** (forward-only). If the hook fails:

- The upgrade aborts and the release goes `FAILED` with the **prior Deployment still running** —
  the app keeps serving the old version.
- Recovery is **forward-only**: inspect the retained Job logs
  (`kubectl logs job/<release>-migrate`), fix the migration, and re-run `helm upgrade`.
- **Do not** `helm rollback` to "undo" schema — it won't (down is disabled). Destructive
  migrations archive rows at the SQL layer (`<table>_archive_<NNNN>`) per the repo's
  migration-safety convention, so they're recoverable there, not via Helm.

## Configuration

See `values.yaml` for the full annotated surface. Production deployments **must** set:
`image.repository` (+ `digest`/`tag`), `config.temporal.address`, `config.temporal.namespace`,
the embeddings provider config, and the Vault KV paths under `vault.agent`.

`NOTES.txt` prints loud pre-flight warnings when a required production value is missing.
