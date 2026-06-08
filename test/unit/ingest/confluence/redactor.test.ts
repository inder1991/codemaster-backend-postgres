// Unit tests for redactChunk — 1:1 port of the frozen Python
// vendor/codemaster-py/codemaster/ingest/confluence/redactor.py::redact_chunk.
//
// The golden `text` / `redaction_applied` vectors below were produced by the LIVE frozen Python
// (PYTHONPATH=vendor/codemaster-py .venv/bin/python -c "from ...redactor import redact_chunk; ..."),
// so the TS port is held byte-for-byte to the source-of-truth — including the Sprint-7 PII redactor
// pass (the TS redactChunk wires the already-ported redactPii, the analogue of the Python
// _apply_sprint7_redactor's RegexPiiRedactor().redact()).

import { describe, expect, it } from "vitest";

import { redactChunk } from "#backend/ingest/confluence/redactor.js";

describe("redactChunk", () => {
  // [input, expected wrapped text, expected redaction_applied] — golden vectors from frozen Python.
  const golden: ReadonlyArray<readonly [string, string, boolean]> = [
    [
      "just normal prose with no secrets",
      '<doc trust="untrusted">just normal prose with no secrets</doc>',
      false,
    ],
    ["token: abcdef123456", '<doc trust="untrusted">token=<REDACTED></doc>', true],
    [
      "config\nbearer: supersecretvalue\nmore",
      '<doc trust="untrusted">config\nbearer=<REDACTED>\nmore</doc>',
      true,
    ],
    [
      "Use bearer=abc123 inline here",
      '<doc trust="untrusted">Use bearer=<REDACTED> inline here</doc>',
      true,
    ],
    [
      "api_key=XYZ in the middle",
      '<doc trust="untrusted">api_key=<REDACTED> <REDACTED> in the middle</doc>',
      true,
    ],
    ["API-KEY: topsecret", '<doc trust="untrusted">API-KEY=<REDACTED></doc>', true],
    [
      "Contact admin@example.com for access",
      '<doc trust="untrusted">Contact [REDACTED:email] for access</doc>',
      true,
    ],
    ["password: hunter2", '<doc trust="untrusted">password: <REDACTED></doc>', true],
    ["", '<doc trust="untrusted"></doc>', false],
  ];

  it.each(golden)("byte-matches frozen Python for %j", (input, expectedText, expectedApplied) => {
    const r = redactChunk(input);
    expect(r.text).toBe(expectedText);
    expect(r.redaction_applied).toBe(expectedApplied);
  });

  it("always wraps output in the trust-tier tag", () => {
    const r = redactChunk("anything");
    expect(r.text.startsWith('<doc trust="untrusted">')).toBe(true);
    expect(r.text.endsWith("</doc>")).toBe(true);
  });
});
