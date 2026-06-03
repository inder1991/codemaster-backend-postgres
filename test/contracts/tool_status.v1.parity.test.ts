import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { ToolStatusV1 } from "../../libs/contracts/src/tool_status.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `ToolStatusV1(**payload).model_dump(mode="json")`) and through
// Zod (`ToolStatusV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
//
// ToolStatusV1 carries two datetime fields. Pydantic emits a "Z"-suffixed ISO string while Zod
// passes the input string through verbatim — the canonicalizer (its own docstring: "so Python
// model_dump and JS JSON.stringify don't diff spuriously") normalizes both to microsecond UTC.
// We therefore re-canonicalize the oracle's raw output (`canonicalize(JSON.parse(r.out))`) so the
// datetime normalization applies to BOTH sides, rather than comparing against the raw "Z" form.
const PY = "contracts.tool_status.v1";

describe("ToolStatusV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = {
      schema_version: 1,
      tool_name: "mypy",
      status: "failed_runtime",
      files_scanned: 2,
      files_total: 10,
      started_at: "2026-06-03T10:00:00+00:00",
      finished_at: "2026-06-03T10:05:30+00:00",
      duration_ms: 330000,
      findings_produced: 4,
      error_class: "RuntimeError",
      error_message: "boom",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolStatusV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ToolStatusV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("applies the same defaults (schema_version/findings_produced/error_*) when omitted", async () => {
    const payload = {
      tool_name: "ruff",
      status: "completed",
      files_scanned: 3,
      files_total: 5,
      started_at: "2026-06-03T10:00:00+00:00",
      finished_at: "2026-06-03T10:00:01+00:00",
      duration_ms: 1000,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolStatusV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ToolStatusV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("treats an explicit null finished_at identically (required-but-nullable)", async () => {
    const payload = {
      tool_name: "ruff",
      status: "timed_out",
      files_scanned: 0,
      files_total: 0,
      started_at: "2026-06-03T10:00:00+00:00",
      finished_at: null,
      duration_ms: 1000,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolStatusV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ToolStatusV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("accepts the coverage boundary (files_scanned == files_total) identically", async () => {
    const payload = {
      tool_name: "eslint",
      status: "completed",
      files_scanned: 7,
      files_total: 7,
      started_at: "2026-06-03T09:00:00+00:00",
      finished_at: "2026-06-03T09:00:02+00:00",
      duration_ms: 2000,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolStatusV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ToolStatusV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("both REJECT the coverage invariant (files_scanned > files_total — model_validator)", async () => {
    const bad = {
      tool_name: "ruff",
      status: "completed",
      files_scanned: 6,
      files_total: 5,
      started_at: "2026-06-03T10:00:00+00:00",
      finished_at: null,
      duration_ms: 1000,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolStatusV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError (value_error)
    expect(() => ToolStatusV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-range value (files_scanned < 0, ge=0)", async () => {
    const bad = {
      tool_name: "ruff",
      status: "completed",
      files_scanned: -1,
      files_total: 5,
      started_at: "2026-06-03T10:00:00+00:00",
      finished_at: null,
      duration_ms: 1000,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolStatusV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ToolStatusV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty tool_name (min_length=1)", async () => {
    const bad = {
      tool_name: "",
      status: "completed",
      files_scanned: 1,
      files_total: 1,
      started_at: "2026-06-03T10:00:00+00:00",
      finished_at: null,
      duration_ms: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolStatusV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ToolStatusV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown status (Literal ↔ z.enum)", async () => {
    const bad = {
      tool_name: "ruff",
      status: "exploded",
      files_scanned: 1,
      files_total: 1,
      started_at: "2026-06-03T10:00:00+00:00",
      finished_at: null,
      duration_ms: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolStatusV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ToolStatusV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required-but-nullable finished_at (no default)", async () => {
    const bad = {
      tool_name: "ruff",
      status: "completed",
      files_scanned: 3,
      files_total: 5,
      started_at: "2026-06-03T10:00:00+00:00",
      duration_ms: 1000,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolStatusV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic: Field required
    expect(() => ToolStatusV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      tool_name: "ruff",
      status: "completed",
      files_scanned: 1,
      files_total: 1,
      started_at: "2026-06-03T10:00:00+00:00",
      finished_at: null,
      duration_ms: 1,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolStatusV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ToolStatusV1.parse(bad)).toThrow();
  }, 30_000);
});
