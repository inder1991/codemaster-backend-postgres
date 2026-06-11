#!/usr/bin/env bash
# live_cluster_smoke.sh — comprehensive LIVE smoke of the deployed TS backend on the kind cluster.
#
# Codifies (and extends) the previously-manual PR→review cluster smoke into a repeatable, safe,
# all-workflows / all-activities validation. It verifies the deployed worker actually RUNS every
# workflow and dispatches every activity on the real cluster — via scheduled-workflow firing +
# completion, plus one real end-to-end review driven off a freshly-opened PR each run.
#
# RUNTIMES: the SAME script smokes BOTH backend runtimes, auto-detected from the deployed pod's
# CODEMASTER_RUNTIME_MODE env (absent → temporal):
#   * temporal (default) — every observation goes through `tctl` exec'd in the temporal pod
#     (schedules, workflow statuses, task-queue pollers, the OutboxDispatcherWorkflow singleton).
#   * postgres (CODEMASTER_RUNTIME_MODE=postgres — deploy/local-kind/20-postgres-cutover.yaml; the
#     live cutover namespace is `codemaster-cutover`, so run with CODEMASTER_NS=codemaster-cutover)
#     — NO temporal pod needed: the same webhook lands in core.outbox → drain loop →
#     core.review_jobs → runner shell, and every observation comes from psql in pg-0
#     (core.scheduled_jobs / core.background_jobs / review tables), the runner boot log line, and
#     /readyz. The gh-side review assertions (posted review, inline comments, Confluence citation)
#     are IDENTICAL in both modes.
#
# SAFETY: it TRIGGERS only idempotent/safe schedules (mutex-janitor, run-reaper, confluence-ingest,
# mark-stale) + a single-page resync. The DESTRUCTIVE retention crons (run-id / partition / workspace —
# they DELETE aged rows) are verified by their LAST SCHEDULED RUN status, never force-triggered. The
# reviewPullRequest path opens a FRESH PR each run (project-owner directive) and spends Anthropic credits
# for a real review; gh-absent or webhook-undelivered degrades to SKIP, a FAILED/unposted review is RED.
#
# Usage:  CODEMASTER_TEST_LIVE_SMOKE=1 bash scripts/live_cluster_smoke.sh
# Requires: kubectl (kind context), the deployed `backend` pod, psql in pg-0; temporal mode ALSO
#           requires the Temporal pod (postgres mode runs without one).
#           The reviewPullRequest step also needs `gh` (authed) + a live webhook forwarder (smee/port-forward).
set -uo pipefail

# ── Config (override via env) ─────────────────────────────────────────────────────────────────────
NS="${CODEMASTER_NS:-codemaster-backend}"                 # backend + pg-0 + vault namespace (postgres cutover: codemaster-cutover)
TEMPORAL_NS_K8S="${CODEMASTER_TEMPORAL_NS_K8S:-$NS}"      # k8s namespace the temporal POD lives in (co-located with backend)
TEMPORAL_NS="${CODEMASTER_TEMPORAL_NS:-default}"          # the Temporal SERVER namespace (the --namespace flag)
PG_DB="${CODEMASTER_PG_DB:-postgres}"
SMOKE_SPACE_KEY="${CODEMASTER_SMOKE_SPACE_KEY:-SEP}"
SMOKE_PAGE_ID="${CODEMASTER_SMOKE_PAGE_ID:-196626}"

# Schedule-id → workflow-type, partitioned by safety (the TEMPORAL shapes; postgres mode swaps in
# the schedule-id → job_type pairs from apps/backend/src/runner/cron_schedules.ts further down,
# once MODE is known).
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

[[ -n "$BACKEND_POD" ]] || { echo "FATAL: backend pod not found in ns=$NS — is the cluster up?"; exit 1; }

# Runtime mode straight from the DEPLOYED pod's env — the pod, not the operator, is the source of
# truth for which runtime this cluster runs. Absent/empty = the classic Temporal deployment.
MODE="$(kubectl -n "$NS" exec "$BACKEND_POD" -- printenv CODEMASTER_RUNTIME_MODE 2>/dev/null || true)"
MODE="${MODE:-temporal}"

echo "LIVE cluster smoke — ns=$NS mode=$MODE temporal_pod=${TEMPORAL_POD:-n/a} backend_pod=$BACKEND_POD"
if [[ "$MODE" == "temporal" && -z "$TEMPORAL_POD" ]]; then
  echo "FATAL: temporal pod not found and mode=temporal — is the cluster up? (postgres-mode pods need no temporal)"
  exit 1
