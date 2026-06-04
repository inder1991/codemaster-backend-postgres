// Unit test for the inv-14/15 enforcement COUNTERS + the malformed-skip / arbitration-skip hooks of
// chunk_response_parser.ts. The behavioral (blocks → findings/intents) parity is covered byte-for-byte
// against the frozen Python in test/parity/review_parser.parity.test.ts; THIS file pins the
// observability surface the parity oracle can't see (OTel counters are emitted by the parser but the
// Python ref dumps only the kept findings/intents, not its counter deltas).
//
// CARDINALITY + SINGLE-SOURCING: the three counters carry bounded-enum labels ONLY (no per-tenant
// labels), and the scope-violation counter is SINGLE-SOURCED at the parser per CLAUDE.md invariant 14
// (the aggregator backstop drops via the same oracle but never re-emits).
//
// COUNTER-TIMING GOTCHA (verified empirically): the parser caches its Counter instruments at MODULE
// scope (created once at import) per the metrics-seam convention. An OTel counter created BEFORE a
// MeterProvider is registered binds to the no-op meter and never records to a later-registered provider.
// So the provider is registered in `beforeAll` and the parser is DYNAMICALLY IMPORTED afterward, so its
// module-scope counters bind to the in-memory provider.
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

// Hand-written structural type for the dynamically-imported `parseWithSkipMalformed`. We deliberately do
// NOT statically import the parser module (not even `import { type ... }`) because that caused vitest to
// EAGERLY evaluate it (verified), binding its module-scope counters to the no-op meter BEFORE `beforeAll`
// registers the MeterProvider. The contracts below are pure Zod schemas (no counter cache), so importing
// their TYPES eagerly is harmless. The parser is loaded ONLY by the dynamic `await import()` in
// `beforeAll` — AFTER provider registration — so its counters bind to the in-memory provider (see the
// COUNTER-TIMING GOTCHA above).
type ParseWithSkipMalformed = (
  blocks: ReadonlyArray<Record<string, unknown>>,
  options: {
    readonly allowedEvidenceIds?: ReadonlySet<string> | null | undefined;
    readonly onMalformedSkip?: ((info: { readonly blockId: string; readonly reason: string }) => void) | undefined;
  },
) => { findings: Array<ReviewFindingV1>; intents: Array<ArbitrationIntentV1> };

let exporter: InMemoryMetricExporter;
let provider: MeterProvider;
let parseWithSkipMalformed: ParseWithSkipMalformed;

beforeAll(async () => {
  // DELTA temporality (not CUMULATIVE) so each forceFlush reports only the adds SINCE the last
  // collection — combined with exporter.reset() in beforeEach, every test asserts EXACTLY its own
  // counter adds (no cross-test running-total accumulation, which is the trap that made absolute
  // assertions flaky under CUMULATIVE when this file ran alongside other test files).
  exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 2_147_483_647 });
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  // Dynamic import AFTER provider registration so the module-scope counters bind to the real meter.
  ({ parseWithSkipMalformed } = await import("#backend/review/chunk_response_parser.js"));
});

beforeEach(() => {
  // Drop any prior export batches so `pointsFor`/`sumFor` see only this test's flush.
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
  metrics.disable(); // reset the process-global provider so other test files start clean.
});

/** Build one well-formed `report_finding` tool_use block dict. */
function findingBlock(input: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "tool_use",
    id: "x",
    name: "report_finding",
    input: {
      file: "a.py",
      start_line: 1,
      end_line: 1,
      severity: "issue",
      category: "bug",
      title: "t",
      body: "b",
      confidence: 0.9,
      ...input,
    },
  };
}

/** Every data point of `name` whose attribute `attrKey === attrVal`, across all collected metrics. */
function pointsFor(name: string, attrKey: string, attrVal: string): Array<DataPoint<number>> {
  const out: Array<DataPoint<number>> = [];
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === name) {
          for (const dp of m.dataPoints as Array<DataPoint<number>>) {
            if (dp.attributes[attrKey] === attrVal) out.push(dp);
          }
        }
      }
    }
  }
  return out;
}

/** Sum the value of `name` for a given bounded label, across the (reset-then-single-flush) batches —
 *  under DELTA + per-test exporter.reset() this is exactly THIS test's adds for that label. */
