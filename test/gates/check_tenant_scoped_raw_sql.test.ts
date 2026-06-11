import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";

import {
  exitCodeFor,
  findTenancyViolations,
  isErrorModePath,
  isProductionSource,
} from "../../scripts/gates/check_tenant_scoped_raw_sql.js";

// Build an in-memory TS project from a snippet and run the gate over it.
// Mirrors the frozen Python gate's tests (test_check_tenant_scoped_raw_sql.py) but for Kysely's
// raw `sql\`...\`` tagged templates (the TS equivalent of SQLAlchemy `session.execute(text(...))`).
// The file lives under a production `apps/<app>/src/` path so the gate's production-only scope sees it.
function violations(code: string, path = "apps/backend/src/domain/repos/x.ts") {
  const p = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { experimentalDecorators: true },
  });
  p.createSourceFile(path, code);
  return findTenancyViolations(p);
}

describe("tenant-scoped raw-SQL gate", () => {
  it("passes a tenant-scoped SELECT that filters on installation_id", () => {
    expect(
      violations("const r = await db.executeQuery(sql`SELECT id FROM core.repositories WHERE installation_id = ${iid}`);"),
    ).toHaveLength(0);
  });

  it("WARNs on an unfiltered SELECT against a tenant-scoped table", () => {
    const v = violations("const r = await db.executeQuery(sql`SELECT id FROM core.repositories WHERE run_id = ${rid}`);");
    expect(v).toHaveLength(1);
    expect(v[0]!.table).toBe("core.repositories");
  });

  it("exempts a method carrying @privileged_path", () => {
    expect(
      violations(`
        class RepoScan {
          @privileged_path
          async all() {
            return await db.executeQuery(sql\`SELECT id FROM core.repositories WHERE run_id = \${rid}\`);
          }
        }`),
    ).toHaveLength(0);
  });

  it("exempts a site with an inline // tenant:exempt reason=... follow_up=... marker", () => {
    expect(
      violations(`
        // tenant:exempt reason=PK-lookup follow_up=BF-9-PHASE-B-caller-updates
        const r = await db.executeQuery(sql\`SELECT id FROM core.review_runs WHERE run_id = \${rid}\`);`),
    ).toHaveLength(0);
  });

  it("ignores a non-tenant-scoped table", () => {
    expect(
      violations("const r = await db.executeQuery(sql`SELECT id FROM partman.part_config WHERE x = ${x}`);"),
    ).toHaveLength(0);
  });

  it("WARNs on an unfiltered UPDATE against a tenant-scoped table", () => {
    const v = violations("await db.executeQuery(sql`UPDATE core.repositories SET name = ${n} WHERE id = ${x}`);");
    expect(v).toHaveLength(1);
    expect(v[0]!.table).toBe("core.repositories");
  });

  it("WARNs on an unfiltered JOIN against a tenant-scoped table", () => {
    const v = violations(
      "await db.executeQuery(sql`SELECT * FROM partman.part_config p JOIN core.review_findings f ON f.x = p.y`);",
    );
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.some((x) => x.table === "core.review_findings")).toBe(true);
  });

  it("ignores non-sql tagged templates (only raw SQL is gated)", () => {
    expect(violations("const t = html`<div>FROM core.repositories</div>`;")).toHaveLength(0);
  });

  describe("production-only scope (matches the frozen Python gate; test/tooling teardown excepted)", () => {
    const unfiltered = "await db.executeQuery(sql`DELETE FROM core.repositories WHERE repository_id = ${rid}`);";
    it("does NOT scan integration-test teardown SQL (legitimately cross-tenant)", () => {
      expect(violations(unfiltered, "test/integration/domain/repos/x.integration.test.ts")).toHaveLength(0);
    });
    it("does NOT scan tools/ or scripts/", () => {
      expect(violations(unfiltered, "tools/parity/x.ts")).toHaveLength(0);
      expect(violations(unfiltered, "scripts/gates/x.ts")).toHaveLength(0);
    });
    it("DOES scan production repo source under apps/<app>/src and libs/<pkg>/src", () => {
      expect(violations(unfiltered, "apps/backend/src/domain/repos/x.ts")).toHaveLength(1);
      expect(violations(unfiltered, "libs/platform/src/db/x.ts")).toHaveLength(1);
    });
    it("isProductionSource: {libs,apps}/<pkg>/src non-test → true; test/tools/*.test.ts → false", () => {
      expect(isProductionSource("/r/apps/backend/src/x.ts")).toBe(true);
      expect(isProductionSource("/r/libs/platform/src/db/x.ts")).toBe(true);
      expect(isProductionSource("/r/apps/backend/src/x.test.ts")).toBe(false);
      expect(isProductionSource("/r/test/integration/x.ts")).toBe(false);
      expect(isProductionSource("/r/tools/parity/x.ts")).toBe(false);
    });
  });

  // W4.2 [RH1] — the tracked FOLLOW-UP-gf3-error-mode promotion: the gate BLOCKS (exit 1) on the
  // runner data plane + review pipeline + platform libs; ONLY the admin/auth HTTP surface
  // (apps/backend/src/api/**) stays WARN until W4.7 lands its own tenancy/authz wave.
  describe("ERROR-mode for the runner/review surfaces (FOLLOW-UP-gf3-error-mode closure)", () => {
    const unfiltered = "await db.executeQuery(sql`SELECT id FROM core.repositories WHERE run_id = ${rid}`);";

    it("isErrorModePath: runner/ingest/workflow/review/activities/domain/workspace + libs → ERROR; api/** → WARN", () => {
      expect(isErrorModePath("/r/apps/backend/src/runner/review_jobs_repo.ts")).toBe(true);
      expect(isErrorModePath("/r/apps/backend/src/ingest/github_webhook_persistence.ts")).toBe(true);
      expect(isErrorModePath("/r/apps/backend/src/workflow/_supersede.ts")).toBe(true);
      expect(isErrorModePath("/r/apps/backend/src/review/pipeline/orchestrator.ts")).toBe(true);
      expect(isErrorModePath("/r/apps/backend/src/activities/run_id_retention.activity.ts")).toBe(true);
      expect(isErrorModePath("/r/apps/backend/src/domain/repos/outbox_repo.ts")).toBe(true);
      expect(isErrorModePath("/r/libs/platform/src/db/x.ts")).toBe(true);
      expect(isErrorModePath("/r/apps/backend/src/api/admin/admin_read_repo.ts")).toBe(false);
      expect(isErrorModePath("/r/apps/backend/src/api/auth/local_user_repo.ts")).toBe(false);
    });

    it("an unfiltered site on the runner data plane is BLOCKING (exit 1)", () => {
      const v = violations(unfiltered, "apps/backend/src/runner/some_repo.ts");
      expect(v).toHaveLength(1);
      expect(exitCodeFor(v)).toBe(1);
    });

    it("an unfiltered site on the api surface stays WARN-only (exit 0)", () => {
      const v = violations(unfiltered, "apps/backend/src/api/admin/new_admin_read.ts");
      expect(v).toHaveLength(1);
      expect(exitCodeFor(v)).toBe(0);
    });

    it("zero findings → exit 0", () => {
      expect(exitCodeFor([])).toBe(0);
    });
  });
});