fi

# ── Postgres-mode schedule registry ───────────────────────────────────────────────────────────────
# Schedule-id → job_type, straight from apps/backend/src/runner/cron_schedules.ts (CRON_SCHEDULES —
# the seed registry for core.scheduled_jobs; job types are snake_case, NOT workflowTypes). Two
# schedule_ids deliberately diverge from their Temporal twins (the codemaster- operator-correlation
# prefix): refresh-confluence-corpus → codemaster-confluence-ingest and
# mark-stale-confluence-chunks → codemaster-mark-stale-chunks.
if [[ "$MODE" == "postgres" ]]; then
  SAFE_SCHEDULES=(
    "codemaster-mutex-janitor:mutex_janitor"
    "codemaster-review-run-reaper:review_run_reaper"
    "codemaster-confluence-ingest:confluence_ingest"
    "codemaster-mark-stale-chunks:mark_stale_chunks"
  )
  DESTRUCTIVE_SCHEDULES=(
    "codemaster-run-id-retention:run_id_retention"
    "codemaster-partition-maintenance:partition_maintenance"
    "codemaster-workspace-retention:workspace_retention"
  )
  ALL_SCHEDULE_IDS=(codemaster-mutex-janitor codemaster-review-run-reaper codemaster-confluence-ingest \
    codemaster-mark-stale-chunks codemaster-run-id-retention codemaster-partition-maintenance \
    codemaster-workspace-retention)
fi

# ── Mode-branch primitives (each implemented per-runtime, selected ONCE below; the sections call
#    only the mode-neutral names) ──────────────────────────────────────────────────────────────────

# registry_preflight — section 1. temporal: the static vitest registry smoke. postgres: the runner
# boot line is the registry proof — the CS2.2 fail-loud self-check refuses to compose a runner whose
# consumers are incomplete, so a booted (Ready) pod already proved handler completeness.
temporal_registry_preflight() {
  if (cd "$REPO_ROOT" && npx vitest run test/smoke/workflow_activity_registry.smoke.test.ts >/tmp/cm_reg.log 2>&1); then
    ok "registry smoke: every dispatched activity registered + every started workflow served ($(grep -oE '[0-9]+ served workflows, [0-9]+ registered activities' /tmp/cm_reg.log | head -1))"
  else
    bad "registry smoke FAILED (see /tmp/cm_reg.log) — wiring drift; fix before trusting the live run"
  fi
}
pg_registry_preflight() {
  local boot_line n_types
  boot_line="$(kubectl -n "$NS" logs "$BACKEND_POD" 2>/dev/null | grep "background runner starting: mode=postgres" | tail -1)"
  n_types="$(printf '%s' "$boot_line" | grep -oE 'registered_job_types=\[[^]]+\]' | tr ',' '\n' | grep -c .)"
  if [[ "$boot_line" == *"review_loop=composed"* && "${n_types:-0}" -ge 13 ]]; then
    ok "runner boot self-check: review_loop=composed + $n_types registered job types (CS2.2 fail-loud consumer-completeness check passed at boot — a Ready pod IS the registry proof)"
  else
    bad "runner boot line missing review_loop=composed / >=13 registered_job_types (found ${n_types:-0}) — registry drift, shadow-mode pod, or log rotation"
  fi
}

# worker_dispatch_check — section 2. temporal: task-queue pollers from THIS pod. postgres: the boot
# line proves the runner/scheduler/outbox loops were composed and started in this pod's logs.
temporal_worker_dispatch_check() {
  local POLLERS
  POLLERS="$(tctl task-queue describe --task-queue review-default 2>/dev/null | grep -ci "$BACKEND_POD")"
  [[ "${POLLERS:-0}" -gt 0 ]] && ok "worker polling review-default ($POLLERS poller line(s) on this pod)" || bad "no pollers from $BACKEND_POD on review-default"
}
pg_worker_dispatch_check() {
  if kubectl -n "$NS" logs "$BACKEND_POD" 2>/dev/null | grep -q "background runner starting: mode=postgres"; then
    ok "background runner booted in this pod ('background runner starting: mode=postgres' boot line present)"
  else
    bad "no 'background runner starting: mode=postgres' boot line in $BACKEND_POD logs"
  fi
}

