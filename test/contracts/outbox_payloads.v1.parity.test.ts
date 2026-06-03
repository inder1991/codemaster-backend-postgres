import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  BedrockPayloadArchivePayloadV1,
  TemporalWorkflowStartPayloadV1,
  VaultCredentialWritePayloadV1,
} from "../../libs/contracts/src/outbox_payloads.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 template.
//
// All three models use ConfigDict(extra="ignore") (NOT extra="forbid"), so the "extra field" case
// asserts AGREEMENT-ON-STRIP (both drop the unknown key → equal canonical), not mutual rejection.
const PY = "contracts.outbox_payloads.v1";

// Lowercase UUIDs only — Pydantic lowercases UUIDs on model_dump(mode="json").
const UUID_A = "12345678-1234-1234-1234-1234567890ab";
const UUID_B = "abcdef01-2345-6789-abcd-ef0123456789";

describe("VaultCredentialWritePayloadV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = {
      integration_id: UUID_A,
      vault_path: "secret/codemaster/integrations/github",
      secret_material: { token: "ghp_abc", webhook_secret: "whsec_def" },
      expected_vault_version_after: 5,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "VaultCredentialWritePayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(VaultCredentialWritePayloadV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults when optional fields omitted", async () => {
    const payload = {
      integration_id: UUID_A,
      vault_path: "secret/codemaster/x",
      secret_material: { k: "v" },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "VaultCredentialWritePayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(VaultCredentialWritePayloadV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.expected_vault_version_after).toBeNull();
  }, 30_000);

  it("both ACCEPT an explicit null expected_vault_version_after identically", async () => {
    const payload = {
      integration_id: UUID_A,
      vault_path: "p",
      secret_material: {},
      expected_vault_version_after: null,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "VaultCredentialWritePayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(VaultCredentialWritePayloadV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both STRIP an unknown extra field identically (extra=ignore ↔ default strip)", async () => {
    const payload = {
      integration_id: UUID_A,
      vault_path: "p",
      secret_material: { a: "b" },
      bogus: "dropped",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "VaultCredentialWritePayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(VaultCredentialWritePayloadV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).bogus).toBeUndefined();
  }, 30_000);

  it("both REJECT a malformed UUID (integration_id)", async () => {
    const bad = { integration_id: "not-a-uuid", vault_path: "p", secret_material: { a: "b" } };
    const r = await pyRef({ pyModule: PY, pyCallable: "VaultCredentialWritePayloadV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => VaultCredentialWritePayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-string secret_material value", async () => {
    const bad = { integration_id: UUID_A, vault_path: "p", secret_material: { a: 123 } };
    const r = await pyRef({ pyModule: PY, pyCallable: "VaultCredentialWritePayloadV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => VaultCredentialWritePayloadV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("TemporalWorkflowStartPayloadV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (mixed args + search_attributes)", async () => {
    const payload = {
      schema_version: 2,
      workflow_type: "ReviewPullRequestWorkflow",
      workflow_id: "review/1/2/3",
      task_queue: "review-default",
      args: [1, "a", { k: 2 }, [true]],
      execution_timeout_seconds: 1200,
      run_timeout_seconds: 1200,
      search_attributes: { x: 1, y: [1, 2] },
      id_reuse_policy: "REJECT_DUPLICATE",
      id_conflict_policy: "USE_EXISTING",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "TemporalWorkflowStartPayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(TemporalWorkflowStartPayloadV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted", async () => {
    const payload = { workflow_type: "W", workflow_id: "id", task_queue: "q" };
    const r = await pyRef({ pyModule: PY, pyCallable: "TemporalWorkflowStartPayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(TemporalWorkflowStartPayloadV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    // Defaults: schema_version=2, args=[], timeouts=900, search_attributes={}, policies as documented.
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(2);
    expect(z.args).toEqual([]);
    expect(z.execution_timeout_seconds).toBe(900);
    expect(z.run_timeout_seconds).toBe(900);
    expect(z.search_attributes).toEqual({});
    expect(z.id_reuse_policy).toBe("ALLOW_DUPLICATE");
    expect(z.id_conflict_policy).toBe("TERMINATE_EXISTING");
  }, 30_000);

  it("both ACCEPT the legacy schema_version=1 identically", async () => {
    const payload = { schema_version: 1, workflow_type: "W", workflow_id: "id", task_queue: "q" };
    const r = await pyRef({ pyModule: PY, pyCallable: "TemporalWorkflowStartPayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(TemporalWorkflowStartPayloadV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).schema_version).toBe(1);
  }, 30_000);

  it("both STRIP an unknown extra field identically (extra=ignore ↔ default strip)", async () => {
    const payload = { workflow_type: "W", workflow_id: "id", task_queue: "q", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "TemporalWorkflowStartPayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(TemporalWorkflowStartPayloadV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).bogus).toBeUndefined();
  }, 30_000);

  it("both REJECT an out-of-range execution_timeout_seconds (< 1)", async () => {
    const bad = { workflow_type: "W", workflow_id: "id", task_queue: "q", execution_timeout_seconds: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "TemporalWorkflowStartPayloadV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => TemporalWorkflowStartPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-range run_timeout_seconds (> 86400)", async () => {
    const bad = { workflow_type: "W", workflow_id: "id", task_queue: "q", run_timeout_seconds: 86401 };
    const r = await pyRef({ pyModule: PY, pyCallable: "TemporalWorkflowStartPayloadV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => TemporalWorkflowStartPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid schema_version (3 not in {1,2})", async () => {
    const bad = { schema_version: 3, workflow_type: "W", workflow_id: "id", task_queue: "q" };
    const r = await pyRef({ pyModule: PY, pyCallable: "TemporalWorkflowStartPayloadV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => TemporalWorkflowStartPayloadV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-vocabulary id_reuse_policy", async () => {
    const bad = { workflow_type: "W", workflow_id: "id", task_queue: "q", id_reuse_policy: "BOGUS" };
    const r = await pyRef({ pyModule: PY, pyCallable: "TemporalWorkflowStartPayloadV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => TemporalWorkflowStartPayloadV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("BedrockPayloadArchivePayloadV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (bytes→utf8 string wire shape)", async () => {
    const payload = {
      llm_call_id: UUID_B,
      payload_bytes_zstd: "compressed-bytes-as-ascii",
      target_uri_prefix: "postgres://telemetry/llm_payloads/",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "BedrockPayloadArchivePayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(BedrockPayloadArchivePayloadV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).schema_version).toBe(1);
  }, 30_000);

  it("lowercases an upper-cased UUID input identically (Pydantic UUID dump)", async () => {
    const payload = {
      llm_call_id: UUID_B.toUpperCase(),
      payload_bytes_zstd: "x",
      target_uri_prefix: "s3://b/",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "BedrockPayloadArchivePayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    // Pydantic lowercases the UUID; Zod's z.string().uuid() accepts upper-case but does NOT lowercase,
    // so we compare the Zod output AFTER applying the same lowercasing the canonical contract emits.
    const parsed = BedrockPayloadArchivePayloadV1.parse(payload);
    const lowered = { ...parsed, llm_call_id: parsed.llm_call_id.toLowerCase() };
    expect(canonicalize(lowered)).toBe(r.out);
  }, 30_000);

  it("both STRIP an unknown extra field identically (extra=ignore ↔ default strip)", async () => {
    const payload = {
      llm_call_id: UUID_B,
      payload_bytes_zstd: "x",
      target_uri_prefix: "p",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "BedrockPayloadArchivePayloadV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(BedrockPayloadArchivePayloadV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).bogus).toBeUndefined();
  }, 30_000);

  it("both REJECT a malformed UUID (llm_call_id)", async () => {
    const bad = { llm_call_id: "nope", payload_bytes_zstd: "x", target_uri_prefix: "p" };
    const r = await pyRef({ pyModule: PY, pyCallable: "BedrockPayloadArchivePayloadV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => BedrockPayloadArchivePayloadV1.parse(bad)).toThrow();
  }, 30_000);
});
