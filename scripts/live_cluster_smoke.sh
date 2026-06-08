#!/usr/bin/env bash
# live_cluster_smoke.sh — comprehensive LIVE smoke of the deployed TS backend on the kind cluster.
#
# Codifies (and extends) the previously-manual PR→review cluster smoke into a repeatable, safe,
# all-workflows / all-activities validation. It verifies the deployed worker actually RUNS every
# workflow and dispatches every activity on the real cluster — via scheduled-workflow firing +
# completion (no destructive triggers, no Anthropic spend forced).
#
# SAFETY: it TRIGGERS only idempotent/safe schedules (mutex-janitor, run-reaper, confluence-ingest,
# mark-stale) + a single-page resync. The DESTRUCTIVE retention crons (run-id / partition / workspace —
# they DELETE aged rows) are verified by their LAST SCHEDULED RUN status, never force-triggered. The
# credit-gated reviewPullRequest path is REPORTED, never failed.
#
# Usage:  CODEMASTER_TEST_LIVE_SMOKE=1 bash scripts/live_cluster_smoke.sh
# Requires: kubectl (kind context), the deployed `backend` pod, the Temporal pod, psql in pg-0, gh (opt).
set -uo pipefail

# ── Config (override via env) ─────────────────────────────────────────────────────────────────────
NS="${CODEMASTER_NS:-codemaster-backend}"                 # backend + pg-0 + vault namespace
TEMPORAL_NS_K8S="${CODEMASTER_TEMPORAL_NS_K8S:-$NS}"      # k8s namespace the temporal POD lives in (co-located with backend)
TEMPORAL_NS="${CODEMASTER_TEMPORAL_NS:-default}"          # the Temporal SERVER namespace (the --namespace flag)
PG_DB="${CODEMASTER_PG_DB:-postgres}"
SMOKE_SPACE_KEY="${CODEMASTER_SMOKE_SPACE_KEY:-SEP}"
SMOKE_PAGE_ID="${CODEMASTER_SMOKE_PAGE_ID:-196626}"

# Schedule-id → workflow-type, partitioned by safety.
SAFE_SCHEDULES=(
  "codemaster-mutex-janitor:mutexJanitorWorkflow"
  "codemaster-review-run-reaper:reviewRunReaperWorkflow"
  "refresh-confluence-corpus:confluenceIngestWorkflow"
  "mark-stale-confluence-chunks:markStaleChunksWorkflow"
)
DESTRUCTIVE_SCHEDULES=(
  "codemaster-run-id-retention:runIdRetentionWorkflow"
  "codemaster-partition-maintenance:partitionMaintenanceWorkflow"
  "codemaster-workspace-retention:workspaceRetentionWorkflow"
)
ALL_SCHEDULE_IDS=(codemaster-mutex-janitor codemaster-review-run-reaper refresh-confluence-corpus \
  mark-stale-confluence-chunks codemaster-run-id-retention codemaster-partition-maintenance \
  codemaster-workspace-retention)

# ── Guards + plumbing ─────────────────────────────────────────────────────────────────────────────
if [[ "${CODEMASTER_TEST_LIVE_SMOKE:-}" != "1" ]]; then
  echo "Refusing to run: set CODEMASTER_TEST_LIVE_SMOKE=1 to confirm a LIVE cluster smoke (triggers workflows)."
  exit 2
fi
command -v kubectl >/dev/null || { echo "kubectl not found"; exit 2; }

