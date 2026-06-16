/**
 * Unit tests for the namespaced + legacy-tolerant page-list cursor parser (Option C, Phase 3 — D3).
 *
 * The cursor is opaque to the SPA. The parser is TOTAL: a garbled/stale cursor degrades to the first
 * page — it must NEVER throw (the route would otherwise 422/500 on a cursor it minted in a prior shape).
 */

import { describe, expect, it } from "vitest";

import { parsePagesCursor } from "#backend/api/admin/confluence_pages_read.js";

describe("parsePagesCursor (D3)", () => {
  it("empty / null / undefined → first page", () => {
    expect(parsePagesCursor(null)).toEqual({ kind: "first" });
    expect(parsePagesCursor(undefined)).toEqual({ kind: "first" });
    expect(parsePagesCursor("")).toEqual({ kind: "first" });
  });

  it("live:<opaque> → live with the opaque cursor", () => {
    expect(parsePagesCursor("live:eyJsYXN0SWQiOiIxMjMifQ==")).toEqual({
      kind: "live",
      opaque: "eyJsYXN0SWQiOiIxMjMifQ==",
    });
  });

  it("live: with an empty opaque → first page (not a hang on an empty cursor)", () => {
    expect(parsePagesCursor("live:")).toEqual({ kind: "first" });
  });

  it("stored:<offset> → stored offset", () => {
    expect(parsePagesCursor("stored:50")).toEqual({ kind: "stored", offset: 50 });
    expect(parsePagesCursor("stored:0")).toEqual({ kind: "stored", offset: 0 });
  });

  it("a BARE numeric (legacy pre-namespacing cursor) → stored offset (back-compat)", () => {
    expect(parsePagesCursor("50")).toEqual({ kind: "stored", offset: 50 });
    expect(parsePagesCursor("0")).toEqual({ kind: "stored", offset: 0 });
    expect(parsePagesCursor("200")).toEqual({ kind: "stored", offset: 200 });
  });

  it("a malformed stored offset → first page (never throws)", () => {
    expect(parsePagesCursor("stored:abc")).toEqual({ kind: "first" });
    expect(parsePagesCursor("stored:-5")).toEqual({ kind: "first" });
    expect(parsePagesCursor("stored:")).toEqual({ kind: "first" });
  });

  it("an unknown prefix / garbled cursor → first page (never throws)", () => {
    expect(parsePagesCursor("garbage")).toEqual({ kind: "first" });
    expect(parsePagesCursor("offset=10")).toEqual({ kind: "first" });
    expect(parsePagesCursor("live")).toEqual({ kind: "first" }); // no colon → not the live: namespace
    expect(parsePagesCursor("12ab")).toEqual({ kind: "first" }); // not purely numeric
  });
});
