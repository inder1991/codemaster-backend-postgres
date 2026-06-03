// Behavior test for the observability meter seam (libs/platform/src/observability/metrics.ts) — the
// 1:1 TS analogue of the frozen Python codemaster/observability/_otel.py::get_meter. Asserts the seam
// returns a working OTel Meter, that emission never throws (no-op-safe before an exporter is wired),
// and — with an in-memory MeterProvider registered — that a counter is recorded under its EXACT name
// with bounded-cardinality labels, summing repeated adds (the contract subsystems rely on).
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getMeter } from "#platform/observability/metrics.js";

let exporter: InMemoryMetricExporter;
let provider: MeterProvider;

beforeAll(() => {
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  // A huge interval so the only export happens on the explicit forceFlush() below (deterministic).
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 2_147_483_647 });
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  metrics.disable(); // reset the process-global provider so other test files start clean.
});

/** Find every data point of the metric named `name` across the exporter's collected resource metrics. */
function pointsFor(name: string): Array<DataPoint<number>> {
  const out: Array<DataPoint<number>> = [];
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === name) {
          out.push(...(m.dataPoints as Array<DataPoint<number>>));
        }
      }
    }
  }
  return out;
}

describe("getMeter (observability seam)", () => {
  it("returns a Meter exposing the OTel instrument-factory surface", () => {
    const meter = getMeter("codemaster.test");
    expect(typeof meter.createCounter).toBe("function");
    expect(typeof meter.createUpDownCounter).toBe("function");
    expect(typeof meter.createHistogram).toBe("function");
    expect(typeof meter.createObservableGauge).toBe("function");
  });

  it("emitting never throws (no-op-safe — emission is valid before any exporter is wired)", () => {
    const counter = getMeter("codemaster.test").createCounter("codemaster_smoke_total");
    expect(() => counter.add(1, { kind: "alpha" })).not.toThrow();
  });

  it("records a counter under its EXACT name, summing repeated adds per bounded label", async () => {
    const counter = getMeter("codemaster.review").createCounter(
      "codemaster_finding_scope_violation_attempted_total",
      { description: "test counter mirroring the invariant-14 parser counter" },
    );
    counter.add(1, { scope_emitted: "pr_global" });
    counter.add(2, { scope_emitted: "pr_global" });
    counter.add(5, { scope_emitted: "cross_chunk" });

    await provider.forceFlush();

    const points = pointsFor("codemaster_finding_scope_violation_attempted_total");
    const prGlobal = points.find((p) => p.attributes.scope_emitted === "pr_global");
    const crossChunk = points.find((p) => p.attributes.scope_emitted === "cross_chunk");
    expect(prGlobal?.value).toBe(3); // 1 + 2 summed under the same bounded label
    expect(crossChunk?.value).toBe(5);
    // Distinct bounded-label values produce distinct data points (no per-tenant labels — cardinality discipline).
    expect(points).toHaveLength(2);
  });
});