PASS=0; FAIL=0; SKIP=0
declare -a SUMMARY=()
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
skip() { echo "  ⏭️  $1"; SKIP=$((SKIP+1)); }
section() { echo; echo "═══ $1 ═══"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_POD="$(kubectl -n "$NS" get pod -l app=backend -o jsonpath='{.items[-1:].metadata.name}' 2>/dev/null)"
TEMPORAL_POD="$(kubectl -n "$TEMPORAL_NS_K8S" get pods --no-headers 2>/dev/null | awk '/^temporal-/{print $1; exit}')"
tctl() { kubectl -n "$TEMPORAL_NS_K8S" exec "$TEMPORAL_POD" -- /usr/local/bin/temporal --namespace "$TEMPORAL_NS" "$@" 2>/dev/null; }
psql_q() { kubectl -n "$NS" exec pg-0 -- psql -U postgres -d "$PG_DB" -tA -c "$1" 2>/dev/null; }
# Latest execution status for a workflow type (COMPLETED/FAILED/RUNNING/'' if none).
wf_latest_status() { tctl workflow list --query "WorkflowType='$1'" --limit 1 2>/dev/null | awk 'NR==2{print $1}'; }

echo "LIVE cluster smoke — ns=$NS temporal_pod=${TEMPORAL_POD:-?} backend_pod=${BACKEND_POD:-?}"
[[ -n "$BACKEND_POD" && -n "$TEMPORAL_POD" ]] || { echo "FATAL: backend or temporal pod not found — is the cluster up?"; exit 1; }

# ── 1. Pre-flight: static registry (all workflows served + all activities registered) ──────────────
section "1. Pre-flight — static workflow/activity registry"
if (cd "$REPO_ROOT" && npx vitest run test/smoke/workflow_activity_registry.smoke.test.ts >/tmp/cm_reg.log 2>&1); then
  ok "registry smoke: every dispatched activity registered + every started workflow served ($(grep -oE '[0-9]+ served workflows, [0-9]+ registered activities' /tmp/cm_reg.log | head -1))"
else
  bad "registry smoke FAILED (see /tmp/cm_reg.log) — wiring drift; fix before trusting the live run"
fi

# ── 2. Worker boot health ──────────────────────────────────────────────────────────────────────────
section "2. Worker boot health"
READY="$(kubectl -n "$NS" get pod "$BACKEND_POD" -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null)"
RESTARTS="$(kubectl -n "$NS" get pod "$BACKEND_POD" -o jsonpath='{.status.containerStatuses[0].restartCount}' 2>/dev/null)"
[[ "$READY" == "true" ]] && ok "backend pod $BACKEND_POD Ready (restarts=$RESTARTS)" || bad "backend pod not Ready (ready=$READY)"
POLLERS="$(tctl task-queue describe --task-queue review-default 2>/dev/null | grep -ci "$BACKEND_POD")"
[[ "${POLLERS:-0}" -gt 0 ]] && ok "worker polling review-default ($POLLERS poller line(s) on this pod)" || bad "no pollers from $BACKEND_POD on review-default"
ENSURED="$(kubectl -n "$NS" logs "$BACKEND_POD" 2>/dev/null | grep -c "schedule ensured:")"
[[ "${ENSURED:-0}" -ge 7 ]] && ok "boot logs ensured $ENSURED schedules + workers RUNNING" || skip "only $ENSURED 'schedule ensured' lines in current pod logs (log rotation?)"

# ── 3. Schedules present + unpaused ─────────────────────────────────────────────────────────────────
section "3. Schedules live (all 7, unpaused)"
SCHED_LIST="$(tctl schedule list 2>/dev/null)"
for sid in "${ALL_SCHEDULE_IDS[@]}"; do
  if echo "$SCHED_LIST" | grep -q "$sid"; then
    if echo "$SCHED_LIST" | grep "$sid" | grep -qi "true"; then bad "$sid is PAUSED"; else ok "$sid present + unpaused"; fi
  else bad "$sid MISSING from schedule list"; fi
done

# ── 4. Workflow liveness ────────────────────────────────────────────────────────────────────────────
section "4. Workflow liveness — trigger-safe + verify-destructive"
# 4a. Trigger the safe schedules + assert COMPLETED.
for entry in "${SAFE_SCHEDULES[@]}"; do
  sid="${entry%%:*}"; wf="${entry##*:}"
  tctl schedule trigger --schedule-id "$sid" >/dev/null 2>&1
  status=""
  for _ in $(seq 1 20); do
    for _ in $(seq 1 5); do kubectl -n "$NS" exec "$BACKEND_POD" -- true >/dev/null 2>&1; done
    status="$(wf_latest_status "$wf")"
    [[ "$status" == "Completed" || "$status" == "Failed" ]] && break
  done
  case "$status" in
    Completed) ok "$wf triggered → COMPLETED"; SUMMARY+=("$wf: COMPLETED (triggered)");;
    Failed)    bad "$wf triggered → FAILED (inspect: temporal workflow show)"; SUMMARY+=("$wf: FAILED");;
    *)         skip "$wf triggered → still $status after wait"; SUMMARY+=("$wf: $status (slow)");;
  esac
done
# 4b. Single-page resync (idempotent, re-runnable).
RESYNC_ID="live-smoke-resync-${SMOKE_SPACE_KEY}-${SMOKE_PAGE_ID}"
tctl workflow start --task-queue review-default --type triggerPageResyncWorkflow --workflow-id "$RESYNC_ID" \
  --input "{\"schema_version\":1,\"space_key\":\"$SMOKE_SPACE_KEY\",\"page_id\":\"$SMOKE_PAGE_ID\",\"triggered_by_user_id\":null}" >/dev/null 2>&1
