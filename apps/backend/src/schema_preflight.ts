// CS5 (XH7/L16/RT6 — minimal cutover slice, part A): DB schema-revision boot preflight, fail-loud.
//
// The image carries its expected migration sequence COMPILED IN ({@link EXPECTED_MIGRATIONS} — the
// integration suite pins it byte-exact to the migrations/ directory, so adding a migration without
// updating this list fails CI, never production). At boot the composition root (main.ts) awaits
// {@link assertSchemaRevision} BEFORE the HTTP server binds and BEFORE any runner loop starts: a
// pod whose DB is behind (or otherwise diverged from) the image's expected schema exits 1
// immediately and visibly, instead of running for weeks issuing queries against columns/tables
// that don't exist — the exact silent-schema-drift class XH7 documents.
//
// The check is a FULL-SEQUENCE comparison, not a head check: the applied `public.pgmigrations`
// name sequence (the node-pg-migrate journal, ordered by id) must equal the compiled-in sequence
// exactly. A head-only check would miss an interior revision applied out of band or skipped.

import { sql, type Kysely } from "kysely";

/** The compiled-in expected migration sequence (names as journaled by node-pg-migrate — no `.sql`),
 *  in application order. MUST mirror the migrations/ directory exactly (CI-pinned). */
export const EXPECTED_MIGRATIONS = [
  // Go-live Step 6 (2026-06-13): the prior 18-migration sequence (0001_baseline + 0002..0049) was FUSED
  // into ONE up-only baseline for first go-live — semantic-diff verified (byte-identical schema + seed
  // vs applying all pre-fusion migrations). The pre-fusion migrations are preserved in git history.
  "0001_baseline",
] as const satisfies ReadonlyArray<string>;

/** The DB's applied migration sequence diverges from the image's compiled-in expectation — the pod
 *  MUST NOT serve traffic or run loops against a schema it was not built for. */
export class SchemaRevisionMismatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SchemaRevisionMismatchError";
  }
}

/**
 * Assert the DB's applied migration sequence equals the image's expectation; throw
 * {@link SchemaRevisionMismatchError} (with a diff naming the first divergence and both heads)
 * otherwise. The composition root awaits this BEFORE binding HTTP / starting loops and routes the
 * throw to its fail-loud `process.exit(1)` handler. `expected` is injectable for tests only.
 */
export async function assertSchemaRevision(
  db: Kysely<unknown>,
  expected: ReadonlyArray<string> = EXPECTED_MIGRATIONS,
): Promise<void> {
  const r = await sql<{ name: string }>`SELECT name FROM public.pgmigrations ORDER BY id`.execute(db);
  const applied = r.rows.map((row) => row.name);

  const divergence = firstDivergence(applied, expected);
  if (divergence === null) {
    return;
  }
  const appliedHead = applied.at(-1) ?? "<none>";
  const expectedHead = expected.at(-1) ?? "<none>";
  throw new SchemaRevisionMismatchError(
    `DB schema revision mismatch: ${divergence} ` +
      `(applied head: ${appliedHead}; image expects head: ${expectedHead}). ` +
      `Refusing to boot against a schema this image was not built for — run migrations (or deploy ` +
      `the matching image) and restart.`,
  );
}

/** Human-readable description of the first point where the sequences diverge; null when equal. */
function firstDivergence(applied: ReadonlyArray<string>, expected: ReadonlyArray<string>): string | null {
  const len = Math.max(applied.length, expected.length);
  for (let i = 0; i < len; i++) {
    const a = applied[i];
    const e = expected[i];
    if (a === e) {
      continue;
    }
    if (a === undefined) {
      return `DB is missing expected revision '${e}' at position ${i + 1}`;
    }
    if (e === undefined) {
      return `DB carries unexpected revision '${a}' at position ${i + 1} (DB is AHEAD of the image)`;
    }
    return `sequence diverges at position ${i + 1}: DB has '${a}', image expects '${e}'`;
  }
  return null;
}