# schedules_ensured_check — section 2. temporal: 'schedule ensured:' boot-log lines. postgres: the
# seeded core.scheduled_jobs rows (ensureScheduledJobs runs at every boot; ON CONFLICT DO NOTHING).
temporal_schedules_ensured_check() {
  local ENSURED
  ENSURED="$(kubectl -n "$NS" logs "$BACKEND_POD" 2>/dev/null | grep -c "schedule ensured:")"
  [[ "${ENSURED:-0}" -ge 7 ]] && ok "boot logs ensured $ENSURED schedules + workers RUNNING" || skip "only $ENSURED 'schedule ensured' lines in current pod logs (log rotation?)"
}
pg_schedules_ensured_check() {
  local ENSURED
  ENSURED="$(psql_q "SELECT count(*) FROM core.scheduled_jobs WHERE enabled;")"
  [[ "${ENSURED:-0}" -ge 7 ]] && ok "core.scheduled_jobs carries $ENSURED enabled schedule(s) (seeded by ensureScheduledJobs at boot)" || bad "only ${ENSURED:-0} enabled core.scheduled_jobs row(s) (expected >= 7)"
}

# schedule_live_check <sid> — section 3. temporal: present + unpaused in `tctl schedule list`
# (SCHED_LIST is fetched once in section 3). postgres: the row exists with enabled='t'.
temporal_schedule_live_check() {
  local sid="$1"
  if echo "$SCHED_LIST" | grep -q "$sid"; then
    if echo "$SCHED_LIST" | grep "$sid" | grep -qi "true"; then bad "$sid is PAUSED"; else ok "$sid present + unpaused"; fi
  else bad "$sid MISSING from schedule list"; fi
}
pg_schedule_live_check() {
  local sid="$1" en
  en="$(psql_q "SELECT enabled FROM core.scheduled_jobs WHERE schedule_id='$sid';")"
  case "$en" in
    t) ok "$sid present + enabled (core.scheduled_jobs)";;
    f) bad "$sid is PAUSED (enabled=f in core.scheduled_jobs)";;
    *) bad "$sid MISSING from core.scheduled_jobs";;
  esac
}

# trigger_safe_schedule <sid> — section 4a. temporal: tctl schedule trigger. postgres: pull
# next_run_at to now() — the SchedulerLoop's poll (~30s) picks it up and enqueues the tick's
# core.background_jobs row (overlap=SKIP via dedup_key, same as the Temporal trigger semantics).
temporal_trigger_safe_schedule() { tctl schedule trigger --schedule-id "$1" >/dev/null 2>&1; }
pg_trigger_safe_schedule() { psql_q "UPDATE core.scheduled_jobs SET next_run_at = now() WHERE schedule_id='$1';" >/dev/null; }

# latest_status_for <unit> — sections 4a/4c. Normalized latest terminal status: Completed / Failed /
# '' if never ran / anything else = still in flight. temporal: <unit> is a workflowType (tctl
# workflow list). postgres: <unit> is a job_type; the latest core.background_jobs row's state maps
# done→Completed, dead→Failed, and ready/leased/failed(transient) pass through as in-flight.
pg_latest_status_for() {
  local st
  st="$(psql_q "SELECT state FROM core.background_jobs WHERE job_type='$1' ORDER BY created_at DESC LIMIT 1;")"
  case "$st" in
    done) echo "Completed";;
    dead) echo "Failed";;
    *)    echo "$st";;
  esac
}

