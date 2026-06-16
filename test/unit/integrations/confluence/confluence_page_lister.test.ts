/**
 * Unit tests for the ConfluencePageLister adapter (Phase 1 of Option C — live-page approval view).
 *
 * The lister resolves the ACTIVE decrypted Confluence creds the SAME way the ingest sync + the
 * space-validator do (PostgresConfluenceSettingsRepo.read), builds a FAST-FAIL ConfluenceClient
 * (Phase 0: maxAttempts=1, no backoff sleep) + threads the caller's AbortSignal, and lists one page
 * of the space's LIVE pages. It returns `{ items, next_cursor }` or THROWS (caught by the read
 * handler, which falls back to the stored query). NO network, NO DB — the settings reader + client
 * factory are injected stubs here.
 */

import { describe, expect, it } from "vitest";

import {
  makeConfluencePageLister,
  type ConfluenceListPagesClient,
} from "#backend/integrations/confluence/confluence_page_lister.js";
import { type ConfluenceSettings } from "#backend/integrations/confluence/confluence_settings_repo.js";

const SETTINGS: ConfluenceSettings = {
  baseUrl: "https://wiki.acme.com/wiki",
  authEmail: "svc@acme.com",
  token: "ATATT-secret-token-value",
  enabled: true,
};

/** A stub client returning a scripted page list, recording the args it was called with. */
function stubClient(
  result:
    | { items: ReadonlyArray<{ page_id: string; title: string; version: number; last_modified_at: string }>; next_cursor: string | null }
    | { throws: Error },
): {
  client: ConfluenceListPagesClient;
  calls: () => ReadonlyArray<{ spaceKey: string; cursor: string | null; signalled: boolean }>;
} {
  const calls: Array<{ spaceKey: string; cursor: string | null; signalled: boolean }> = [];
  const client: ConfluenceListPagesClient = {
    async listPages({ spaceKey, cursor = null, signal }) {
      calls.push({ spaceKey, cursor: cursor ?? null, signalled: signal !== undefined });
      if ("throws" in result) throw result.throws;
      return { schema_version: 1, items: result.items.map((i) => ({ schema_version: 1, space_key: spaceKey, ...i })), next_cursor: result.next_cursor };
    },
  };
  return { client, calls: () => calls };
}

describe("ConfluencePageLister — happy path", () => {
  it("maps the client page list into items + cursor, threading spaceKey/cursor/signal", async () => {
    const { client, calls } = stubClient({
      items: [
        { page_id: "196626", title: "Default Page", version: 4, last_modified_at: "2026-06-10T00:00:00Z" },
        { page_id: "196627", title: "Other Page", version: 1, last_modified_at: "2026-06-09T00:00:00Z" },
      ],
      next_cursor: "opaque-cursor-xyz",
    });
    const lister = makeConfluencePageLister({
      readSettings: async () => SETTINGS,
      makeClient: () => client,
    });
    const controller = new AbortController();
    const page = await lister.listSpacePages({ spaceKey: "SEP", cursor: "prev-cursor", signal: controller.signal });

    expect(page.items.map((i) => i.page_id)).toEqual(["196626", "196627"]);
    expect(page.items[0]).toMatchObject({ space_key: "SEP", title: "Default Page", version: 4 });
    expect(page.next_cursor).toBe("opaque-cursor-xyz");
    // The client was called once with the resolved space + the caller's cursor + a signal.
    expect(calls()).toEqual([{ spaceKey: "SEP", cursor: "prev-cursor", signalled: true }]);
  });

  it("builds a FAST-FAIL client from the resolved creds (authEmail → Basic when present)", async () => {
    const seen: Array<{ baseUrl: string; token: string; authEmail: string | null; fastFail: boolean }> = [];
    const lister = makeConfluencePageLister({
      readSettings: async () => SETTINGS,
      makeClient: (creds) => {
        seen.push(creds);
        return stubClient({ items: [], next_cursor: null }).client;
      },
    });
    await lister.listSpacePages({ spaceKey: "SEP", cursor: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      baseUrl: "https://wiki.acme.com/wiki",
      token: "ATATT-secret-token-value",
      authEmail: "svc@acme.com",
      fastFail: true,
    });
  });
});

describe("ConfluencePageLister — throws (caught upstream by the read handler)", () => {
  it("throws when Confluence is unconfigured (no active creds)", async () => {
    const lister = makeConfluencePageLister({
      readSettings: async () => null,
      makeClient: () => stubClient({ items: [], next_cursor: null }).client,
    });
    await expect(lister.listSpacePages({ spaceKey: "SEP", cursor: null })).rejects.toThrow();
  });

  it("propagates a client error (e.g. unreachable/aborted) so the caller can fall back", async () => {
    const boom = new Error("ConfluenceRetryableError: GET /api/v2/pages unreachable after 1 attempts");
    const lister = makeConfluencePageLister({
      readSettings: async () => SETTINGS,
      makeClient: () => stubClient({ throws: boom }).client,
    });
    await expect(lister.listSpacePages({ spaceKey: "SEP", cursor: null })).rejects.toBe(boom);
  });

  it("propagates a settings-read failure (DB/decrypt)", async () => {
    const dbErr = new Error("decrypt failed");
    const lister = makeConfluencePageLister({
      readSettings: async () => {
        throw dbErr;
      },
      makeClient: () => stubClient({ items: [], next_cursor: null }).client,
    });
    await expect(lister.listSpacePages({ spaceKey: "SEP", cursor: null })).rejects.toBe(dbErr);
  });
});

describe("ConfluencePageLister — default-deps guard", () => {
  it("requires { db, registry } when no readSettings is injected", () => {
    // The production path builds the default settings reader from {db, registry}; omitting both AND
    // readSettings must fail loudly at construction-use rather than silently no-op.
    const lister = makeConfluencePageLister({});
    return expect(lister.listSpacePages({ spaceKey: "SEP", cursor: null })).rejects.toThrow(/db.*registry|registry.*db/i);
  });
});
