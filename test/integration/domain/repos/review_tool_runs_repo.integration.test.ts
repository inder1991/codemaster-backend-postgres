import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import {
  type InsertToolRunInput,
  ReviewToolRunsRepo,
} from "#backend/domain/repos/review_tool_runs_repo.js";

import { disposeAllPools, getPool } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../../_db.js";

// DB-gated integration test against a DISPOSABLE Postgres (migrations applied — core.review_tool_runs
// from migration 0084). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise
// so validate-fast stays green without a DB. We NEVER touch any other DB.
//
// Strategy: the repo only WRITES (insertToolRun); read-back / tenant-isolation / ordering assertions
// use a direct pool query (a privileged-style raw read, NOT through the tenancy-gated Kysely instance)
// so the test can observe rows across the tenant boundary it is verifying. Each test uses a UNIQUE
// installation_id so per-org rows never collide; an FK to core.installations requires the parent row
// to exist, so we seed/clean it per test.

let pool: Pool;
let repo: ReviewToolRunsRepo;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  // ADR-0062: the repo + the raw seed/assert reads share the ONE process-wide pool from the central
  // factory (getPool / tenantKysely) — never a private per-file pool.
  pool = getPool(INTEGRATION_DSN);
  repo = ReviewToolRunsRepo.fromDsn(INTEGRATION_DSN);
});

afterAll(async () => {
  // ADR-0062 teardown: end the shared pool(s) via the central seam — NOT a private pool.end().
  await disposeAllPools();
});

// Track installations created so cleanup removes their child rows then the parent.
const createdInstallations = new Set<string>();

afterEach(async () => {
  for (const installationId of createdInstallations) {
    await pool.query(`DELETE FROM core.review_tool_runs WHERE installation_id = $1`, [
      installationId,
    ]);
    await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [installationId]);
  }
  createdInstallations.clear();
});

type InstallationColumns = {
  hasColumn(name: string): boolean;
};

let installationCols: InstallationColumns | undefined;

