// W3.8 (RM7): the scheduler-boundary input-contract registry — job_type → the SAME Zod contract
// its handler parses at dispatch.
//
// core.scheduled_jobs is PLATFORM-GLOBAL and operator-writable; pre-RM7 the poll pass forwarded
// `input` verbatim as the background-job payload (BackgroundJobsRepo.enqueue checks only
// JSON-value strictness, never the job_type's contract), so a malformed/hostile row only failed at
// HANDLER dispatch — burning a job slot and dead-lettering on every tick while the schedule stayed
// due — and ANY job_type was schedulable, including the cross-tenant event-driven ones
// (sync_code_owners / refresh_semantic_docs) whose crafted input could target an arbitrary
// repository/installation (scheduled_jobs has no row tenancy). Default-deny is applied at the
// scheduler boundary instead: {@link import("./scheduler.js").pollAndEnqueue} rejects a due row
// whose job_type has no entry here or whose `input` fails its contract, BEFORE any enqueue side
// effect, isolated per-schedule (the W4a.2 WARN + bounded metric + left-unadvanced posture).
//
// SINGLE SOURCE OF TRUTH: every schema is IMPORTED from the handler module
// (handlers/cron_handlers.ts) — the registry can never drift from what the handlers actually
// parse. The registry deliberately carries ONLY the cron-seeded job_types (CRON_SCHEDULES): the
// event-driven job_types ride the webhook→outbox pipeline with their own validated envelopes and
// are NOT legitimate cron targets (the scheduled_input_contracts unit suite pins the lockstep both
// ways).

import type { z } from "zod";

import { MarkStaleChunksInputV1 } from "#contracts/confluence_sync_stale.v1.js";

import {
  ConfluenceIngestCronInput,
  MutexJanitorCronInputV1,
  PartitionMaintenanceCronInputV1,
  ReviewRunReaperCronInputV1,
  JobRetentionCronInputV1,
  RunIdRetentionCronInputV1,
  WorkspaceRetentionCronInputV1,
} from "./handlers/cron_handlers.js";

/** job_type → the dispatch-time input contract, for every SCHEDULABLE (cron-seeded) job_type. */
export const SCHEDULED_JOB_INPUT_CONTRACTS: ReadonlyMap<string, z.ZodTypeAny> = new Map<
  string,
  z.ZodTypeAny
>([
  ["mutex_janitor", MutexJanitorCronInputV1],
  ["review_run_reaper", ReviewRunReaperCronInputV1],
  ["mark_stale_chunks", MarkStaleChunksInputV1],
  ["partition_maintenance", PartitionMaintenanceCronInputV1],
  // W4.6 (merged in the same wave): the job-retention janitor's pinned-TTL input.
  ["job_retention", JobRetentionCronInputV1],
  ["run_id_retention", RunIdRetentionCronInputV1],
  ["workspace_retention", WorkspaceRetentionCronInputV1],
  ["confluence_ingest", ConfluenceIngestCronInput],
]);
