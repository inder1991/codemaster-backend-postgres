import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { RepairInstallationRepositoriesPayloadV1 } from "#contracts/repair_installation_repositories.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `RepairInstallationRepositoriesPayloadV1(**payload).model_dump(mode="json")`)
// and through Zod (`RepairInstallationRepositoriesPayloadV1.parse(payload)`), then diff canonical JSON.
// Accept/reject must also agree. NON-STANDARD module path: versioned FILE, not v1/ dir.
const PY = "contracts.repair_installation_repositories.payload_v1";
const CALLABLE = "RepairInstallationRepositoriesPayloadV1";

describe("RepairInstallationRepositoriesPayloadV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically (all fields)", async () => {
    const payload = {
      schema_version: 1,
      github_installation_id: 42,
      trigger_source: "pr_webhook",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RepairInstallationRepositoriesPayloadV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = { github_installation_id: 7, trigger_source: "installation_created" };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RepairInstallationRepositoriesPayloadV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("agrees on each trigger_source literal", async () => {
    const sources: ReadonlyArray<string> = ["pr_webhook", "admin_manual", "installation_created"];
    for (const trigger_source of sources) {
      const payload = { github_installation_id: 1, trigger_source };
      const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: payload });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(RepairInstallationRepositoriesPayloadV1.parse(payload))).toBe(r.out);
    }
  }, 30_000);

  it("both REJECT github_installation_id below ge=1 (0)", async () => {
    const bad = { github_installation_id: 0, trigger_source: "pr_webhook" };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => RepairInstallationRepositoriesPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-integer github_installation_id (float)", async () => {
    const bad = { github_installation_id: 1.5, trigger_source: "pr_webhook" };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RepairInstallationRepositoriesPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown trigger_source literal", async () => {
    const bad = { github_installation_id: 1, trigger_source: "admin_forced" };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RepairInstallationRepositoriesPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-1 schema_version literal", async () => {
    const bad = { schema_version: 2, github_installation_id: 1, trigger_source: "pr_webhook" };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RepairInstallationRepositoriesPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { github_installation_id: 1, trigger_source: "pr_webhook", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RepairInstallationRepositoriesPayloadV1.parse(bad)).toThrow();
  }, 30_000);
});
