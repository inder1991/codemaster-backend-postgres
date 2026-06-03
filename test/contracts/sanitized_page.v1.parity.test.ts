import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { SanitizedPageV1 } from "#contracts/sanitized_page.v1.js";

afterAll(() => shutdownRef());

// Round-trip the SAME payload through the frozen Pydantic contract (via the oracle —
// `SanitizedPageV1(**payload).model_dump(mode="json")`) and through Zod (`SanitizedPageV1.parse`),
// then diff canonical JSON. Accept/reject must also agree.
//
// NESTING: injection_flags is a Python frozenset[str] — model_dump(mode="json") emits a list in
// nondeterministic hash order. Payloads use ≤1 element so the dump order is order-invariant for the
// byte-equal canonical compare (same technique as the knowledge_chunks port).
const PY = "contracts.confluence.sanitized_page.v1";

const FULL = {
  schema_version: 1,
  page_id: "123456",
  space_key: "ENG",
  version: 3,
  title: "Service runbook",
  body: "<p>sanitized body, no untrusted wrapper</p>",
  labels: ["runbook", "service"],
  injection_flags: ["role_override"],
  status: "current",
  last_modified_at: "2026-06-03T10:00:00+00:00",
  pattern_set_version: 1,
} as const;

describe("SanitizedPageV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizedPageV1", kwargs: FULL });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(SanitizedPageV1.parse(FULL))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults when optional fields omitted", async () => {
    // labels default=(), schema_version default=1. injection_flags is required → must be supplied.
    const payload = {
      page_id: "p1",
      space_key: "ENG",
      version: 1,
      title: "t",
      body: "",
      injection_flags: [],
      status: "current",
      last_modified_at: "2026-06-03T10:00:00+00:00",
      pattern_set_version: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizedPageV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = SanitizedPageV1.parse(payload);
    expect(canonicalize(parsed)).toBe(r.out);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.labels).toEqual([]);
    expect(parsed.injection_flags).toEqual([]);
  }, 30_000);

  it("accepts microsecond-precision tz-aware datetimes identically", async () => {
    const payload = { ...FULL, last_modified_at: "2026-06-03T10:00:00.123456+00:00" };
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizedPageV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(SanitizedPageV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an unknown injection_flag (_validate_flags)", async () => {
    const bad = { ...FULL, injection_flags: ["not_a_real_flag"] };
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizedPageV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValueError
    expect(() => SanitizedPageV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a naive (offset-less) last_modified_at (_require_tz)", async () => {
    const bad = { ...FULL, last_modified_at: "2026-06-03T10:00:00" };
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizedPageV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SanitizedPageV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT version < 1 (ge=1)", async () => {
    const bad = { ...FULL, version: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizedPageV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SanitizedPageV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT pattern_set_version < 1 (ge=1)", async () => {
    const bad = { ...FULL, pattern_set_version: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizedPageV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SanitizedPageV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty page_id (min_length=1)", async () => {
    const bad = { ...FULL, page_id: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizedPageV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SanitizedPageV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...FULL, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizedPageV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SanitizedPageV1.parse(bad)).toThrow();
  }, 30_000);
});
