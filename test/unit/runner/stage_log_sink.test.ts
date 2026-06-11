// CS8 (C4/L12/XM14 — structured logging for degraded reviews): the discard StageLogger
// (review_job_shell.ts `void msg`) drops every degradation warning the pipeline emits, so a
// degraded review is INVISIBLE in the Postgres runner (recordStage no-ops outside a Temporal
// workflow context — the WARN line is the only signal, and it goes nowhere). The fix has two
// halves, both pinned here:
//   (1) degradation.ts stageOutcome passes STRUCTURED fields (stage, outcome='degraded',
//       error_class) as warning()'s second argument — the message string stays byte-identical for
//       existing sinks; field-aware sinks no longer parse strings.
//   (2) stage_log_sink.ts makeStructuredStageLogger binds the per-job correlation context
//       (run_id / installation_id / head_sha / repo / trace_id) and emits ONE structured record
//       per warning on an injectable StageLogSink (production default: pino).
import { describe, expect, it, vi } from "vitest";
import { stageOutcome } from "#backend/review/pipeline/degradation.js";
import { makeStructuredStageLogger } from "#backend/runner/stage_log_sink.js";

const BOUND = {
  run_id: "run-1",
  installation_id: "inst-1",
  head_sha: "a".repeat(40),
  repo: "acme/widgets",
  trace_id: null,
} as const;

describe("makeStructuredStageLogger (CS8)", () => {
  it("merges the bound job context + per-call fields into ONE structured record on the sink", () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = makeStructuredStageLogger(BOUND, (r) => records.push(r as Record<string, unknown>));

    logger.warning("stage_outcome: persist_findings failed; review continues", {
      stage: "persist_findings",
      outcome: "degraded",
      error_class: "Error",
    });

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.event).toBe("review.stage_degraded");
    expect(r.run_id).toBe("run-1");
    expect(r.installation_id).toBe("inst-1");
    expect(r.head_sha).toBe("a".repeat(40));
    expect(r.repo).toBe("acme/widgets");
    expect(r.trace_id).toBeNull();
    expect(r.stage).toBe("persist_findings");
    expect(r.outcome).toBe("degraded");
    expect(r.error_class).toBe("Error");
    expect(String(r.msg)).toContain("persist_findings failed");
  });

  it("a message-only warning (legacy call shape) still lands as a record with null stage/outcome", () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = makeStructuredStageLogger(BOUND, (r) => records.push(r as Record<string, unknown>));

    logger.warning("rfid/comment_id length mismatch");

    expect(records).toHaveLength(1);
    expect(records[0]!.stage).toBeNull();
    expect(records[0]!.outcome).toBeNull();
    expect(records[0]!.run_id).toBe("run-1");
  });
});

describe("stageOutcome → structured fields (CS8)", () => {
  it("a degraded stage passes {stage, outcome:'degraded', error_class} as warning()'s second argument", async () => {
    const warning = vi.fn<(msg: string, fields?: Record<string, unknown>) => void>();
    const result = await stageOutcome(
      "persist_findings",
      { logger: { warning }, headSha: "b".repeat(40), runId: "run-2" },
      async () => {
        throw new TypeError("boom");
      },
    );
    expect(result).toBeUndefined(); // swallowed — fail-soft unchanged
    expect(warning).toHaveBeenCalledTimes(1);
    const [msg, fields] = warning.mock.calls[0]!;
    expect(msg).toContain("persist_findings failed");
    expect(fields).toEqual({ stage: "persist_findings", outcome: "degraded", error_class: "TypeError" });
  });
});
