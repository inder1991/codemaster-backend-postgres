// Test helper: a Kysely instance over a recording fake driver. Each executed query's CompiledQuery
// (SQL text + bound parameters) is captured, and canned row sets are returned in call order — so unit
// tests can pin the SQL SHAPE a repo function pushes to Postgres (LIMIT / ORDER BY / keyset predicate)
// without a live database. Used by the W2.7 admin-read pushdown tests (EH9/EH10).

import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";

export type RecordingDb = {
  db: Kysely<unknown>;
  /** Every executed query, in order. */
  queries: Array<CompiledQuery>;
};

/** Build a Kysely whose connection records each compiled query and answers with `results[i]` rows.
 *  An `Error` entry is THROWN instead (drives the unmapped-failure paths, e.g. the EH6 error-handler
 *  tests, with a realistic driver-level Postgres error). */
export function recordingKysely(results: ReadonlyArray<ReadonlyArray<unknown> | Error>): RecordingDb {
  const queries: Array<CompiledQuery> = [];
  let call = 0;
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(compiledQuery);
      const result = results[call] ?? [];
      call += 1;
      if (result instanceof Error) {
        throw result;
      }
      return { rows: result as Array<R> };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error("streamQuery not supported by the recording fake");
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (innerDb) => new PostgresIntrospector(innerDb),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}
