import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  IntegrationKindV1,
  IntegrationMetadataV1,
  IntegrationProbeResultV1,
} from "#contracts/integrations.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject (and accept-and-strip) must also agree.
//
// NOTE on extra="ignore": IntegrationProbeResultV1 + IntegrationMetadataV1 are ConfigDict(extra="ignore")
// — unknown keys are SILENTLY DROPPED, not rejected. Zod's default .parse() also strips unknowns, so the
// parity assertion for those models is strip-AGREEMENT (identical stripped output), not extra-field rejection.
const PY = "contracts.integrations.v1";

// Lowercase UUIDs (Pydantic lowercases on model_dump(mode="json")) + valid RFC3339 datetimes.
const UID_A = "11111111-1111-1111-1111-111111111111";
const UID_B = "22222222-2222-2222-2222-222222222222";
const UID_C = "33333333-3333-3333-3333-333333333333";

describe("IntegrationProbeResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated probe identically", async () => {
    const payload = {
      success: true,
      latency_ms: 42,
      error_class: null,
      error_message: null,
      probed_at: "2026-06-03T10:00:00+00:00",
      probed_by_ad_user_id: UID_A,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "IntegrationProbeResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(IntegrationProbeResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (error_class/error_message → null) when omitted", async () => {
    const payload = {
      success: false,
      latency_ms: 7,
      error_class: "ConnectionError",
      error_message: "refused",
      probed_at: "2026-06-03T10:00:00.123456+00:00",
      probed_by_ad_user_id: UID_A,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "IntegrationProbeResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(IntegrationProbeResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both STRIP an unknown extra field (extra=ignore ↔ default .parse) — identical output", async () => {
    const payload = {
      success: true,
      latency_ms: 1,
      probed_at: "2026-06-03T10:00:00+00:00",
      probed_by_ad_user_id: UID_A,
      bogus_extra: 99,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "IntegrationProbeResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true); // accepted (stripped), not rejected
    const parsed = IntegrationProbeResultV1.parse(payload);
    expect("bogus_extra" in (parsed as Record<string, unknown>)).toBe(false);
    expect(canonicalize(parsed)).toBe(r.out);
  }, 30_000);

  it("both REJECT a wrong-typed required field (latency_ms not int)", async () => {
    const bad = {
      success: true,
      latency_ms: "not-an-int",
      probed_at: "2026-06-03T10:00:00+00:00",
      probed_by_ad_user_id: UID_A,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "IntegrationProbeResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => IntegrationProbeResultV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("IntegrationMetadataV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload (nested probe + metadata + pending_change) identically", async () => {
    const payload = {
      schema_version: 1,
      id: UID_B,
      name: "github-cloud",
      kind: "github_app_cloud",
      metadata: { region: "us-east-1", api_url: "https://api.github.com" },
      vault_path: "secret/data/integrations/github",
      vault_version: 3,
      enabled: true,
      approval_required: true,
      pending_change: { vault_version: 4 },
      last_tested_at: "2026-06-03T09:00:00+00:00",
      last_tested_by_ad_user_id: UID_C,
      last_test_result: {
        success: true,
        latency_ms: 12,
        error_class: null,
        error_message: null,
        probed_at: "2026-06-03T10:00:00+00:00",
        probed_by_ad_user_id: UID_A,
      },
      created_at: "2026-06-03T08:00:00+00:00",
      updated_at: "2026-06-03T08:30:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "IntegrationMetadataV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(IntegrationMetadataV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=1, metadata={}, enabled=true, pending_change/last_*=null) when omitted", async () => {
    const payload = {
      id: UID_B,
      name: "bedrock-default",
      kind: "bedrock",
      vault_path: "secret/data/integrations/bedrock",
      vault_version: 1,
      approval_required: false,
      created_at: "2026-06-03T08:00:00+00:00",
      updated_at: "2026-06-03T08:30:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "IntegrationMetadataV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(IntegrationMetadataV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("agrees across every IntegrationKindV1 enum member", async () => {
    for (const kind of IntegrationKindV1.options) {
      const payload = {
        id: UID_B,
        name: `n-${kind}`,
        kind,
        vault_path: "secret/x",
        vault_version: 2,
        approval_required: false,
        created_at: "2026-06-03T08:00:00+00:00",
        updated_at: "2026-06-03T08:30:00+00:00",
      };
      const r = await pyRef({ pyModule: PY, pyCallable: "IntegrationMetadataV1", kwargs: payload });
      expect(r.ok, `${kind}: ${r.err}`).toBe(true);
      expect(canonicalize(IntegrationMetadataV1.parse(payload)), kind).toBe(r.out);
    }
  }, 60_000);

  it("both STRIP an unknown extra field (extra=ignore ↔ default .parse) — identical output", async () => {
    const payload = {
      id: UID_B,
      name: "with-extra",
      kind: "confluence",
      vault_path: "secret/c",
      vault_version: 1,
      approval_required: false,
      created_at: "2026-06-03T08:00:00+00:00",
      updated_at: "2026-06-03T08:30:00+00:00",
      bogus_top_level: "drop-me",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "IntegrationMetadataV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true); // accepted (stripped), not rejected
    const parsed = IntegrationMetadataV1.parse(payload);
    expect("bogus_top_level" in (parsed as Record<string, unknown>)).toBe(false);
    expect(canonicalize(parsed)).toBe(r.out);
  }, 30_000);

  it("both REJECT an unknown enum value (kind)", async () => {
    const bad = {
      id: UID_B,
      name: "bad-kind",
      kind: "NOT_A_REAL_KIND",
      vault_path: "secret/x",
      vault_version: 1,
      approval_required: false,
      created_at: "2026-06-03T08:00:00+00:00",
      updated_at: "2026-06-03T08:30:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "IntegrationMetadataV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => IntegrationMetadataV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (approval_required)", async () => {
    const bad = {
      id: UID_B,
      name: "missing-approval",
      kind: "smtp",
      vault_path: "secret/x",
      vault_version: 1,
      created_at: "2026-06-03T08:00:00+00:00",
      updated_at: "2026-06-03T08:30:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "IntegrationMetadataV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => IntegrationMetadataV1.parse(bad)).toThrow();
  }, 30_000);
});
