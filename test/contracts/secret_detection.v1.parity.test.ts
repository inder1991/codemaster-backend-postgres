import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { SecretFindingV1 } from "#contracts/secret_detection.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `SecretFindingV1(**payload).model_dump(mode="json")`) and through Zod (`SecretFindingV1.parse`),
// then diff canonical JSON. Accept/reject must also agree. Follows the tool_status.v1 template.
//
// `confidence` is a bare Python `float`: model_dump(mode="json") emits `0.99` / `1.0` while a JS
// number emits its shortest form, so the canonicalizer (which rejects bare floats) can never
// byte-match that one column. Strip it from BOTH canonical strings so every OTHER field is still
// proven byte-equal, and assert confidence separately (structurally + range-reject). Mirrors
// review_findings.v1's dropConfidence helper.
const PY = "contracts.secret_detection.v1";

// Strip `confidence` BEFORE canonicalizing — the canonicalizer rejects bare floats (e.g. 0.99), so
// we must remove the float column first, then canonicalize the remaining (key-sorted) object.
function dropConfidence(obj: Record<string, unknown>): string {
  const o = { ...obj };
  delete o.confidence;
  return canonicalize(o);
}

describe("SecretFindingV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically (confidence column excepted)", async () => {
    const payload = {
      schema_version: 1,
      kind: "github_pat",
      snippet_redacted: "ghp_…aaaa",
      start_offset: 6,
      end_offset: 46,
      confidence: 0.99,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SecretFindingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodObj = SecretFindingV1.parse(payload) as Record<string, unknown>;
    const pyObj = JSON.parse(r.out!) as Record<string, unknown>;
    expect(dropConfidence(zodObj)).toBe(dropConfidence(pyObj));
    // confidence still round-trips structurally (both sides keep the value, modulo float form).
    expect(zodObj.confidence).toBe(0.99);
    expect(pyObj.confidence).toBe(0.99);
  }, 30_000);

  it("applies the schema_version default (1) when omitted", async () => {
    const payload = {
      kind: "aws_access_key_id",
      snippet_redacted: "AKIA…MPLE",
      start_offset: 0,
      end_offset: 20,
      confidence: 1, // → 1.0 Python / 1 JS
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SecretFindingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodObj = SecretFindingV1.parse(payload) as Record<string, unknown>;
    const pyObj = JSON.parse(r.out!) as Record<string, unknown>;
    expect(dropConfidence(zodObj)).toBe(dropConfidence(pyObj));
    expect(zodObj.schema_version).toBe(1);
  }, 30_000);

  it("accepts the confidence boundaries (0 and 1) identically", async () => {
    for (const confidence of [0, 1]) {
      const payload = {
        kind: "vault_token",
        snippet_redacted: "hvs.…wxyz",
        start_offset: 0,
        end_offset: 24,
        confidence,
      };
      const r = await pyRef({ pyModule: PY, pyCallable: "SecretFindingV1", kwargs: payload });
      expect(r.ok, r.err).toBe(true);
      const zodObj = SecretFindingV1.parse(payload) as Record<string, unknown>;
      const pyObj = JSON.parse(r.out!) as Record<string, unknown>;
      expect(dropConfidence(zodObj)).toBe(dropConfidence(pyObj));
      expect(zodObj.confidence).toBe(confidence);
    }
  }, 30_000);

  it("both REJECT confidence out of [0,1] (le=1.0)", async () => {
    const bad = {
      kind: "github_pat",
      snippet_redacted: "ghp_…aaaa",
      start_offset: 0,
      end_offset: 40,
      confidence: 1.5,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SecretFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SecretFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a negative confidence (ge=0.0)", async () => {
    const bad = {
      kind: "github_pat",
      snippet_redacted: "ghp_…aaaa",
      start_offset: 0,
      end_offset: 40,
      confidence: -0.1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SecretFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SecretFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-range value (start_offset < 0, ge=0)", async () => {
    const bad = {
      kind: "github_pat",
      snippet_redacted: "ghp_…aaaa",
      start_offset: -1,
      end_offset: 40,
      confidence: 0.9,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SecretFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SecretFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty kind (min_length=1)", async () => {
    const bad = {
      kind: "",
      snippet_redacted: "ghp_…aaaa",
      start_offset: 0,
      end_offset: 40,
      confidence: 0.9,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SecretFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SecretFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty snippet_redacted (min_length=1)", async () => {
    const bad = {
      kind: "github_pat",
      snippet_redacted: "",
      start_offset: 0,
      end_offset: 40,
      confidence: 0.9,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SecretFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SecretFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (snippet_redacted absent)", async () => {
    const bad = {
      kind: "github_pat",
      start_offset: 0,
      end_offset: 40,
      confidence: 0.9,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SecretFindingV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic: Field required
    expect(() => SecretFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      kind: "github_pat",
      snippet_redacted: "ghp_…aaaa",
      start_offset: 0,
      end_offset: 40,
      confidence: 0.9,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SecretFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SecretFindingV1.parse(bad)).toThrow();
  }, 30_000);
});
