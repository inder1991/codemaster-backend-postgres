import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  RefreshSemanticDocsInputV1,
  RefreshSemanticDocsResultV1,
} from "#contracts/refresh_semantic_docs.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Both models are extra="forbid" → .strict().
const PY = "contracts.refresh_semantic_docs.v1";

// Pydantic lowercases UUIDs on dump → use lowercase UUIDs in payloads.
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const REPOSITORY_ID = "22222222-2222-4222-8222-222222222222";

describe("RefreshSemanticDocsInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 1,
      installation_id: INSTALLATION_ID,
      repository_id: REPOSITORY_ID,
      triggered_by: "default_branch_push",
      head_sha: "abc1234",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RefreshSemanticDocsInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = {
      installation_id: INSTALLATION_ID,
      repository_id: REPOSITORY_ID,
      triggered_by: "manual",
      head_sha: "0123456789abcdef0123456789abcdef01234567",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RefreshSemanticDocsInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts every triggered_by literal identically", async () => {
    for (const triggered_by of ["default_branch_push", "manual", "config_change"]) {
      const payload = {
        installation_id: INSTALLATION_ID,
        repository_id: REPOSITORY_ID,
        triggered_by,
        head_sha: "deadbeef",
      };
      const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsInputV1", kwargs: payload });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(RefreshSemanticDocsInputV1.parse(payload))).toBe(r.out);
    }
  }, 30_000);

  it("both REJECT an unknown triggered_by literal", async () => {
    const bad = {
      installation_id: INSTALLATION_ID,
      repository_id: REPOSITORY_ID,
      triggered_by: "scheduled",
      head_sha: "abc1234",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsInputV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => RefreshSemanticDocsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a head_sha that is too short (< 7)", async () => {
    const bad = {
      installation_id: INSTALLATION_ID,
      repository_id: REPOSITORY_ID,
      triggered_by: "manual",
      head_sha: "abc12",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RefreshSemanticDocsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a head_sha with non-lowercase-hex chars (pattern ^[0-9a-f]+$)", async () => {
    const bad = {
      installation_id: INSTALLATION_ID,
      repository_id: REPOSITORY_ID,
      triggered_by: "manual",
      head_sha: "ABC1234",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RefreshSemanticDocsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-UUID installation_id", async () => {
    const bad = {
      installation_id: "not-a-uuid",
      repository_id: REPOSITORY_ID,
      triggered_by: "manual",
      head_sha: "abc1234",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RefreshSemanticDocsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      installation_id: INSTALLATION_ID,
      repository_id: REPOSITORY_ID,
      triggered_by: "manual",
      head_sha: "abc1234",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RefreshSemanticDocsInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("RefreshSemanticDocsResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 1,
      docs_discovered: 42,
      chunks_persisted: 40,
      chunks_skipped_oversize: 2,
      retrieval_degraded: true,
      degradation_reason: "embed service unreachable",
      duration_ms: 1234,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RefreshSemanticDocsResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=1, retrieval_degraded=false, reason=null) when omitted", async () => {
    const payload = {
      docs_discovered: 0,
      chunks_persisted: 0,
      chunks_skipped_oversize: 0,
      duration_ms: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RefreshSemanticDocsResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a negative count (docs_discovered < 0)", async () => {
    const bad = {
      docs_discovered: -1,
      chunks_persisted: 0,
      chunks_skipped_oversize: 0,
      duration_ms: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RefreshSemanticDocsResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a degradation_reason over max_length (200)", async () => {
    const bad = {
      docs_discovered: 0,
      chunks_persisted: 0,
      chunks_skipped_oversize: 0,
      duration_ms: 0,
      degradation_reason: "x".repeat(201),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RefreshSemanticDocsResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      docs_discovered: 0,
      chunks_persisted: 0,
      chunks_skipped_oversize: 0,
      duration_ms: 0,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshSemanticDocsResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RefreshSemanticDocsResultV1.parse(bad)).toThrow();
  }, 30_000);
});
