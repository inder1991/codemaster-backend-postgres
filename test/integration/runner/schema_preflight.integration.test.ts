// CS5 (XH7/L16/RT6 — minimal cutover slice, part A): DB schema-revision boot preflight, fail-loud.
// The image carries a COMPILED-IN expected migration sequence (schema_preflight.ts
// EXPECTED_MIGRATIONS — pinned to the migrations/ directory by test (4) below, so the constant can
// never silently drift from the shipped SQL). At boot, BEFORE the HTTP bind and BEFORE any runner
// loop starts, assertSchemaRevision reads the applied head + full name sequence from
// public.pgmigrations and fails LOUD on any mismatch — this closes the silent-schema-drift class
// where a pod runs for weeks against a DB missing the revision its queries assume.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5439 DB, fully
// migrated) — never a shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import {
  assertSchemaRevision,
  EXPECTED_MIGRATIONS,
  SchemaRevisionMismatchError,
} from "#backend/schema_preflight.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 2 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });

describeDb("assertSchemaRevision — boot preflight (CS5)", () => {
  it("(1) MATCH: a DB at the compiled-in head passes the preflight", async () => {
    await expect(assertSchemaRevision(db)).resolves.toBeUndefined();
  });

  it("(2) BEHIND: a DB one revision behind the image fails LOUD, naming the missing revision", async () => {
    const ahead = [...EXPECTED_MIGRATIONS, "0099_future_revision"];
    const err = await assertSchemaRevision(db, ahead).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SchemaRevisionMismatchError);
    expect((err as Error).message).toContain("0099_future_revision");
  });

  it("(3) DRIFT: a sequence mismatch (same length, different content) fails LOUD even when the head matches", async () => {
    // Same head, but an interior revision differs — the fingerprint catches what a head-only
    // check would miss (e.g. a cherry-picked migration applied out of band).
    const drifted: Array<string> = [...EXPECTED_MIGRATIONS];
    drifted[1] = "0002_seed_TAMPERED";
    const err = await assertSchemaRevision(db, drifted).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SchemaRevisionMismatchError);
  });
});

// PIN (no DB): the compiled-in constant can never drift from the shipped migrations/ directory —
// adding a migration without updating EXPECTED_MIGRATIONS (or vice versa) fails CI here.
it("(4) EXPECTED_MIGRATIONS is byte-exact with the migrations/ directory", () => {
  const onDisk = readdirSync(join(import.meta.dirname, "../../../migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
  expect([...EXPECTED_MIGRATIONS].sort()).toEqual(onDisk);
});
