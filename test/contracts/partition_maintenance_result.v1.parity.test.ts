import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { PartitionMaintenanceResultV1 } from "#contracts/partition_maintenance_result.v1.js";

afterAll(() => shutdownRef());

// Contract parity for the RETURN contract of `run_pg_partman_maintenance` (frozen Python,
// codemaster/workflows/partition_maintenance.py:23-30 — the model is defined in the WORKFLOW module, the
// activity imports it). `ConfigDict(extra="forbid")` → `.strict()`; both int fields carry NO `ge=`
// constraint (1:1 with review_run_reaper_result, NOT retention.v1 which uses ge=0). `schema_version: int
// = 1` → `z.number().int().default(1)` (a plain int default, NOT a Literal). Round-trip the same payload
// through Pydantic (oracle) and Zod, diff canonical JSON; accept/reject must agree.
const PY = "codemaster.workflows.partition_maintenance";

describe("PartitionMaintenanceResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = { schema_version: 1, tables_processed: 2, partitions_created: 3 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PartitionMaintenanceResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PartitionMaintenanceResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same default (schema_version=1) when omitted", async () => {
    const payload = { tables_processed: 0, partitions_created: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PartitionMaintenanceResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(PartitionMaintenanceResultV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).schema_version).toBe(1);
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { tables_processed: 1, partitions_created: 1, bogus: 9 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PartitionMaintenanceResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PartitionMaintenanceResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (partitions_created)", async () => {
    const bad = { tables_processed: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PartitionMaintenanceResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PartitionMaintenanceResultV1.parse(bad)).toThrow();
  }, 30_000);
});
