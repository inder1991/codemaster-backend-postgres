// Tenancy raw-SQL gate (ts-morph port of the frozen scripts/check_tenant_scoped_raw_sql.py).
//
// Walks every `sql`...`` tagged template (Kysely raw SQL — the TS equivalent of SQLAlchemy
// `session.execute(text(...))`). For each FROM/JOIN/INTO/UPDATE reference to a TENANT_SCOPED table,
// requires one of three escape hatches, else emits a finding:
//   (a) the SQL contains an `installation_id` token (the tenancy filter), OR
//   (b) the enclosing method/class carries an `@privileged_path` decorator, OR
//   (c) a same-line or preceding-line `// tenant:exempt reason=<...> follow_up=<...>` marker.
//
// Scope: PRODUCTION source only — `{libs,apps}/<pkg>/src/**` excluding `*.test.ts` — matching the
// frozen Python gate's `codemaster/` (production-only) scope and the sibling check_clock_random gate.
// Integration-test teardown legitimately deletes across tenants (it owns its fixture rows), so test/
// (and tools/, scripts/, migrations/) are NOT scanned.
//
// ## ERROR-mode (W4.2 / RH1 — the tracked FOLLOW-UP-gf3-error-mode promotion, CLOSED 2026-06-11)
//
// The de-Temporal runner data plane is raw-SQL-only, INVISIBLE to the runtime Kysely TenancyPlugin
// (it sees only query-builder ASTs) — so this gate is the ONLY automated tenancy backstop there.
// Findings on the runner data plane + review pipeline + platform libs (everything
// {@link isErrorModePath} matches) are BLOCKING: `[ERROR]` + exit 1. ONLY the admin/auth HTTP
// surface (`apps/backend/src/api/**`) stays WARN — it is session/role-gated at the route layer and
// is hardened by its own wave (W4.7); promote it there. Every pre-existing finding was triaged in
// W4.2 (2 real fixes + per-site by-design markers — see the triage commit), so a NEW finding in an
// ERROR path is a regression, not backlog: add the installation_id filter, or justify a
// `// tenant:exempt reason=<honest-reason> follow_up=<story-or-PERMANENT-EXEMPTION-*>` marker.
import { type Node, Project, SyntaxKind } from "ts-morph";

import { TENANT_SCOPED_TABLES } from "./_registry.js";

const TABLE_RE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z_0-9.]*)/gi;
const MARKER_RE = /tenant:exempt\s+reason=\S+\s+follow_up=\S+/;
const INSTALLATION_ID_RE = /installation_id/i;
const PRIVILEGED_PATH_RE = /(?:^|\.)privileged_?path/i;

export type Violation = {
  file: string;
  line: number;
  table: string;
}

/** Production source only: `{libs,apps}/<pkg>/src/**`, excluding tests. Mirrors the frozen Python
 *  gate's production-only (`codemaster/`) scope — test/tooling teardown legitimately crosses tenants. */
export function isProductionSource(absPath: string): boolean {
  const posix = absPath.split("\\").join("/");
  if (posix.endsWith(".test.ts")) return false;
  return /(?:^|\/)(?:libs|apps)\/[^/]+\/src\//.test(posix);
}

/**
 * ERROR-mode scope (W4.2 / RH1): the runner data plane + review pipeline + platform libs — every
 * production path EXCEPT the admin/auth HTTP surface (`apps/backend/src/api/**`), which stays WARN
 * until its own hardening wave (W4.7). A finding here exits 1.
 */
export function isErrorModePath(absPath: string): boolean {
  const posix = absPath.split("\\").join("/");
  return !/(?:^|\/)apps\/[^/]+\/src\/api\//.test(posix);
}

/** Pure exit-code policy: 1 iff ANY finding sits on an ERROR-mode path (else 0 — WARN-only). */
export function exitCodeFor(violations: ReadonlyArray<Violation>): number {
  return violations.some((v) => isErrorModePath(v.file)) ? 1 : 0;
}

export function findTenancyViolations(project: Project): Array<Violation> {
  const out: Array<Violation> = [];
  for (const sf of project.getSourceFiles()) {
    if (!isProductionSource(sf.getFilePath())) continue;
    const lines = sf.getFullText().split("\n");
    for (const tpl of sf.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
      if (!/^sql\b|^sql$/.test(tpl.getTag().getText())) continue;
      const text = tpl.getText();
      let m: RegExpExecArray | null;
      TABLE_RE.lastIndex = 0;
      while ((m = TABLE_RE.exec(text)) !== null) {
        const table = m[1]!.toLowerCase();
        if (!TENANT_SCOPED_TABLES.has(table)) continue;
        if (INSTALLATION_ID_RE.test(text)) continue;
        if (hasPrivilegedPath(tpl)) continue;
        if (hasExemptMarker(tpl, lines)) continue;
        out.push({ file: sf.getFilePath(), line: tpl.getStartLineNumber(), table });
      }
    }
  }
  return out;
}

function hasPrivilegedPath(node: Node): boolean {
  const method = node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
  const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  const decorators = [...(method?.getDecorators() ?? []), ...(cls?.getDecorators() ?? [])];
  return decorators.some((d) => PRIVILEGED_PATH_RE.test(d.getExpression().getText()));
}

function hasExemptMarker(node: Node, lines: Array<string>): boolean {
  const ln = node.getStartLineNumber(); // 1-based
  const sameLine = lines[ln - 1] ?? "";
  const prevLine = lines[ln - 2] ?? "";
  return MARKER_RE.test(sameLine) || MARKER_RE.test(prevLine);
}

/** CLI entry: H-16-format lines — `[ERROR]` (blocking) on the runner/review data plane + libs,
 *  `[WARN]` on the api surface. Exit per {@link exitCodeFor}. */
export function main(): number {
  const project = new Project({ tsConfigFilePath: "tsconfig.json" });
  const violations = findTenancyViolations(project);
  let errors = 0;
  for (const v of violations) {
    const blocking = isErrorModePath(v.file);
    if (blocking) errors += 1;
    process.stderr.write(
      `[${blocking ? "ERROR" : "WARN"}] file=${v.file}:${v.line} rule=tenant.raw_sql.unfiltered ` +
        `message="tenant-scoped table ${v.table} referenced in raw SQL without an installation_id filter" ` +
        `suggestion="add WHERE installation_id = \${iid}, @privileged_path, or a // tenant:exempt marker"\n`,
    );
  }
  const rc = exitCodeFor(violations);
  process.stderr.write(
    `[INFO] tenant-scoped raw-SQL gate (ERROR-mode on runner/review surfaces): ` +
      `${errors} blocking + ${violations.length - errors} warn finding(s). Exit ${rc}.\n`,
  );
  return rc;
}