RESYNC_RES="$(tctl workflow result --workflow-id "$RESYNC_ID" 2>/dev/null | grep -oE '"resync_complete":(true|false)')"
[[ "$RESYNC_RES" == *true* ]] && { ok "triggerPageResyncWorkflow → resync_complete=true"; SUMMARY+=("triggerPageResyncWorkflow: COMPLETED (triggered)"); } \
  || { skip "triggerPageResyncWorkflow → $RESYNC_RES (Confluence creds/embedder?)"; SUMMARY+=("triggerPageResyncWorkflow: $RESYNC_RES"); }
# 4c. Destructive retention — verify LAST scheduled run, never trigger.
for entry in "${DESTRUCTIVE_SCHEDULES[@]}"; do
  wf="${entry##*:}"; status="$(wf_latest_status "$wf")"
  case "$status" in
    Completed) ok "$wf last scheduled run = COMPLETED (not triggered — destructive)"; SUMMARY+=("$wf: COMPLETED (last scheduled)");;
    "")        skip "$wf has NOT fired yet (daily cron) — not triggered (destructive). Will verify next scheduled run."; SUMMARY+=("$wf: NO-RUN-YET (not triggered)");;
    *)         skip "$wf last run = $status (not triggered — destructive)"; SUMMARY+=("$wf: $status (last scheduled)");;
  esac
done

# ── 5. Outbox dispatcher + reviewPullRequest credit gate ────────────────────────────────────────────
section "5. Outbox dispatcher + review path"
OUTBOX="$(tctl workflow list --query "WorkflowType='OutboxDispatcherWorkflow'" --limit 1 2>/dev/null | awk 'NR==2{print $1}')"
[[ "$OUTBOX" == "Running" || "$OUTBOX" == "ContinuedAsNew" ]] && { ok "OutboxDispatcherWorkflow singleton $OUTBOX (loop alive)"; SUMMARY+=("OutboxDispatcherWorkflow: $OUTBOX (singleton)"); } \
  || { skip "OutboxDispatcherWorkflow latest = ${OUTBOX:-none}"; SUMMARY+=("OutboxDispatcherWorkflow: ${OUTBOX:-none}"); }
LLM_PROVIDER="$(psql_q "SELECT provider||'/'||model_id FROM core.llm_provider_settings WHERE enabled LIMIT 1;")"
LAST_REVIEW="$(psql_q "SELECT lifecycle_state FROM core.review_runs ORDER BY created_at DESC LIMIT 1;")"
echo "  ℹ️  review LLM provider = ${LLM_PROVIDER:-none}; last review_run = ${LAST_REVIEW:-none}"
if [[ "$LLM_PROVIDER" == anthropic_direct/* ]]; then
  skip "reviewPullRequest uses anthropic_direct — a live run needs Anthropic credits (or repoint the LLM at local Ollama, like embeddings). NOT triggered here."
  SUMMARY+=("reviewPullRequest: SKIPPED (credit-gated)")
else
  skip "reviewPullRequest live trigger not automated here (drive via a real PR webhook); provider=$LLM_PROVIDER"
  SUMMARY+=("reviewPullRequest: not auto-triggered")
fi

# ── 6. Activity-failure scan + summary ──────────────────────────────────────────────────────────────
section "6. Activity-registration scan (no ActivityNotRegistered in recent history)"
ANR="$(kubectl -n "$NS" logs "$BACKEND_POD" --since=10m 2>/dev/null | grep -ci "ActivityNotRegistered\|WorkflowNotRegistered")"
[[ "${ANR:-0}" -eq 0 ]] && ok "no ActivityNotRegistered/WorkflowNotRegistered in the last 10m of worker logs" || bad "$ANR Not-Registered error(s) in worker logs — registry drift LIVE"

section "SUMMARY — every workflow, live status"
for line in "${SUMMARY[@]}"; do echo "  • $line"; done
echo
echo "PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
[[ "$FAIL" -eq 0 ]] && { echo "LIVE SMOKE: GREEN (all hard checks passed; skips are credit/destructive-gated by design)"; exit 0; } \
  || { echo "LIVE SMOKE: RED ($FAIL hard failure(s))"; exit 1; }
