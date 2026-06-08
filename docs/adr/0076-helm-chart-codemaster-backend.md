# ADR-0076: Production Helm chart for codemaster-backend

- Status: Accepted
- Date: 2026-06-08
- Supersedes: the raw `deploy/local-kind/*.yaml` manifests as the deployment mechanism
  (those remain as the kind bootstrap for infra: pg / vault / temporal).

## Context

The TypeScript backend shipped to kind via hand-written manifests
(`deploy/local-kind/10-backend.yaml`): a ConfigMap carrying **cleartext secrets**
(`VAULT_TOKEN=devroot`, a Postgres DSN with the password inline — an invariant-3
violation), `imagePullPolicy: Never`, `replicas: 1`, TCP-only probes, no securityContext,
no ServiceAccount discipline, no PDB/HPA, and a migrate Job decoupled from rollout
ordering. That is a dev bootstrap, not a deployable artifact.

The app is a **single combined process** (`main.ts`): HTTP API + Temporal review worker +
outbox-dispatcher worker, fail-loud (`Promise.all`; if any leg rejects the pod exits). The
Python reference repo (`vendor/codemaster-py/helm/*`) splits this into many service charts
atop a `codemaster-common` library chart; that split does not apply here — one process means
one chart.

A pre-implementation investigation (6 file-cited readers) established the load-bearing facts:

- **Filesystem:** the process writes to exactly three paths —
  `CODEMASTER_WORKSPACE_ROOT` (`/var/lib/codemaster/workspaces`),
  `CODEMASTER_CLONE_CACHE_ROOT` (`/clone-cache`), and a `.codemaster-askpass` dir inside the
  workspace. Nothing writes to `/app`, `/tmp`, `/usr/local/bin`, or `$HOME`. → non-root +
  read-only rootfs is feasible with three `emptyDir` mounts.
- **Secrets are read two ways:** file secrets (GitHub App, field-encryption keys, auth
  secrets, Confluence token) read natively from `{secretsDir}/<sanitized>` in `agent-file`
  mode; but the **Postgres DSN / embedder key / Langfuse key are read from the environment**,
  not Vault.
- **Boot:** `/healthz` binds fast, `/readyz` is shallow; with auth routes enabled the boot
  does **blocking** Vault fetches → a generous startup probe is required.
- **Shutdown:** the Temporal SDK wires SIGTERM (drains in-flight activities); no explicit
  handler exists.
- **Observability:** there is **no Prometheus `/metrics` endpoint** (OTel exporter wiring
  deferred).

## Decision

Ship a **self-contained** chart at `deploy/helm/codemaster-backend/` (helpers inlined, no
cross-repo dependency on the frozen Python `codemaster-common`), honoring that chart's
conventions (standard labels/annotations, `RollingUpdate maxUnavailable:0/maxSurge:1`,
dedicated ServiceAccount with `automountServiceAccountToken:false`, hardened securityContext,
PDB anchored at an absolute `minAvailable`).

1. **Secrets via HashiCorp Vault Agent** (`vault.mode: agent`, the production default). File
   secrets get an **explicit per-secret template** `{{ .Data.data | toJSON }}` (the flat inner
   map `FileKvReader` expects, per ADR-0071) and are read natively in `agent-file` mode — the
   Agent built-in `json` default template was rejected because it renders the full KV-v2
   envelope `{"data":{…},"metadata":{…}}` and would make `FileKvReader` fail closed. Env
   secrets (PG DSN, …) are rendered single-quoted into a single `runtime-env` file the
   container entrypoint `source`s before `exec` — the standard Vault-Agent env pattern. The
   migrate hook uses `agent-pre-populate-only: "true"` (so the sidecar doesn't keep the Job
   alive) and `onlyEnv` (injects only the DSN, so its Vault role need not read the four app
   file secrets). Agent mode **also** sets `VAULT_ADDR` + injects the Agent token at
   `{secretsDir}/token` (`agent-inject-token`) because the field-encryption keyset is loaded
   over the Vault HTTP API at boot (it can't be agent-file-flattened). `token` mode (dev) and
   `external` mode (BYO via `extraEnv*`) are also supported. No secret ever lands in the ConfigMap.

2. **Hardened-by-default securityContext** — `runAsNonRoot:true / 1001`,
   `readOnlyRootFilesystem:true`, drop ALL capabilities, `seccomp: RuntimeDefault`. The
   `Dockerfile` is updated to add `USER 1001` + `$HOME` + chowns so this posture is real; the
   app's three writable paths are `emptyDir` mounts. The `values-kind.yaml` overlay relaxes to
   root + writable rootfs for the **current** dev image until it is rebuilt and rolled.

3. **Full configurability** — every app env var is a typed `values.yaml` knob; non-secret env
   flows through a ConfigMap (a checksum annotation rolls pods on change). A
   `values.schema.json` enforces enums/types; `NOTES.txt` prints loud pre-flight warnings when
   a required production value (Temporal address/namespace, embeddings config) is missing.

4. **Lifecycle** — `terminationGracePeriodSeconds: 300` so SIGTERM lets the worker drain
   in-flight reviews; a `preStop` sleep deregisters the endpoint first. Startup probe budgets
   the blocking Vault/tree-sitter/Temporal boot; liveness/readiness sized to the real timing.

5. **No `/metrics` scrape** — the chart adds no Prometheus port or annotation because the app
   exposes none; Langfuse tracing is optional with its key sourced from Vault.

6. **Out of scope (deliberate):** NetworkPolicy, egress rules, and service-mesh resources are
   **not** shipped by this chart (dev-phase scoping; owned elsewhere).

## Consequences

- The deployable artifact is now `helm upgrade --install`, version-controlled and reviewable;
  the cleartext-secret invariant-3 violation is eliminated in the production path.
- The hardened non-root default **requires the rebuilt image**; deploying the chart against
  the old root image needs the `values-kind.yaml` relaxation (or it may fail git's
  `$HOME`/passwd expectations under uid 1001).
- Operators must provision the Vault KV paths + a `codemaster-backend` Vault role/policy
  before an `agent`-mode install succeeds.
- Follow-ups: wire OTel exporters (then add a metrics port + scrape), and consider a real
  deep `/readyz` that reflects worker/Temporal readiness rather than just HTTP-listening.