/** Discover which core.installations columns are NOT NULL-without-default so the seed satisfies them. */
async function requiredInstallationInsert(installationId: string): Promise<{
  sql: string;
  params: Array<unknown>;
}> {
  if (installationCols === undefined) {
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'core' AND table_name = 'installations'`,
    );
    const names = new Set(res.rows.map((r) => r.column_name));
    installationCols = { hasColumn: (n: string) => names.has(n) };
  }
  // Minimal seed: installation_id plus a small set of commonly-required columns when present. The
  // disposable schema's installations table accepts NULL/defaults for the rest.
  const cols: Array<string> = ["installation_id"];
  const vals: Array<string> = ["$1"];
  const params: Array<unknown> = [installationId];
  let i = 2;
  const maybe = (name: string, value: unknown): void => {
    if (installationCols!.hasColumn(name)) {
      cols.push(name);
      vals.push(`$${i}`);
      params.push(value);
      i += 1;
    }
  };
  maybe("github_installation_id", Math.floor(Math.random() * 1_000_000_000) + 1);
  maybe("account_login", `acct-${installationId.slice(0, 8)}`);
  maybe("account_type", "Organization");
  maybe("github_account_id", Math.floor(Math.random() * 1_000_000_000) + 1);
  maybe("app_slug", "codemaster");
  maybe("status", "active");
  maybe("target_type", "Organization");
  const sql = `INSERT INTO core.installations (${cols.join(", ")}) VALUES (${vals.join(", ")})
               ON CONFLICT (installation_id) DO NOTHING`;
  return { sql, params };
}

/** Seed a parent core.installations row (FK target) for the given id; tracked for cleanup. */
async function seedInstallation(installationId: string): Promise<void> {
  const { sql, params } = await requiredInstallationInsert(installationId);
  await pool.query(sql, params);
  createdInstallations.add(installationId);
}

/** A complete input with all fields populated; override any field via `over`. */
function makeInput(over: Partial<InsertToolRunInput> = {}): InsertToolRunInput {
  return {
    installationId: randomUUID(),
    runId: randomUUID(),
    reviewId: randomUUID(),
    toolName: "ruff",
    status: "completed",
    filesScanned: 7,
    filesTotal: 10,
    startedAt: new Date("2099-01-01T00:00:00.000Z"),
    finishedAt: new Date("2099-01-01T00:00:01.500Z"),
    durationMs: 1500,
    findingsProduced: 3,
    errorClass: null,
    errorMessage: null,
    ...over,
  };
}

type RowShape = {
  installation_id: string;
  run_id: string;
  review_id: string;
  tool_name: string;
  status: string;
  files_scanned: number;
  files_total: number;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number;
  findings_produced: number;
  error_class: string | null;
  error_message: string | null;
};

/** Read back the single row for (run_id, tool_name) via a direct pool query (test observation). */
async function readRow(runId: string, toolName: string): Promise<RowShape | undefined> {
  const res = await pool.query<RowShape>(
    `SELECT installation_id, run_id, review_id, tool_name, status, files_scanned, files_total,
            started_at, finished_at, duration_ms, findings_produced, error_class, error_message
       FROM core.review_tool_runs WHERE run_id = $1 AND tool_name = $2`,
    [runId, toolName],
  );
  return res.rows[0];
}

describeDb("ReviewToolRunsRepo (integration, disposable PG)", () => {
  it("insertToolRun persists a row that reads back field-for-field equal", async () => {
    const installationId = randomUUID();
    await seedInstallation(installationId);
    const input = makeInput({ installationId });

    await repo.insertToolRun(input);

    const row = await readRow(input.runId, input.toolName);
    expect(row).toBeDefined();
    expect(row!.installation_id).toBe(input.installationId);
    expect(row!.run_id).toBe(input.runId);
    expect(row!.review_id).toBe(input.reviewId);
    expect(row!.tool_name).toBe(input.toolName);
    expect(row!.status).toBe(input.status);
    expect(row!.files_scanned).toBe(input.filesScanned);
    expect(row!.files_total).toBe(input.filesTotal);
    expect(row!.duration_ms).toBe(input.durationMs);
    expect(row!.findings_produced).toBe(input.findingsProduced);
    expect(row!.error_class).toBeNull();
    expect(row!.error_message).toBeNull();
    // timestamptz round-trips to the same absolute instant.
    expect(row!.started_at.toISOString()).toBe(input.startedAt.toISOString());
    expect(row!.finished_at?.toISOString()).toBe(input.finishedAt!.toISOString());
  });

  it("persists the nullable/error path: finished_at NULL + populated error_class/error_message", async () => {
    const installationId = randomUUID();
    await seedInstallation(installationId);
    const input = makeInput({
      installationId,
      toolName: "eslint",
      status: "failed_runtime",
      filesScanned: 0,
      filesTotal: 0,
      finishedAt: null,
      findingsProduced: 0,
      errorClass: "RuntimeError",
      errorMessage: "tool crashed on file X",
    });

    await repo.insertToolRun(input);

    const row = await readRow(input.runId, input.toolName);
    expect(row).toBeDefined();
    expect(row!.status).toBe("failed_runtime");
    expect(row!.finished_at).toBeNull();
    expect(row!.error_class).toBe("RuntimeError");
    expect(row!.error_message).toBe("tool crashed on file X");
    expect(row!.files_scanned).toBe(0);
    expect(row!.files_total).toBe(0);
  });

  it("ON CONFLICT (run_id, tool_name) DO NOTHING is idempotent — second insert is a no-op", async () => {
    const installationId = randomUUID();
    await seedInstallation(installationId);
    const first = makeInput({ installationId, filesScanned: 7, filesTotal: 10, findingsProduced: 3 });
    // Same (run_id, tool_name) but DIFFERENT downstream values — the conflict must keep the FIRST row.
    // The CHECK (files_scanned <= files_total) is validated BEFORE conflict resolution, so the second
    // input must itself be CHECK-valid; we differentiate via files_scanned within bounds + findings.
    const second: InsertToolRunInput = {
      ...first,
      reviewId: randomUUID(),
      filesScanned: 9,
      findingsProduced: 999,
      status: "timed_out",
    };

    await repo.insertToolRun(first);
    await repo.insertToolRun(second); // absorbed by ON CONFLICT DO NOTHING

    const res = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM core.review_tool_runs WHERE run_id = $1 AND tool_name = $2`,
      [first.runId, first.toolName],
    );
    expect(Number(res.rows[0]!.n)).toBe(1); // exactly one row — no duplicate

    const row = await readRow(first.runId, first.toolName);
    // The FIRST write won; the conflicting second write changed nothing.
    expect(row!.review_id).toBe(first.reviewId);
    expect(row!.files_scanned).toBe(first.filesScanned);
    expect(row!.findings_produced).toBe(first.findingsProduced);
    expect(row!.status).toBe(first.status);
  });

  it("same run_id with a DIFFERENT tool_name inserts a distinct row (composite key)", async () => {
    const installationId = randomUUID();
    await seedInstallation(installationId);
    const runId = randomUUID();
    const ruff = makeInput({ installationId, runId, toolName: "ruff" });
    const eslint = makeInput({ installationId, runId, toolName: "eslint", findingsProduced: 5 });

    await repo.insertToolRun(ruff);
    await repo.insertToolRun(eslint);

    const res = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM core.review_tool_runs WHERE run_id = $1`,
      [runId],
    );
    expect(Number(res.rows[0]!.n)).toBe(2); // two distinct rows for the same run, different tools
    expect((await readRow(runId, "ruff"))!.tool_name).toBe("ruff");
    expect((await readRow(runId, "eslint"))!.findings_produced).toBe(5);
  });

  it("tenant isolation: a query scoped to installation A does not see installation B's rows", async () => {
    const installationA = randomUUID();
    const installationB = randomUUID();
    await seedInstallation(installationA);
    await seedInstallation(installationB);

    const aInput = makeInput({ installationId: installationA, toolName: "ruff" });
    const bInput = makeInput({ installationId: installationB, toolName: "ruff" });
    await repo.insertToolRun(aInput);
    await repo.insertToolRun(bInput);

    // A tenant-scoped read (WHERE installation_id = A) sees ONLY A's row, never B's.
    const aRows = await pool.query<{ run_id: string; installation_id: string }>(
      `SELECT run_id, installation_id FROM core.review_tool_runs WHERE installation_id = $1`,
      [installationA],
    );
    expect(aRows.rows).toHaveLength(1);
    expect(aRows.rows[0]!.run_id).toBe(aInput.runId);
    expect(aRows.rows.every((r) => r.installation_id === installationA)).toBe(true);
    // B's row is genuinely present under B (so the isolation above is meaningful, not just empty).
    const bRows = await pool.query<{ run_id: string }>(
      `SELECT run_id FROM core.review_tool_runs WHERE installation_id = $1`,
      [installationB],
    );
    expect(bRows.rows).toHaveLength(1);
    expect(bRows.rows[0]!.run_id).toBe(bInput.runId);
  });

  it("rows order by started_at DESC (the ix_review_tool_runs_installation_started ordering)", async () => {
    const installationId = randomUUID();
    await seedInstallation(installationId);

    const early = makeInput({
      installationId,
      toolName: "ruff",
      startedAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    const mid = makeInput({
      installationId,
      toolName: "eslint",
      startedAt: new Date("2099-01-01T00:05:00.000Z"),
    });
    const late = makeInput({
      installationId,
      toolName: "semgrep",
      startedAt: new Date("2099-01-01T00:10:00.000Z"),
    });
    // Insert out of order to prove ordering is by started_at, not insert order.
    await repo.insertToolRun(mid);
    await repo.insertToolRun(late);
    await repo.insertToolRun(early);

    const ordered = await pool.query<{ tool_name: string }>(
      `SELECT tool_name FROM core.review_tool_runs
        WHERE installation_id = $1 ORDER BY started_at DESC`,
      [installationId],
    );
    expect(ordered.rows.map((r) => r.tool_name)).toEqual(["semgrep", "eslint", "ruff"]);
  });

  it("respects the coverage CHECK (files_scanned <= files_total): a boundary-equal row persists", async () => {
    const installationId = randomUUID();
    await seedInstallation(installationId);
    const input = makeInput({ installationId, filesScanned: 10, filesTotal: 10 });

    await repo.insertToolRun(input); // files_scanned == files_total satisfies ck_review_tool_runs_coverage

    const row = await readRow(input.runId, input.toolName);
    expect(row!.files_scanned).toBe(10);
    expect(row!.files_total).toBe(10);
  });
});
