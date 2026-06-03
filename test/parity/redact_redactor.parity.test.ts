import { afterAll, describe, expect, it } from "vitest";

import { pyRedact, shutdownRedactRef } from "./redact_oracle.js";
import { redactText } from "#backend/redact/output_redaction.js";

afterAll(() => shutdownRedactRef());

// Byte-parity of the TS `redactText` against the frozen Python `redact_text` given IDENTICAL
// findings. For each case we drive the live Python ref (pyRedact) and assert the TS port returns the
// exact same { redactedText, spansRedacted }. The findings carry only offsets — that is all
// redact_text consumes — so this proves the span-collection / overlap-merge / rebuild logic matches
// the source-of-truth byte-for-byte across ordering, overlap, adjacency, and boundary edge cases.
type Span = { start_offset: number; end_offset: number };

async function assertParity(text: string, findings: ReadonlyArray<Span>): Promise<void> {
  const py = await pyRedact({ text, findings });
  expect(redactText(text, findings)).toEqual({
    redactedText: py.redactedText,
    spansRedacted: py.spansRedacted,
  });
}

describe("redactText parity (TS ↔ frozen Python redact_text)", () => {
  it("empty findings → text unchanged, 0 spans", async () => {
    await assertParity("the quick brown fox", []);
  }, 30_000);

  it("one span in the middle", async () => {
    await assertParity("AKIAhello world", [{ start_offset: 0, end_offset: 4 }]);
  }, 30_000);

  it("multiple disjoint spans", async () => {
    await assertParity("alpha beta gamma delta", [
      { start_offset: 0, end_offset: 5 },
      { start_offset: 11, end_offset: 16 },
    ]);
  }, 30_000);

  it("out-of-order findings (internally sorted by offset)", async () => {
    await assertParity("alpha beta gamma delta", [
      { start_offset: 11, end_offset: 16 },
      { start_offset: 0, end_offset: 5 },
    ]);
  }, 30_000);

  it("overlapping spans are unioned into one", async () => {
    await assertParity("abcdefghij", [
      { start_offset: 2, end_offset: 6 },
      { start_offset: 4, end_offset: 8 },
    ]);
  }, 30_000);

  it("adjacent spans (start == previous end) are unioned once", async () => {
    await assertParity("abcdefghij", [
      { start_offset: 2, end_offset: 5 },
      { start_offset: 5, end_offset: 8 },
    ]);
  }, 30_000);

  it("span at the start of the string", async () => {
    await assertParity("abcdefghij", [{ start_offset: 0, end_offset: 4 }]);
  }, 30_000);

  it("span at the end of the string", async () => {
    await assertParity("abcdefghij", [{ start_offset: 6, end_offset: 10 }]);
  }, 30_000);

  it("whole-string span", async () => {
    await assertParity("abcdefghij", [{ start_offset: 0, end_offset: 10 }]);
  }, 30_000);

  it("zero-width span (end == start) is ignored", async () => {
    await assertParity("abcdefghij", [{ start_offset: 4, end_offset: 4 }]);
  }, 30_000);

  it("zero-width span mixed with a real span (only the real one redacts)", async () => {
    await assertParity("abcdefghij", [
      { start_offset: 3, end_offset: 3 },
      { start_offset: 6, end_offset: 9 },
    ]);
  }, 30_000);

  it("three spans, out of order, with one overlap collapsing to two merged", async () => {
    await assertParity("zero one two three four five", [
      { start_offset: 14, end_offset: 19 }, // "three"
      { start_offset: 0, end_offset: 4 }, // "zero"
      { start_offset: 16, end_offset: 22 }, // overlaps the "three" span
    ]);
  }, 30_000);
});
