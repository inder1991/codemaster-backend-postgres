import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  ConfluencePageListV1,
  ConfluencePageSummaryV1,
  ConfluenceSpaceV1,
} from "#contracts/confluence_wire.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. The frozen Python module is
// contracts.integrations.confluence.v1 (ConfluenceSpace / ConfluencePageSummary / ConfluencePageList).
// ConfluencePage parity is already covered by confluence_sync.v1.parity.test.ts (same shape, re-exported).
const PY = "contracts.integrations.confluence.v1";

describe("ConfluenceSpaceV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically (schema_version default 1)", async () => {
    const payload = { space_id: "98765", space_key: "ACME-PILOT", name: "Acme Pilot Space" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluenceSpace", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const z = ConfluenceSpaceV1.parse(payload);
    expect(canonicalize(z)).toBe(r.out);
    expect(z.schema_version).toBe(1);
  }, 30_000);

  it("both REJECT space_key length 0 (min_length=1)", async () => {
    const bad = { space_id: "1", space_key: "", name: "n" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluenceSpace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConfluenceSpaceV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT name length 513 (max_length=512)", async () => {
    const bad = { space_id: "1", space_key: "K", name: "x".repeat(513) };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluenceSpace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConfluenceSpaceV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { space_id: "1", space_key: "K", name: "n", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluenceSpace", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConfluenceSpaceV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ConfluencePageSummaryV1 parity", () => {
  function summary(): Record<string, unknown> {
    return {
      page_id: "111111",
      space_key: "ACME-PILOT",
      title: "Pilot onboarding checklist",
      version: 3,
      last_modified_at: "2026-04-15T10:30:00Z",
    };
  }

  it("validates + dumps a valid payload identically (Z-suffix datetime normalizes)", async () => {
    const payload = summary();
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluencePageSummary", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ConfluencePageSummaryV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT version < 1 (ge=1)", async () => {
    const bad = { ...summary(), version: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluencePageSummary", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConfluencePageSummaryV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT title length 1025 (max_length=1024)", async () => {
    const bad = { ...summary(), title: "t".repeat(1025) };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluencePageSummary", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConfluencePageSummaryV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid)", async () => {
    const bad = { ...summary(), bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluencePageSummary", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConfluencePageSummaryV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ConfluencePageListV1 parity (nested tuple of summaries)", () => {
  // ASCII titles ONLY in the byte-equal compare: the Python ref runner's json.dumps defaults to
  // ensure_ascii=True (escaping a 🚦 to 🚦) while the TS canonicalizer (JSON.stringify) emits
  // the raw codepoint — a pre-existing harness asymmetry, NOT a contract divergence. The same convention
  // confluence_sync.v1.parity.test.ts follows. The non-ASCII round-trip is asserted structurally below.
  function pageList(): Record<string, unknown> {
    return {
      items: [
        {
          page_id: "111111",
          space_key: "ACME-PILOT",
          title: "Pilot onboarding checklist",
          version: 3,
          last_modified_at: "2026-04-15T10:30:00Z",
        },
        {
          page_id: "111112",
          space_key: "ACME-PILOT",
          title: "Confluence sync runbook",
          version: 7,
          last_modified_at: "2026-04-22T14:05:33Z",
        },
      ],
      next_cursor: "eyJsYXN0SWQiOiIxMTExMTMifQ==",
    };
  }

  it("validates + dumps a populated list with a cursor identically", async () => {
    const payload = pageList();
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluencePageList", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ConfluencePageListV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("round-trips a non-ASCII (emoji + RTL) title structurally", () => {
    const payload = {
      items: [
        {
          page_id: "111112",
          space_key: "ACME-PILOT",
          title: "Confluence sync runbook 🚦 صفحة",
          version: 7,
          last_modified_at: "2026-04-22T14:05:33Z",
        },
      ],
    };
    const z = ConfluencePageListV1.parse(payload);
    expect(z.items[0]!.title).toBe("Confluence sync runbook 🚦 صفحة");
  });

  it("applies the same default (next_cursor=null) when omitted", async () => {
    const payload = { items: [] };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluencePageList", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const z = ConfluencePageListV1.parse(payload);
    expect(canonicalize(z)).toBe(r.out);
    expect(z.next_cursor).toBeNull();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid)", async () => {
    const bad = { items: [], bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluencePageList", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConfluencePageListV1.parse(bad)).toThrow();
  }, 30_000);
});
