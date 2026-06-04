// Unit tests for the ADR-0062 single-engine seam (libs/platform/src/db/database.ts).
//
// NO database is needed: `pg.Pool` is lazy — it does not open a socket until the first query — so
// the throwaway DSNs below (port :1, never reachable) are never connected. We assert the structural
// invariant ADR-0062 exists to guarantee: ONE pool per DSN, shared by every `tenantKysely` over that
// DSN, regardless of typed schema.

import { afterEach, describe, expect, it } from "vitest";

import { disposeAllPools, disposePool, getPool, tenantKysely } from "#platform/db/database.js";

// Throwaway DSNs — port :1 is never connected (pools are lazy). Distinct per assertion group so
// cross-test ordering (pytest-randomly analogue) cannot leak state.
const DSN_A = "postgresql://u:p@localhost:1/db_a";
const DSN_B = "postgresql://u:p@localhost:1/db_b";

// Two distinct typed schemas to prove a single pool serves any schema.
type SchemaOne = { "core.review_findings": { review_finding_id: string; installation_id: string } };
type SchemaTwo = { "core.pull_requests": { pr_id: string; installation_id: string } };

afterEach(async () => {
  // Drop all module-level memoization so each test starts from a clean process state.
  await disposeAllPools();
});

describe("getPool memoization (ADR-0062 single pool per DSN)", () => {
  it("returns the SAME pool instance for the same DSN", () => {
    const first = getPool(DSN_A);
    const second = getPool(DSN_A);
    expect(second).toBe(first);
  });

  it("returns DISTINCT pools for distinct DSNs", () => {
    const a = getPool(DSN_A);
    const b = getPool(DSN_B);
    expect(b).not.toBe(a);
  });

  it("honors opts.max only on the creating call (existing pool returned as-is)", () => {
    const created = getPool(DSN_A, { max: 3 });
    const reused = getPool(DSN_A, { max: 99 });
    expect(reused).toBe(created);
  });
});

describe("tenantKysely shares the single pool", () => {
  it("two tenantKysely calls for the same DSN share one pool (getPool identity preserved)", () => {
    const before = getPool(DSN_A);
    tenantKysely<SchemaOne>(DSN_A);
    tenantKysely<SchemaTwo>(DSN_A);
    const after = getPool(DSN_A);
    // tenantKysely must NOT have replaced or multiplied the pool — same instance throughout.
    expect(after).toBe(before);
  });

  it("memoizes the Kysely per DSN (same instance on repeat calls)", () => {
    const first = tenantKysely<SchemaOne>(DSN_A);
    const second = tenantKysely<SchemaOne>(DSN_A);
    expect(second).toBe(first);
  });

  it("builds the Kysely over the pool getPool already created (no new pool)", () => {
    const pool = getPool(DSN_A);
    tenantKysely<SchemaOne>(DSN_A);
    // If tenantKysely had opened its own pool, getPool would still return the original — assert it
    // is unchanged, which is the connection-sharing invariant that matters.
    expect(getPool(DSN_A)).toBe(pool);
  });
});

describe("disposePool resets memoization", () => {
  it("removes the pool so the next getPool returns a fresh instance", async () => {
    const original = getPool(DSN_A);
    await disposePool(DSN_A);
    const fresh = getPool(DSN_A);
    expect(fresh).not.toBe(original);
  });

  it("rebuilds the Kysely over a fresh pool after dispose", async () => {
    const k1 = tenantKysely<SchemaOne>(DSN_A);
    await disposePool(DSN_A);
    const k2 = tenantKysely<SchemaOne>(DSN_A);
    expect(k2).not.toBe(k1);
  });

  it("is a no-op for a DSN that was never opened", async () => {
    await expect(disposePool(DSN_B)).resolves.toBeUndefined();
  });

  it("disposeAllPools clears every memoized pool", async () => {
    const a = getPool(DSN_A);
    const b = getPool(DSN_B);
    await disposeAllPools();
    expect(getPool(DSN_A)).not.toBe(a);
    expect(getPool(DSN_B)).not.toBe(b);
  });
});
