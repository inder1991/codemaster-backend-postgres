{{/*
_helpers.tpl — name, label, image, serviceAccount, securityContext and Vault-Agent
helpers for the codemaster-backend chart. Self-contained (no library-chart import).
*/}}

{{/* Chart name (overridable). */}}
{{- define "codemaster-backend.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully-qualified release name. */}}
{{- define "codemaster-backend.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* chart label value (name-version, '+' is illegal in a label). */}}
{{- define "codemaster-backend.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Image reference — digest wins over tag; one of the two is required. */}}
{{- define "codemaster-backend.image" -}}
{{- $repo := required "image.repository is required" .Values.image.repository -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" $repo .Values.image.digest -}}
{{- else -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- if not $tag }}{{ fail "image.tag or image.digest is required" }}{{ end -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end -}}

{{/* Selector labels — stable across releases (never add volatile values here). */}}
{{- define "codemaster-backend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "codemaster-backend.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Common labels for every object. */}}
{{- define "codemaster-backend.labels" -}}
helm.sh/chart: {{ include "codemaster-backend.chart" . }}
{{ include "codemaster-backend.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/component: backend
app.kubernetes.io/part-of: codemaster
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Common annotations (merged into every object's metadata). */}}
{{- define "codemaster-backend.commonAnnotations" -}}
{{- with .Values.commonAnnotations }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* ServiceAccount name. */}}
{{- define "codemaster-backend.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "codemaster-backend.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Name of the dev-only chart-managed Secret (token/dev mode). */}}
{{- define "codemaster-backend.devSecretName" -}}
{{- printf "%s-dev-secrets" (include "codemaster-backend.fullname" .) -}}
{{- end -}}

{{/* App container boot command (one fused container): per-secret-source DSN setup, then schema migration
     when migrate.enabled, then exec the app. Migrations run INSIDE the app container — NOT a separate
     Job/init — so the ServiceAccount (a normal resource) is always present and there is no pre-install
     hook ordering trap. migrate:up is idempotent + advisory-locked (concurrent replicas serialize; a
     container restart re-runs a cheap no-op). The vault-mode DSN setup mirrors the pre-fusion migrate
     hook: the separate assign + non-empty test + export is REQUIRED because `export VAR=$(cmd)` always
     exits 0 (the builtin's status, not the substitution's), which would mask a resolve_dsn failure. */}}
{{- define "codemaster-backend.bootScript" -}}
{{- if include "codemaster-backend.usesEnvWrapper" . }}
set -a
. {{ .Values.vault.secretsDir }}/runtime-env
set +a
{{- else if eq .Values.secretSource "vault" }}
set -e
CODEMASTER_PG_CORE_DSN="$(node apps/backend/src/resolve_dsn.js)"
test -n "$CODEMASTER_PG_CORE_DSN" || { echo "resolve_dsn returned an empty DSN" >&2; exit 1; }
export CODEMASTER_PG_CORE_DSN
{{- end }}
{{- if .Values.migrate.enabled }}
npm run migrate:up && exec node apps/backend/src/main.js
{{- else }}
exec node apps/backend/src/main.js
{{- end }}
{{- end -}}

{{/*
Pod-template annotations: Vault-Agent injection (when vault.mode == "agent").
Call with a dict: (dict "root" . "onlyEnv" false). onlyEnv=true injects ONLY the
env-secret (PG DSN) file — used by the migrate hook so its Vault role need not be
authorized for the four app file secrets (least privilege on the upgrade path).

Each file secret is rendered with an EXPLICIT per-secret template that emits the
JSON of `.Data.data` — exactly what the app's FileKvReader expects (ADR-0071).
NOT the Agent built-in `json` default template, which emits the full KV-v2
envelope `{"data":{...},"metadata":{...}}` and would make FileKvReader fail closed.
*/}}
{{- define "codemaster-backend.vaultAgentAnnotations" -}}
{{- $root := .root -}}
{{- $onlyEnv := default false .onlyEnv -}}
{{- with $root -}}
{{- if eq .Values.vault.mode "agent" -}}
vault.hashicorp.com/agent-inject: "true"
vault.hashicorp.com/role: {{ required "vault.agent.role is required in agent mode" .Values.vault.agent.role | quote }}
{{- /* Also render the Agent's own token to {secretsDir}/token for the field-encryption HTTP read. */ -}}
{{- "\n" -}}
vault.hashicorp.com/agent-inject-token: "true"
{{- "\n" -}}
vault.hashicorp.com/secret-volume-path: {{ .Values.vault.secretsDir | quote }}
{{- if not $onlyEnv }}
{{- range .Values.vault.agent.fileSecrets }}
{{- "\n" -}}
vault.hashicorp.com/agent-inject-secret-{{ .file }}: {{ .path | quote }}
{{- "\n" -}}
vault.hashicorp.com/agent-inject-template-{{ .file }}: |
  {{ printf "{{- with secret \"%s\" -}}{{ .Data.data | toJSON }}{{- end -}}" .path }}
{{- end }}
{{- end }}
{{- /* Env secrets (e.g. PG DSN): rendered into one sourced env-file `runtime-env`. Single-quoted so
       a password containing $ ` " or \\ is not interpreted by the sourcing shell. */ -}}
{{- if .Values.vault.agent.envSecrets }}
{{- "\n" -}}
vault.hashicorp.com/agent-inject-secret-runtime-env: {{ (first .Values.vault.agent.envSecrets).path | quote }}
{{- "\n" -}}
vault.hashicorp.com/agent-inject-template-runtime-env: |
{{- range .Values.vault.agent.envSecrets }}
  {{ printf "{{ with secret \"%s\" }}export %s='{{ .Data.data.%s }}'{{ end }}" .path .env .key }}
{{- end }}
{{- end }}
{{- with .Values.vault.agent.extraAnnotations }}
{{- "\n" -}}
{{ toYaml . }}
{{- end }}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* True (non-empty) when the container entrypoint must source the Vault env-file. */}}
{{- define "codemaster-backend.usesEnvWrapper" -}}
{{- if and (eq .Values.vault.mode "agent") .Values.vault.agent.envSecrets -}}
true
{{- end -}}
{{- end -}}

{{/* CODEMASTER_VAULT_SECRET_SOURCE derived from vault.mode. */}}
{{- define "codemaster-backend.vaultSecretSource" -}}
{{- if eq .Values.vault.mode "agent" -}}agent-file{{- else -}}vault-api{{- end -}}
{{- end -}}
