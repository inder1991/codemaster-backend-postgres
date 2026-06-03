import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../../../test/parity/canonical.js";
import { pyRef, shutdownRef } from "../../../test/parity/oracle.js";
import { ToolFindingV1 } from "./tool_findings.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `ToolFindingV1(**payload).model_dump(mode="json")`) and through
// Zod (`ToolFindingV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
// UUIDs are spelled lowercase so Pydantic's lowercasing-on-dump matches Zod's pass-through.
const PY = "contracts.tool_findings.v1";

describe("ToolFindingV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = {
      schema_version: 1,
      finding_id: "550e8400-e29b-41d4-a716-446655440000",
      review_id: "123e4567-e89b-12d3-a456-426614174000",
      tool_name: "semgrep",
      rule_id: "python.lang.security.audit.eval",
      severity: "issue",
      file_path: "src/app.py",
      line: 10,
      message: "eval() is dangerous on untrusted input",
      snippet: "result = eval(user_input)",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolFindingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ToolFindingV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version (1) + snippet ('') defaults when omitted", async () => {
    const payload = {
      finding_id: "00000000-0000-4000-8000-000000000000",
      review_id: "11111111-1111-4111-8111-111111111111",
      tool_name: "trivy",
      rule_id: "CVE-2024-0001",
      severity: "blocker",
      file_path: "requirements.txt",
      line: 1,
      message: "vulnerable dependency",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolFindingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ToolFindingV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an out-of-range value (line < 1)", async () => {
    const bad = {
      finding_id: "550e8400-e29b-41d4-a716-446655440000",
      review_id: "123e4567-e89b-12d3-a456-426614174000",
      tool_name: "semgrep",
      rule_id: "r",
      severity: "nit",
      file_path: "a",
      line: 0,
      message: "m",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolFindingV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => ToolFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown tool_name (Literal ↔ z.enum)", async () => {
    const bad = {
      finding_id: "550e8400-e29b-41d4-a716-446655440000",
      review_id: "123e4567-e89b-12d3-a456-426614174000",
      tool_name: "eslint",
      rule_id: "r",
      severity: "nit",
      file_path: "a",
      line: 1,
      message: "m",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ToolFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a snippet over max_length (200)", async () => {
    const bad = {
      finding_id: "550e8400-e29b-41d4-a716-446655440000",
      review_id: "123e4567-e89b-12d3-a456-426614174000",
      tool_name: "semgrep",
      rule_id: "r",
      severity: "nit",
      file_path: "a",
      line: 1,
      message: "m",
      snippet: "x".repeat(201),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ToolFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      finding_id: "550e8400-e29b-41d4-a716-446655440000",
      review_id: "123e4567-e89b-12d3-a456-426614174000",
      tool_name: "semgrep",
      rule_id: "r",
      severity: "nit",
      file_path: "a",
      line: 1,
      message: "m",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ToolFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ToolFindingV1.parse(bad)).toThrow();
  }, 30_000);
});
