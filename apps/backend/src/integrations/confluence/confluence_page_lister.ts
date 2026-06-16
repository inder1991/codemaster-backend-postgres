/**
 * ConfluencePageLister — the LIVE-page list seam for the admin per-space pages view (Option C, Phase 1).
 *
 * Problem (plan §1): `listPagesForIntegration` lists pages FROM core.confluence_chunks — only STORED
 * pages. A never-approved `default`-labeled page has 0 chunks (the ingest biconditional rejects it until
 * approved), so it is invisible → unapprovable → deadlocked. This port surfaces the space's pages from
 * LIVE Confluence so any page is visible + approvable (approve-then-ingest).
 *
 * It mirrors the creds resolution of the space-validator (confluence_validator_real.ts): it reads the
 * ACTIVE decrypted platform-scope creds the SAME way the ingest sync resolves them
 * (PostgresConfluenceSettingsRepo({db, registry}).read() — the field-codec-decrypted row), then builds a
 * FAST-FAIL ConfluenceClient (Phase 0: maxAttempts=1, no backoff sleep) and threads the caller's
 * AbortSignal so a per-request deadline cancels the in-flight transport.
 *
 * `listSpacePages` returns `{ items, next_cursor }` (mapped page summaries + the opaque next cursor) or
 * THROWS. The read handler catches a throw and falls back to the stored query with
 * `live_list_available: false` — the live read is NEVER a hard dependency of the admin page.
 *
 * The injected settings reader / client factory are the unit-test seams (stubbed — no network, no DB);
 * production omits them and the real defaults are used.
 */

import { type Kysely } from "kysely";

import { type KeyRegistry } from "#platform/crypto/key_registry.js";

import { ConfluenceClient } from "#backend/integrations/confluence/client.js";
import {
  type ConfluenceSettings,
  PostgresConfluenceSettingsRepo,
} from "#backend/integrations/confluence/confluence_settings_repo.js";

// ─── Port + return shapes ─────────────────────────────────────────────────────────────────────────

/** One LIVE page-summary the read handler merges with the stored approval/ingest state. */
export type LiveSpacePage = {
  readonly page_id: string;
  readonly space_key: string;
  readonly title: string;
  readonly version: number;
  readonly last_modified_at: string;
};

/** One page of LIVE space pages + the opaque next cursor (null when there is no more data). */
export type LiveSpacePageList = {
  readonly items: ReadonlyArray<LiveSpacePage>;
  readonly next_cursor: string | null;
};

/**
 * The LIVE-page list seam injected into the admin page-read handler (via the route options). Undefined at
 * the composition root → the read falls back to the stored query (`live_list_available: false`).
 */
export type ConfluencePageListerPort = {
  /** List one page of the space's LIVE pages. Throws on unconfigured creds / transport failure / abort —
   *  the read handler catches and falls back to the stored query. */
  listSpacePages(args: {
    spaceKey: string;
    cursor: string | null;
    signal?: AbortSignal;
  }): Promise<LiveSpacePageList>;
};

// ─── Narrow client slice ──────────────────────────────────────────────────────────────────────────

/** The narrow list-pages slice the lister drives; the real {@link ConfluenceClient} satisfies it
 *  structurally. Tests inject a stub. */
export type ConfluenceListPagesClient = {
  listPages(args: {
    spaceKey: string;
    cursor?: string | null;
    signal?: AbortSignal;
  }): Promise<{
    items: ReadonlyArray<{
      page_id: string;
      space_key: string;
      title: string;
      version: number;
      last_modified_at: string;
    }>;
    next_cursor: string | null;
  }>;
};

/** The decrypted creds the client factory builds from. */
type ConfluenceCreds = { baseUrl: string; token: string; authEmail: string | null; fastFail: boolean };

/** Build a FAST-FAIL {@link ConfluenceClient} for the list-pages slice — 1:1 with the auth-scheme
 *  selection in confluence_validator_real.ts (authEmail present → Basic; absent → Bearer), plus
 *  `fastFail: true` (Phase 0) so a flaky Confluence degrades to the stored fallback at once. `authEmail`
 *  is OMITTED (not set to undefined) when null, per exactOptionalPropertyTypes. */
function buildFastFailClient(creds: ConfluenceCreds): ConfluenceListPagesClient {
  return new ConfluenceClient({
    baseUrl: creds.baseUrl,
    bearerToken: creds.token,
    fastFail: creds.fastFail,
    ...(creds.authEmail !== null ? { authEmail: creds.authEmail } : {}),
  });
}

// ─── Adapter ────────────────────────────────────────────────────────────────────────────────────

export type MakeConfluencePageListerOptions = {
  /** Production wiring (the composition root passes these): the shared core Kysely + the boot key
   *  registry. Used to build the default `readSettings` (the DB tier — field-codec decrypt). */
  db?: Kysely<unknown>;
  registry?: KeyRegistry;
  /** Test seam: read the ACTIVE decrypted Confluence creds (null when unconfigured/disabled). Default:
   *  PostgresConfluenceSettingsRepo({db, registry}).read() (requires `db` + `registry`). */
  readSettings?: () => Promise<ConfluenceSettings | null>;
  /** Test seam: build the FAST-FAIL list-pages client from the resolved creds. Default: the real client. */
  makeClient?: (creds: ConfluenceCreds) => ConfluenceListPagesClient;
};

/**
 * The REAL {@link ConfluencePageListerPort}. `listSpacePages`:
 *   1. reads the active decrypted creds (the DB tier — same as the ingest sync); throws when unconfigured;
 *   2. builds the FAST-FAIL Confluence client (Basic/Bearer per authEmail);
 *   3. lists one page of the space's live pages, threading the caller's AbortSignal.
 *
 * Unlike the validator (which never throws — it returns a {ok, detail}), this port THROWS on any failure:
 * the read handler's try/catch is the fallback boundary. A thrown abort/transport/unconfigured error → the
 * handler serves the stored query with `live_list_available: false`.
 */
export function makeConfluencePageLister(
  opts: MakeConfluencePageListerOptions = {},
): ConfluencePageListerPort {
  const readSettings =
    opts.readSettings ??
    (async (): Promise<ConfluenceSettings | null> => {
      if (opts.db === undefined || opts.registry === undefined) {
        throw new Error(
          "makeConfluencePageLister: default readSettings requires { db, registry } (or inject readSettings)",
        );
      }
      return new PostgresConfluenceSettingsRepo({ db: opts.db, registry: opts.registry }).read();
    });
  const makeClient = opts.makeClient ?? buildFastFailClient;

  return {
    async listSpacePages({ spaceKey, cursor, signal }): Promise<LiveSpacePageList> {
      const settings = await readSettings();
      if (settings === null) {
        throw new Error(
          "Confluence is not configured (no active platform credentials); cannot list live pages.",
        );
      }
      const client = makeClient({
        baseUrl: settings.baseUrl,
        token: settings.token,
        authEmail: settings.authEmail,
        fastFail: true,
      });
      const list = await client.listPages({
        spaceKey,
        cursor,
        ...(signal !== undefined ? { signal } : {}),
      });
      return {
        items: list.items.map((i) => ({
          page_id: i.page_id,
          space_key: i.space_key,
          title: i.title,
          version: i.version,
          last_modified_at: i.last_modified_at,
        })),
        next_cursor: list.next_cursor,
      };
    },
  };
}
