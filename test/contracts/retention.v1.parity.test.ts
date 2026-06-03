import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  EventsRetentionResultV1,
  RunIdRetentionResultV1,
  RunsRetentionResultV1,
  StalePrCloserResultV1,
} from "#contracts/retention.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `<Model>(**payload).model_dump(mode="json")`) and through Zod
// (`<Model>.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
const PY = "contracts.retention.v1";

describe("StalePrCloserResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { schema_version: 1, scanned: 12, closed: 9, skipped: 3 };
    const r = await pyRef({ pyModule: PY, pyCallable: "StalePrCloserResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(StalePrCloserResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = { scanned: 0, closed: 0, skipped: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "StalePrCloserResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(StalePrCloserResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a negative counter (scanned < 0)", async () => {
    const bad = { scanned: -1, closed: 0, skipped: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "StalePrCloserResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => StalePrCloserResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { scanned: 0, closed: 0, skipped: 0, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "StalePrCloserResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => StalePrCloserResultV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("RunsRetentionResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { schema_version: 1, scanned: 50, retired: 47 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RunsRetentionResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RunsRetentionResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = { scanned: 0, retired: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RunsRetentionResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RunsRetentionResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a negative counter (retired < 0)", async () => {
    const bad = { scanned: 0, retired: -5 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RunsRetentionResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RunsRetentionResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { scanned: 0, retired: 0, deleted: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RunsRetentionResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RunsRetentionResultV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("EventsRetentionResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { schema_version: 1, scanned: 1000, deleted: 1000, batches: 4 };
    const r = await pyRef({ pyModule: PY, pyCallable: "EventsRetentionResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(EventsRetentionResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = { scanned: 0, deleted: 0, batches: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "EventsRetentionResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(EventsRetentionResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a negative counter (batches < 0)", async () => {
    const bad = { scanned: 0, deleted: 0, batches: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "EventsRetentionResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => EventsRetentionResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { scanned: 0, deleted: 0, batches: 0, extra: 9 };
    const r = await pyRef({ pyModule: PY, pyCallable: "EventsRetentionResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => EventsRetentionResultV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("RunIdRetentionResultV1 parity (Pydantic ↔ Zod) — composite", () => {
  it("validates + dumps a fully-populated composite identically", async () => {
    const payload = {
      schema_version: 1,
      pr_closer: { schema_version: 1, scanned: 5, closed: 4, skipped: 1 },
      runs: { schema_version: 1, scanned: 30, retired: 28 },
      events: { schema_version: 1, scanned: 200, deleted: 200, batches: 2 },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RunIdRetentionResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RunIdRetentionResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies nested + outer schema_version defaults when omitted", async () => {
    const payload = {
      pr_closer: { scanned: 0, closed: 0, skipped: 0 },
      runs: { scanned: 0, retired: 0 },
      events: { scanned: 0, deleted: 0, batches: 0 },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RunIdRetentionResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RunIdRetentionResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a negative counter inside a nested submodel (events.deleted < 0)", async () => {
    const bad = {
      pr_closer: { scanned: 0, closed: 0, skipped: 0 },
      runs: { scanned: 0, retired: 0 },
      events: { scanned: 0, deleted: -1, batches: 0 },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RunIdRetentionResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RunIdRetentionResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field on a nested submodel (.strict() propagates)", async () => {
    const bad = {
      pr_closer: { scanned: 0, closed: 0, skipped: 0, bogus: 1 },
      runs: { scanned: 0, retired: 0 },
      events: { scanned: 0, deleted: 0, batches: 0 },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RunIdRetentionResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RunIdRetentionResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field on the outer composite (extra=forbid ↔ .strict())", async () => {
    const bad = {
      pr_closer: { scanned: 0, closed: 0, skipped: 0 },
      runs: { scanned: 0, retired: 0 },
      events: { scanned: 0, deleted: 0, batches: 0 },
      total: 7,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RunIdRetentionResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RunIdRetentionResultV1.parse(bad)).toThrow();
  }, 30_000);
});
