import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  MarkStaleChunksInputV1,
  MarkStaleChunksOutputV1,
} from "#contracts/confluence_sync_stale.v1.js";

afterAll(() => shutdownRef());

// Contract parity for the mark-stale-chunks cron I/O (frozen Python contracts/confluence_sync/stale_v1.py).
// Both models are ConfigDict(extra="forbid", frozen=True) -> .strict(). Output carries ge=0 (counts) +
// ge=1 (threshold days) bounds. Round-trip each through Pydantic (oracle) + Zod; accept/reject must agree.
const PY = "contracts.confluence_sync.stale_v1";

describe("MarkStaleChunksInputV1 parity (Pydantic <-> Zod)", () => {
  it("defaults schema_version=1 on an empty input", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkStaleChunksInputV1", kwargs: {} });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(MarkStaleChunksInputV1.parse({}))).toBe(r.out);
  }, 30_000);

  it("both REJECT an unknown extra field", async () => {
    const bad = { bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkStaleChunksInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => MarkStaleChunksInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("MarkStaleChunksOutputV1 parity (Pydantic <-> Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = {
      chunks_marked_stale_default: 3,
      chunks_marked_stale_security_policy: 1,
      threshold_days_default: 180,
      threshold_days_security_policy: 90,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkStaleChunksOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(MarkStaleChunksOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a negative count (ge=0)", async () => {
    const bad = {
      chunks_marked_stale_default: -1,
      chunks_marked_stale_security_policy: 0,
      threshold_days_default: 180,
      threshold_days_security_policy: 90,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkStaleChunksOutputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => MarkStaleChunksOutputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a threshold below 1 (ge=1)", async () => {
    const bad = {
      chunks_marked_stale_default: 0,
      chunks_marked_stale_security_policy: 0,
      threshold_days_default: 0,
      threshold_days_security_policy: 90,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkStaleChunksOutputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => MarkStaleChunksOutputV1.parse(bad)).toThrow();
  }, 30_000);
});
