import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  WorkspaceOrphanSweepResultV1,
  WorkspaceReapEligibleResultV1,
  WorkspaceRetentionPurgeResultV1,
} from "#contracts/workspace_retention_result.v1.js";

afterAll(() => shutdownRef());

// Contract parity for the THREE return contracts of the workspace-retention janitor activities (frozen
// Python, codemaster/activities/workspace_retention.py:73-101 — the models are defined in the ACTIVITY
// module). `ConfigDict(extra="forbid")` → `.strict()`; `schema_version: Literal[1] = 1` →
// `z.literal(1).default(1)`. The int counters carry NO `ge=` constraint (1:1 with the Python — neither
// orphaned_count nor deleted_count has a Field(ge=0)). workspace_ids is `tuple[uuid.UUID, ...]` →
// `z.array(z.string().uuid())` (Pydantic model_dump(mode="json") emits each UUID lowercase + the tuple
// as a JSON array). Round-trip the same payload through Pydantic (oracle) and Zod, diff canonical JSON;
// accept/reject must agree.
const PY = "codemaster.activities.workspace_retention";

describe("WorkspaceOrphanSweepResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = { schema_version: 1, orphaned_count: 3 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceOrphanSweepResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(WorkspaceOrphanSweepResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same default (schema_version=1) when omitted", async () => {
    const payload = { orphaned_count: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceOrphanSweepResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(WorkspaceOrphanSweepResultV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).schema_version).toBe(1);
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { orphaned_count: 1, bogus: 9 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceOrphanSweepResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WorkspaceOrphanSweepResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (orphaned_count)", async () => {
    const bad = { schema_version: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceOrphanSweepResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WorkspaceOrphanSweepResultV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("WorkspaceReapEligibleResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload (UUID tuple) identically", async () => {
    const payload = {
      schema_version: 1,
      workspace_ids: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceReapEligibleResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(WorkspaceReapEligibleResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts an EMPTY workspace_ids tuple (the steady-state nothing-to-reap case)", async () => {
    const payload = { workspace_ids: [] };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceReapEligibleResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(WorkspaceReapEligibleResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an unknown extra field", async () => {
    const bad = { workspace_ids: [], bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceReapEligibleResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WorkspaceReapEligibleResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (workspace_ids)", async () => {
    const bad = { schema_version: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceReapEligibleResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WorkspaceReapEligibleResultV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("WorkspaceRetentionPurgeResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = { schema_version: 1, deleted_count: 7 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceRetentionPurgeResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(WorkspaceRetentionPurgeResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same default (schema_version=1) when omitted", async () => {
    const payload = { deleted_count: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceRetentionPurgeResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(WorkspaceRetentionPurgeResultV1.parse(payload));
    expect(zodCanon).toBe(r.out);
  }, 30_000);

  it("both REJECT an unknown extra field", async () => {
    const bad = { deleted_count: 1, bogus: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceRetentionPurgeResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WorkspaceRetentionPurgeResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (deleted_count)", async () => {
    const bad = { schema_version: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "WorkspaceRetentionPurgeResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => WorkspaceRetentionPurgeResultV1.parse(bad)).toThrow();
  }, 30_000);
});