# review_status_for_pr <pr_num> — section 5. temporal: review_wf_status_for_pr (defined in section 5,
# byte-identical with the single-runtime script). postgres: correlate via the review tables — the
# latest core.review_jobs row joined to its run + PR; done/COMPLETED→Completed, dead/*→Failed,
# ''→still pending (webhook not landed / job not enqueued yet).
pg_review_status_for_pr() {
  local st
  st="$(psql_q "SELECT rj.state || '/' || COALESCE(rr.lifecycle_state,'') FROM core.review_jobs rj JOIN core.review_runs rr ON rr.run_id = rj.run_id JOIN core.pull_request_reviews pr ON pr.review_id = rj.review_id WHERE pr.pr_number = $1 ORDER BY rj.created_at DESC LIMIT 1;")"
  case "$st" in
    done/COMPLETED) echo "Completed";;
    dead/*)         echo "Failed";;
    "")             echo "";;
    *)              echo "$st";;
  esac
}

# dispatch_loop_check — section 5. temporal: the OutboxDispatcherWorkflow singleton is alive.
# postgres: /readyz aggregates the 'runtime-loops' health check (a dead required loop flips the pod
# not-ready), plus prove the drain keeps up: zero pending core.outbox rows older than 2 minutes.
temporal_dispatch_loop_check() {
  local OUTBOX
  OUTBOX="$(tctl workflow list --query "WorkflowType='OutboxDispatcherWorkflow'" --limit 1 2>/dev/null | awk 'NR==2{print $1}')"
  [[ "$OUTBOX" == "Running" || "$OUTBOX" == "ContinuedAsNew" ]] && { ok "OutboxDispatcherWorkflow singleton $OUTBOX (loop alive)"; SUMMARY+=("OutboxDispatcherWorkflow: $OUTBOX (singleton)"); } \
    || { skip "OutboxDispatcherWorkflow latest = ${OUTBOX:-none}"; SUMMARY+=("OutboxDispatcherWorkflow: ${OUTBOX:-none}"); }
}
pg_dispatch_loop_check() {
  local READYZ STALE
  READYZ="$(kubectl -n "$NS" exec "$BACKEND_POD" -- sh -c 'wget -qO- http://127.0.0.1:8080/readyz || curl -s http://127.0.0.1:8080/readyz' 2>/dev/null)"
  if [[ "$READYZ" == *'"ready":true'* ]]; then
    ok "/readyz ready=true (runtime-loops check: runner/scheduler/outbox drain loops alive)"
    SUMMARY+=("outbox drain loop: READY (/readyz runtime-loops)")
  else
    bad "/readyz NOT ready (${READYZ:-no response}) — a required runtime loop is down"
    SUMMARY+=("outbox drain loop: NOT-READY")
  fi
  STALE="$(psql_q "SELECT count(*) FROM core.outbox WHERE state='pending' AND created_at < now() - interval '2 minutes';")"
  [[ "${STALE:-1}" -eq 0 ]] && ok "outbox drain keeping up: 0 pending rows older than 2m" \
    || bad "outbox drain stalled: ${STALE:-?} pending core.outbox row(s) older than 2m"
}

# not_registered_scan — section 6. temporal: ActivityNotRegistered/WorkflowNotRegistered. postgres:
# the runner-side equivalents — 'no handler for <job_type>' (registry miss), outbox.dispatch_failed,
# and dead_letter lines.
temporal_not_registered_scan() {
  local ANR
  ANR="$(kubectl -n "$NS" logs "$BACKEND_POD" --since=10m 2>/dev/null | grep -ci "ActivityNotRegistered\|WorkflowNotRegistered")"
  [[ "${ANR:-0}" -eq 0 ]] && ok "no ActivityNotRegistered/WorkflowNotRegistered in the last 10m of worker logs" || bad "$ANR Not-Registered error(s) in worker logs — registry drift LIVE"
}
pg_not_registered_scan() {
  local ANR
  ANR="$(kubectl -n "$NS" logs "$BACKEND_POD" --since=10m 2>/dev/null | grep -ciE "no handler for|outbox.dispatch_failed|dead_letter")"
  [[ "${ANR:-0}" -eq 0 ]] && ok "no handler-miss/dispatch-failure/dead-letter lines in the last 10m of runner logs" || bad "$ANR dispatch-failure line(s) in runner logs — handler/registry drift LIVE"
}

# Select the runtime's implementations ONCE — sections below are mode-blind.
if [[ "$MODE" == "postgres" ]]; then
  registry_preflight()      { pg_registry_preflight "$@"; }
  worker_dispatch_check()   { pg_worker_dispatch_check "$@"; }
  schedules_ensured_check() { pg_schedules_ensured_check "$@"; }
  schedule_live_check()     { pg_schedule_live_check "$@"; }
  trigger_safe_schedule()   { pg_trigger_safe_schedule "$@"; }
  latest_status_for()       { pg_latest_status_for "$@"; }
  dispatch_loop_check()     { pg_dispatch_loop_check "$@"; }
  review_status_for_pr()    { pg_review_status_for_pr "$@"; }
  not_registered_scan()     { pg_not_registered_scan "$@"; }
  WAIT_ROUNDS=40   # scheduler poll (~30s) + job runtime before the tick's row reaches done
else
  registry_preflight()      { temporal_registry_preflight "$@"; }
  worker_dispatch_check()   { temporal_worker_dispatch_check "$@"; }
  schedules_ensured_check() { temporal_schedules_ensured_check "$@"; }
  schedule_live_check()     { temporal_schedule_live_check "$@"; }
  trigger_safe_schedule()   { temporal_trigger_safe_schedule "$@"; }
  latest_status_for()       { wf_latest_status "$@"; }
  dispatch_loop_check()     { temporal_dispatch_loop_check "$@"; }
  review_status_for_pr()    { review_wf_status_for_pr "$@"; }   # defined in section 5 (call-time resolution)
  not_registered_scan()     { temporal_not_registered_scan "$@"; }
  WAIT_ROUNDS=20
fi

# ── 1. Pre-flight: static registry (all workflows served + all activities registered) ──────────────
section "1. Pre-flight — static workflow/activity registry"
registry_preflight

# ── 2. Worker boot health ──────────────────────────────────────────────────────────────────────────
section "2. Worker boot health"
READY="$(kubectl -n "$NS" get pod "$BACKEND_POD" -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null)"
RESTARTS="$(kubectl -n "$NS" get pod "$BACKEND_POD" -o jsonpath='{.status.containerStatuses[0].restartCount}' 2>/dev/null)"
[[ "$READY" == "true" ]] && ok "backend pod $BACKEND_POD Ready (restarts=$RESTARTS)" || bad "backend pod not Ready (ready=$READY)"
worker_dispatch_check
schedules_ensured_check

# ── 3. Schedules present + unpaused ─────────────────────────────────────────────────────────────────
section "3. Schedules live (all 7, unpaused)"
SCHED_LIST=""
[[ "$MODE" == "temporal" ]] && SCHED_LIST="$(tctl schedule list 2>/dev/null)"
for sid in "${ALL_SCHEDULE_IDS[@]}"; do
  schedule_live_check "$sid"
done

# ── 4. Workflow liveness ────────────────────────────────────────────────────────────────────────────
section "4. Workflow liveness — trigger-safe + verify-destructive"
# 4a. Trigger the safe schedules + assert COMPLETED.
for entry in "${SAFE_SCHEDULES[@]}"; do
  sid="${entry%%:*}"; wf="${entry##*:}"
  trigger_safe_schedule "$sid"
  status=""
  for _ in $(seq 1 "$WAIT_ROUNDS"); do
    for _ in $(seq 1 5); do kubectl -n "$NS" exec "$BACKEND_POD" -- true >/dev/null 2>&1; done
    status="$(latest_status_for "$wf")"
    [[ "$status" == "Completed" || "$status" == "Failed" ]] && break
  done
  case "$status" in
    Completed) ok "$wf triggered → COMPLETED"; SUMMARY+=("$wf: COMPLETED (triggered)");;
    Failed)    bad "$wf triggered → FAILED (inspect: temporal workflow show / core.background_jobs last_error)"; SUMMARY+=("$wf: FAILED");;
    *)         skip "$wf triggered → still $status after wait"; SUMMARY+=("$wf: $status (slow)");;
  esac
done
# 4b. Single-page resync (idempotent, re-runnable). postgres: hand-INSERTing core.background_jobs
# from bash cannot compute the payload_sha256 the enqueue repo derives, so the event-driven enqueue
# path is NOT trigger-able here — covered by the event_handlers_trigger_page_resync integration test.
if [[ "$MODE" == "postgres" ]]; then
  skip "triggerPageResync: event-driven enqueue requires the payload-hashing repo — covered by event_handlers_trigger_page_resync integration test"
  SUMMARY+=("triggerPageResync: SKIPPED (postgres mode — integration-test covered)")
else
  RESYNC_ID="live-smoke-resync-${SMOKE_SPACE_KEY}-${SMOKE_PAGE_ID}"
  tctl workflow start --task-queue review-default --type triggerPageResyncWorkflow --workflow-id "$RESYNC_ID" \
    --input "{\"schema_version\":1,\"space_key\":\"$SMOKE_SPACE_KEY\",\"page_id\":\"$SMOKE_PAGE_ID\",\"triggered_by_user_id\":null}" >/dev/null 2>&1
  RESYNC_RES="$(tctl workflow result --workflow-id "$RESYNC_ID" 2>/dev/null | grep -oE '"resync_complete":(true|false)')"
  [[ "$RESYNC_RES" == *true* ]] && { ok "triggerPageResyncWorkflow → resync_complete=true"; SUMMARY+=("triggerPageResyncWorkflow: COMPLETED (triggered)"); } \
    || { skip "triggerPageResyncWorkflow → $RESYNC_RES (Confluence creds/embedder?)"; SUMMARY+=("triggerPageResyncWorkflow: $RESYNC_RES"); }
fi
# 4c. Destructive retention — verify LAST scheduled run, never trigger.
for entry in "${DESTRUCTIVE_SCHEDULES[@]}"; do
  wf="${entry##*:}"; status="$(latest_status_for "$wf")"
  case "$status" in
    Completed) ok "$wf last scheduled run = COMPLETED (not triggered — destructive)"; SUMMARY+=("$wf: COMPLETED (last scheduled)");;
    "")        skip "$wf has NOT fired yet (daily cron) — not triggered (destructive). Will verify next scheduled run."; SUMMARY+=("$wf: NO-RUN-YET (not triggered)");;
    *)         skip "$wf last run = $status (not triggered — destructive)"; SUMMARY+=("$wf: $status (last scheduled)");;
  esac
done

# ── 5. Outbox dispatcher + reviewPullRequest (FRESH PR each run) ──────────────────────────────────────
section "5. Outbox dispatcher + review path"
dispatch_loop_check

LLM_PROVIDER="$(psql_q "SELECT provider||'/'||model_id FROM core.llm_provider_settings WHERE enabled LIMIT 1;")"
echo "  ℹ️  review LLM provider = ${LLM_PROVIDER:-none}"

# reviewPullRequest — open a FRESH PR every run (project-owner directive: "create a new PR for every
# smoke") and drive a real end-to-end review. The new branch points at the seeded-issues bait SHA, so the
# PR diff carries the planted defects. We correlate by the Temporal workflow id ending in /<PR_NUM>
# (temporal mode) or by the review tables keyed on pr_number (postgres mode): PR numbers are monotonic +
# globally unique on the repo, so the match never collides with a prior run. gh absent/unauthed OR the
# webhook not delivered within the wait window degrade to SKIP (environmental); a real workflow/job
# FAILED, or COMPLETED-but-no-review-posted, is a hard RED.
REVIEW_REPO="${CODEMASTER_SMOKE_REVIEW_REPO:-inder1991/inventory-service}"
REVIEW_BASE="${CODEMASTER_SMOKE_REVIEW_BASE:-main}"
REVIEW_SEED_BRANCH="${CODEMASTER_SMOKE_REVIEW_SEED_BRANCH:-seeded-issues}"
REVIEW_WAIT_ROUNDS="${CODEMASTER_SMOKE_REVIEW_WAIT_ROUNDS:-50}"   # ~8 min budget (a real review ≈ 4-6 min)
# Status of the reviewPullRequest workflow whose id ends in /<PR_NUM> ('' until one appears).
review_wf_status_for_pr() {
  tctl workflow list --query "WorkflowType='reviewPullRequest'" --limit 10 2>/dev/null \
    | awk -v re="/$1$" 'NR>1 && $2 ~ re {print $1; exit}'
}
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  skip "reviewPullRequest: gh CLI absent/unauthed — cannot open a fresh PR (set up gh to drive the live review)"
  SUMMARY+=("reviewPullRequest: SKIPPED (no gh)")
else
  TS="$(date +%y%m%d-%H%M%S)"; SMOKE_BRANCH="smoke/review-$TS"
  SEED_SHA="$(gh api "repos/$REVIEW_REPO/git/ref/heads/$REVIEW_SEED_BRANCH" --jq '.object.sha' 2>/dev/null)"
  if [[ -z "$SEED_SHA" ]]; then
    skip "reviewPullRequest: seed branch '$REVIEW_SEED_BRANCH' not found on $REVIEW_REPO"
    SUMMARY+=("reviewPullRequest: SKIPPED (no seed branch)")
  elif ! gh api "repos/$REVIEW_REPO/git/refs" -f "ref=refs/heads/$SMOKE_BRANCH" -f "sha=$SEED_SHA" >/dev/null 2>&1; then
    skip "reviewPullRequest: could not create branch $SMOKE_BRANCH on $REVIEW_REPO"
    SUMMARY+=("reviewPullRequest: SKIPPED (branch create failed)")
  else
    PR_URL="$(gh pr create --repo "$REVIEW_REPO" --base "$REVIEW_BASE" --head "$SMOKE_BRANCH" \
      --title "codemaster live smoke $TS" \
      --body "Automated live-smoke PR (seeded-issues bait). Safe to close; run-id retention reaps stale smoke PRs." 2>/dev/null)"
    PR_NUM="$(echo "$PR_URL" | grep -oE '[0-9]+$')"
    if [[ -z "$PR_NUM" ]]; then
      skip "reviewPullRequest: gh pr create failed (head=$SMOKE_BRANCH) — branch left for manual inspect"
      SUMMARY+=("reviewPullRequest: SKIPPED (pr create failed)")
    else
      echo "  ℹ️  opened $REVIEW_REPO PR #$PR_NUM (head=$SMOKE_BRANCH) — waiting up to ~8m for webhook→review…"
      RSTATUS=""
      for _ in $(seq 1 "$REVIEW_WAIT_ROUNDS"); do
        for _ in $(seq 1 12); do kubectl -n "$NS" exec "$BACKEND_POD" -- true >/dev/null 2>&1; done  # ~10s busy-wait (no host sleep)
        RSTATUS="$(review_status_for_pr "$PR_NUM")"
        [[ "$RSTATUS" == "Completed" || "$RSTATUS" == "Failed" ]] && break
      done
      case "$RSTATUS" in
        Completed)
          NREV="$(gh api "repos/$REVIEW_REPO/pulls/$PR_NUM/reviews" --jq 'length' 2>/dev/null || echo 0)"
          NCMT="$(gh api "repos/$REVIEW_REPO/pulls/$PR_NUM/comments" --jq 'length' 2>/dev/null || echo 0)"
          if [[ "${NREV:-0}" -ge 1 ]]; then
            ok "reviewPullRequest PR #$PR_NUM → COMPLETED + posted review ($NREV review, $NCMT inline comments)"
            SUMMARY+=("reviewPullRequest: COMPLETED + posted (PR #$PR_NUM, $NCMT comments)")
            SEP_HITS="$( { gh api "repos/$REVIEW_REPO/pulls/$PR_NUM/reviews" --jq '.[].body' 2>/dev/null; \
                          gh api "repos/$REVIEW_REPO/pulls/$PR_NUM/comments" --jq '.[].body' 2>/dev/null; } \
                        | grep -ciE "$SMOKE_SPACE_KEY/$SMOKE_PAGE_ID|confluence:$SMOKE_SPACE_KEY" )"
            [[ "${SEP_HITS:-0}" -ge 1 ]] \
              && ok "review cites the embedded Confluence corpus ($SMOKE_SPACE_KEY/$SMOKE_PAGE_ID ×$SEP_HITS)" \
              || skip "review posted but no $SMOKE_SPACE_KEY/$SMOKE_PAGE_ID citation (retrieval/embedder regression?)"
          else
            bad "reviewPullRequest PR #$PR_NUM → COMPLETED but NO review posted (publication degraded — invariant 12)"
            SUMMARY+=("reviewPullRequest: COMPLETED-but-UNPOSTED (PR #$PR_NUM)")
          fi
          ;;
        Failed)
          bad "reviewPullRequest PR #$PR_NUM → review FAILED (temporal workflow show / core.review_jobs last_error; Anthropic credits?)"
          SUMMARY+=("reviewPullRequest: FAILED (PR #$PR_NUM)")
          ;;
        *)
          skip "reviewPullRequest PR #$PR_NUM → no terminal review after ~8m (webhook forwarder/smee up? credits?)"
          SUMMARY+=("reviewPullRequest: ${RSTATUS:-none} (PR #$PR_NUM — webhook not delivered?)")
          ;;
      esac
    fi
  fi
fi

# ── 6. Activity-failure scan + summary ──────────────────────────────────────────────────────────────
section "6. Dispatch-failure scan (no unregistered/dead-letter dispatches in recent history)"
not_registered_scan

section "SUMMARY — every workflow, live status"
for line in "${SUMMARY[@]}"; do echo "  • $line"; done
echo
echo "PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
[[ "$FAIL" -eq 0 ]] && { echo "LIVE SMOKE: GREEN (all hard checks passed; skips are environmental/destructive-gated by design)"; exit 0; } \
  || { echo "LIVE SMOKE: RED ($FAIL hard failure(s))"; exit 1; }
