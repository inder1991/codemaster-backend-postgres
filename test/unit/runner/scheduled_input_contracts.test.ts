// W3.8 (RM7): the scheduler-boundary input-contract registry — core.scheduled_jobs.input is
// operator-writable platform config the scheduler must treat as UNTRUSTED. Pre-RM7 the poll pass
// forwarded `input` verbatim as the background-job payload and the job_type→contract check only
// happened at DISPATCH (a ZodError that dead-letters the job after burning a slot, re-enqueued on
// every tick); worse, ANY job_type was schedulable — including the cross-tenant event-driven ones
// (sync_code_owners / refresh_semantic_docs), whose crafted input could target an arbitrary
// repository/installation since scheduled_jobs has no row tenancy. The registry pins the
// SCHEDULABLE job_types (the cron seeds) to the SAME input contracts their handlers parse, so
// pollAndEnqueue can default-deny at the boundary.
import { describe, expect, it } from "vitest";

import { CRON_SCHEDULES } from "#backend/runner/cron_schedules.js";
import { SCHEDULED_JOB_INPUT_CONTRACTS } from "#backend/runner/scheduled_input_contracts.js";

describe("SCHEDULED_JOB_INPUT_CONTRACTS — the RM7 scheduler-boundary registry", () => {
  it("every seeded CRON_SCHEDULES job_type has a registered input contract (else default-deny would reject its own seed)", () => {
    for (const s of CRON_SCHEDULES) {
      expect(SCHEDULED_JOB_INPUT_CONTRACTS.has(s.job_type), `missing contract for job_type '${s.job_type}'`).toBe(true);
    }
    // Lockstep both ways: the registry carries EXACTLY the seeded job_types — an entry without a
    // seed is dead vocabulary that would rot unnoticed.
    expect([...SCHEDULED_JOB_INPUT_CONTRACTS.keys()].sort()).toEqual(
      [...new Set(CRON_SCHEDULES.map((s) => s.job_type))].sort(),
    );
  });

  it("every seed's input PASSES its own contract — the seeds and the boundary can never disagree", () => {
    for (const s of CRON_SCHEDULES) {
      const schema = SCHEDULED_JOB_INPUT_CONTRACTS.get(s.job_type)!;
      expect(schema.safeParse(s.input).success, `seed input for '${s.job_type}' must parse`).toBe(true);
    }
  });

  it("strict contracts refuse junk, and the cross-tenant EVENT-DRIVEN job_types are deliberately NOT schedulable", () => {
    // The zero-config crons are STRICT empty objects — an operator edit expecting an effect fails
    // loudly at the boundary instead of being silently forwarded.
    expect(SCHEDULED_JOB_INPUT_CONTRACTS.get("mutex_janitor")!.safeParse({ junk: 1 }).success).toBe(false);
    // run_id_retention requires the full TTL triple (no silent defaults).
    expect(SCHEDULED_JOB_INPUT_CONTRACTS.get("run_id_retention")!.safeParse({ prTtlDays: 7 }).success).toBe(false);
    // Default-deny (RM7): the event-driven, tenant-targeting job_types have NO scheduled contract —
    // a scheduled_jobs row naming them must be rejected at the scheduler boundary.
    for (const eventType of ["sync_code_owners", "refresh_semantic_docs", "reconcile_installation"]) {
      expect(SCHEDULED_JOB_INPUT_CONTRACTS.has(eventType)).toBe(false);
    }
  });
});
