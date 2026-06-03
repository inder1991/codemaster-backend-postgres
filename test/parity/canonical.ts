// Canonical JSON: recursively key-sorted, stable separators, with EXPLICIT numeric/temporal
// normalization so Python model_dump(mode="json") and JS JSON.stringify don't diff spuriously.
//
// Normalization rules (head-of-arch review item g):
//  - Decimal: Pydantic emits Decimal as a STRING ("1.50"); preserve string form, do NOT coerce to number.
//  - float: Python repr vs JS Number.toString differ (1.0 vs "1"). Bare floats are REJECTED — contracts
//    must use Decimal-as-string or int, so a parity payload never carries a lossy float.
//  - datetime: Python isoformat keeps microseconds + explicit offset ("2026-06-03T10:00:00.000000+00:00");
//    JS Date.toISOString uses milliseconds + "Z". Both normalize to RFC3339 microsecond-precision UTC.
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(normalizeScalars(value)));
}

function normalizeScalars(v: unknown): unknown {
  if (typeof v === "number") {
    if (!Number.isInteger(v)) {
      throw new Error(`canonicalize: bare float ${v} — emit Decimal as string or int; see review item g`);
    }
    return v;
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (/^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(t)) {
      const d = new Date(t);
      const us = (d.getUTCMilliseconds() * 1000).toString().padStart(6, "0");
      return d.toISOString().replace(/\.\d{3}Z$/, `.${us}+00:00`);
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(normalizeScalars);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      o[k] = normalizeScalars((v as Record<string, unknown>)[k]);
    }
    return o;
  }
  return v;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
