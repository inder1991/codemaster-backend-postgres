/**
 * Observability meter seam — 1:1 TS analogue of the frozen Python
 * `codemaster/observability/_otel.py::get_meter`.
 *
 * The single sanctioned entry point for OpenTelemetry metrics across the backend. Subsystems get a
 * {@link Meter} from here and create their instruments through it, rather than importing
 * `@opentelemetry/api` directly — so there is one place to evolve the observability surface and one
 * registry hook for the (deferred) end-of-migration metric-name-parity gate.
 *
 * Unlike the Python helper (which returns `None` when the OTel SDK is absent), `@opentelemetry/api`'s
 * `metrics.getMeter` ALWAYS returns a Meter — a no-op Meter when no MeterProvider is registered. So
 * emission is safe BEFORE the exporter/collector is wired (the exporter wiring is deferred to the
 * end-of-migration observability task): instruments register and `.add()/.record()` calls are no-ops
 * until a provider is installed, with no null-checks and no `TODO`s in the emit path.
 *
 * ── Convention for subsystem ports (the "emit inline with each subsystem" rule) ──
 *  - When porting `codemaster/<subsystem>/...`, port its metric emit calls TOO — they are already in
 *    the Python source you are reading. Do NOT defer them to a separate pass (that would re-open every
 *    subsystem). Only the exporter wiring + the name-parity gate + dashboards are deferred.
 *  - Copy the metric NAME from the Python verbatim (e.g. `codemaster_finding_scope_violation_attempted_total`)
 *    so the deferred name-parity gate passes and existing dashboards/alerts map unchanged.
 *  - Cache the instrument at MODULE scope (created once at import), not per-emit — mirrors the Python
 *    lazy-cache that exists to avoid per-emit `create_*` lock contention.
 *  - Bounded-cardinality labels ONLY (enum-like dimensions). NEVER per-tenant / per-installation /
 *    per-PR labels — same cardinality discipline the Python metric modules enforce.
 *
 * Meter name argument: pass the dotted module path the Python uses (e.g. `"codemaster.review"`,
 * `"codemaster.ingest"`, `"codemaster.domain.repos.outbox_repo"`).
 */
import { metrics, type Meter } from "@opentelemetry/api";

/** Return an OTel {@link Meter} bound to `name` (a no-op Meter when no MeterProvider is registered). */
export function getMeter(name: string): Meter {
  return metrics.getMeter(name);
}

// Re-export the instrument + attribute types so subsystem metric modules import everything
// observability-related from this one seam rather than reaching into `@opentelemetry/api` directly.
export type {
  Attributes,
  Counter,
  Histogram,
  Meter,
  ObservableGauge,
  UpDownCounter,
} from "@opentelemetry/api";
