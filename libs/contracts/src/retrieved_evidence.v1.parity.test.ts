import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../../../test/parity/canonical.js";
import { pyRef, shutdownRef } from "../../../test/parity/oracle.js";
import {
  EVIDENCE_PRIORITY,
  RetrievedEvidenceV1,
  mintEvidenceId,
} from "./retrieved_evidence.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `RetrievedEvidenceV1(**payload).model_dump(mode="json")`) and
// through Zod (`RetrievedEvidenceV1.parse(payload)`), then diff canonical JSON. Accept/reject agree.
const PY = "contracts.retrieved_evidence.v1";

describe("RetrievedEvidenceV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = {
      evidence_id: "ev_0123456789abcdef",
      source_type: "chunk_body",
      chunk_id: "11111111-1111-1111-1111-111111111111",
      knowledge_chunk_id: "22222222-2222-2222-2222-222222222222",
      path: "src/a/b.py",
      excerpt: "the cited evidence excerpt",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedEvidenceV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RetrievedEvidenceV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same None defaults (chunk_id / knowledge_chunk_id / path) when omitted", async () => {
    const payload = {
      evidence_id: "ev_dd02004cb7045dba",
      source_type: "tool_status",
      excerpt: "x",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedEvidenceV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RetrievedEvidenceV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("round-trips every source_type identically", async () => {
    for (const source_type of EVIDENCE_PRIORITY) {
      const payload = {
        evidence_id: "ev_abcdef0123456789",
        source_type,
        excerpt: "evidence for " + source_type,
      };
      const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedEvidenceV1", kwargs: payload });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(RetrievedEvidenceV1.parse(payload))).toBe(r.out);
    }
  }, 30_000);

  it("both REJECT a malformed evidence_id (pattern violation)", async () => {
    const bad = {
      evidence_id: "EV_NOTHEX",
      source_type: "chunk_body",
      excerpt: "x",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedEvidenceV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => RetrievedEvidenceV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-range value (empty excerpt, min_length=1)", async () => {
    const bad = {
      evidence_id: "ev_0123456789abcdef",
      source_type: "chunk_body",
      excerpt: "",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedEvidenceV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievedEvidenceV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid source_type (not in the Literal enum)", async () => {
    const bad = {
      evidence_id: "ev_0123456789abcdef",
      source_type: "bogus_source",
      excerpt: "x",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedEvidenceV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievedEvidenceV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      evidence_id: "ev_0123456789abcdef",
      source_type: "chunk_body",
      excerpt: "x",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrievedEvidenceV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrievedEvidenceV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("mint_evidence_id parity (Pydantic ↔ Zod)", () => {
  // The oracle calls `fn(**kwargs)`, so only the empty-`*parts` path (source_type alone) is drivable
  // through it. That path still exercises the full algorithm: sha256("") → uuid5 → 16-hex truncation.
  it("mints the same deterministic ev_id for every source_type (empty parts)", async () => {
    for (const source_type of EVIDENCE_PRIORITY) {
      const r = await pyRef({
        pyModule: PY,
        pyCallable: "mint_evidence_id",
        kwargs: { source_type },
      });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(mintEvidenceId(source_type))).toBe(r.out);
    }
  }, 30_000);

  it("output matches the RetrievedEvidenceV1.evidence_id pattern", () => {
    for (const source_type of EVIDENCE_PRIORITY) {
      expect(mintEvidenceId(source_type)).toMatch(/^ev_[0-9a-f]{16}$/);
    }
  });
});
