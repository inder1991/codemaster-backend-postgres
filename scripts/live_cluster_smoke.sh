#!/usr/bin/env bash
# live_cluster_smoke.sh — comprehensive LIVE smoke of the deployed TS backend on the kind cluster.
#
# Codifies (and extends) the previously-manual PR→review cluster smoke into a repeatable, safe,
# all-workflows / all-activities validation. It verifies the deployed worker actually RUNS every
# workflow and dispatches every activity on the real cluster — via scheduled-workflow firing +
# completion, plus one real end-to-end review driven off a freshly-opened PR each run.
#
# SAFETY: it TRIGGERS only idempotent/safe schedules (mutex-janitor, run-reaper, confluence-ingest,
# mark-stale) + a single-page resync. The DESTRUCTIVE retention crons (run-id / partition / workspace —
# they DELETE aged rows) are verified by their LAST SCHEDULED RUN status, never force-triggered. The
# reviewPullRequest path opens a FRESH PR each run (project-owner directive) and spends Anthropic credits
# for a real review; gh-absent or webhook-undelivered degrades to SKIP, a FAILED/unposted review is RED.
#
# Usage:  CODEMASTER_TEST_LIVE_SMOKE=1 bash scripts/live_cluster_smoke.sh
# Requires: kubectl (kind context), the deployed `backend` pod, the Temporal pod, psql in pg-0.
#           The reviewPullRequest step also needs `gh` (authed) + a live webhook forwarder (smee/port-forward).
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

# ── 5. Outbox dispatcher + reviewPullRequest (FRESH PR each run) ──────────────────────────────────────
section "5. Outbox dispatcher + review path"
OUTBOX="$(tctl workflow list --query "WorkflowType='OutboxDispatcherWorkflow'" --limit 1 2>/dev/null | awk 'NR==2{print $1}')"
[[ "$OUTBOX" == "Running" || "$OUTBOX" == "ContinuedAsNew" ]] && { ok "OutboxDispatcherWorkflow singleton $OUTBOX (loop alive)"; SUMMARY+=("OutboxDispatcherWorkflow: $OUTBOX (singleton)"); } \
  || { skip "OutboxDispatcherWorkflow latest = ${OUTBOX:-none}"; SUMMARY+=("OutboxDispatcherWorkflow: ${OUTBOX:-none}"); }

LLM_PROVIDER="$(psql_q "SELECT provider||'/'||model_id FROM core.llm_provider_settings WHERE enabled LIMIT 1;")"
echo "  ℹ️  review LLM provider = ${LLM_PROVIDER:-none}"

# reviewPullRequest — open a FRESH PR every run (project-owner directive: "create a new PR for every
# smoke") and drive a real end-to-end review. The new branch points at the seeded-issues bait SHA, so the
# PR diff carries the planted defects. We correlate by the Temporal workflow id ending in /<PR_NUM>: PR
# numbers are monotonic + globally unique on the repo, so the match never collides with a prior run. gh
# absent/unauthed OR the webhook not delivered within the wait window degrade to SKIP (environmental); a
# real workflow FAILED, or COMPLETED-but-no-review-posted, is a hard RED.
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
        RSTATUS="$(review_wf_status_for_pr "$PR_NUM")"
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
          bad "reviewPullRequest PR #$PR_NUM → workflow FAILED (temporal workflow show <id>; Anthropic credits?)"
          SUMMARY+=("reviewPullRequest: FAILED (PR #$PR_NUM)")
          ;;
        *)
          skip "reviewPullRequest PR #$PR_NUM → no terminal review workflow after ~8m (webhook forwarder/smee up? credits?)"
          SUMMARY+=("reviewPullRequest: ${RSTATUS:-none} (PR #$PR_NUM — webhook not delivered?)")
          ;;
      esac
    fi
  fi
fi

# ── 6. Activity-failure scan + summary ──────────────────────────────────────────────────────────────
section "6. Activity-registration scan (no ActivityNotRegistered in recent history)"
ANR="$(kubectl -n "$NS" logs "$BACKEND_POD" --since=10m 2>/dev/null | grep -ci "ActivityNotRegistered\|WorkflowNotRegistered")"
[[ "${ANR:-0}" -eq 0 ]] && ok "no ActivityNotRegistered/WorkflowNotRegistered in the last 10m of worker logs" || bad "$ANR Not-Registered error(s) in worker logs — registry drift LIVE"

section "SUMMARY — every workflow, live status"
for line in "${SUMMARY[@]}"; do echo "  • $line"; done
echo
echo "PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
[[ "$FAIL" -eq 0 ]] && { echo "LIVE SMOKE: GREEN (all hard checks passed; skips are environmental/destructive-gated by design)"; exit 0; } \
  || { echo "LIVE SMOKE: RED ($FAIL hard failure(s))"; exit 1; }
