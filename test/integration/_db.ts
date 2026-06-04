// Shared gate for DB-integration tests.
//
// Integration tests run ONLY when CODEMASTER_PG_CORE_DSN is EXPLICITLY set — pointing at a disposable
// Postgres with the migrations applied (see tools/squash + `npm run migrate:up`). Otherwise they SKIP,
// so `npm run test` / `validate-fast` stays green in any environment without a database (CI provisions
// the DB in a dedicated job, mirroring the Python pre-merge integration tier).
//
// NEVER hard-default the DSN in an integration test — a default makes `vitest run` attempt a live
// connection (ECONNREFUSED) wherever no PG is listening. Import { describeDb, INTEGRATION_DSN } here.
import { describe } from "vitest";

export const INTEGRATION_DSN: string | undefined = process.env["CODEMASTER_PG_CORE_DSN"];

/** `describe` when a DB DSN is configured, else `describe.skip`. Use for every DB-integration block. */
export const describeDb = INTEGRATION_DSN ? describe : describe.skip;