function sumFor(name: string, attrKey: string, attrVal: string): number {
  return pointsFor(name, attrKey, attrVal).reduce((acc, dp) => acc + dp.value, 0);
}

describe("chunk_response_parser counters (inv-14/15 enforcement, single-sourced at the parser)", () => {
  it("scope drop emits codemaster_finding_scope_violation_attempted_total{scope_emitted} per dropped scope", async () => {
    const res = parseWithSkipMalformed(
      [
        findingBlock({ title: "keep", scope: "chunk_observed" }),
        findingBlock({ title: "cc", scope: "cross_chunk" }),
        findingBlock({ title: "pg", scope: "pr_global" }),
      ],
      { allowedEvidenceIds: null },
    );
    expect(res.findings).toHaveLength(1);
    await provider.forceFlush();
    expect(sumFor("codemaster_finding_scope_violation_attempted_total", "scope_emitted", "cross_chunk")).toBe(1);
    expect(sumFor("codemaster_finding_scope_violation_attempted_total", "scope_emitted", "pr_global")).toBe(1);
    // chunk_observed is universally permitted → never a violation → no data point with that label.
    expect(pointsFor("codemaster_finding_scope_violation_attempted_total", "scope_emitted", "chunk_observed")).toHaveLength(0);
  });

  it("invalid evidence_refs emit codemaster_finding_evidence_ref_invalid_total{source=parser}", async () => {
    const res = parseWithSkipMalformed([findingBlock({ evidence_refs: ["ev_aaaaaaaaaaaaaaaa"] })], {
      allowedEvidenceIds: new Set(["ev_0123456789abcdef"]),
    });
    expect(res.findings).toHaveLength(0);
    await provider.forceFlush();
    expect(sumFor("codemaster_finding_evidence_ref_invalid_total", "source", "parser")).toBe(1);
  });

  it("empty refs WITH a manifest present emit codemaster_findings_without_evidence_refs_total{source_present_in_manifest=true} + KEEP the finding", async () => {
    const res = parseWithSkipMalformed([findingBlock({ evidence_refs: [] })], {
      allowedEvidenceIds: new Set(["ev_0123456789abcdef"]),
    });
    expect(res.findings).toHaveLength(1); // SHOULD-not-MUST: empty refs PASS.
    await provider.forceFlush();
    expect(sumFor("codemaster_findings_without_evidence_refs_total", "source_present_in_manifest", "true")).toBe(1);
  });

  it("empty refs with an EMPTY manifest emit codemaster_findings_without_evidence_refs_total{source_present_in_manifest=false}", async () => {
    const res = parseWithSkipMalformed([findingBlock({ evidence_refs: [] })], {
      allowedEvidenceIds: new Set<string>(), // empty set → evidence enabled, manifest NOT present
    });
    expect(res.findings).toHaveLength(1);
    await provider.forceFlush();
    expect(sumFor("codemaster_findings_without_evidence_refs_total", "source_present_in_manifest", "false")).toBe(1);
  });

  it("allowedEvidenceIds=null DISABLES evidence validation — no without-refs counter fires", async () => {
    const res = parseWithSkipMalformed([findingBlock({ evidence_refs: [] })], { allowedEvidenceIds: null });
    expect(res.findings).toHaveLength(1);
    await provider.forceFlush();
    // Validation disabled → NEITHER without-refs label is emitted for this flush.
    expect(sumFor("codemaster_findings_without_evidence_refs_total", "source_present_in_manifest", "true")).toBe(0);
    expect(sumFor("codemaster_findings_without_evidence_refs_total", "source_present_in_manifest", "false")).toBe(0);
  });

  it("onMalformedSkip hook fires once per skipped malformed finding block (carries blockId + reason)", () => {
    const skipped: Array<{ readonly blockId: string; readonly reason: string }> = [];
    const res = parseWithSkipMalformed(
      [
        findingBlock({ title: "good" }),
        { type: "tool_use", id: "t2-bad", name: "report_finding", input: { file: "a.py" } },
      ],
      { allowedEvidenceIds: null, onMalformedSkip: (info) => skipped.push(info) },
    );
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]!.title).toBe("good");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.blockId).toBe("t2-bad");
    expect(skipped[0]!.reason.length).toBeGreaterThan(0);
  });
});
