// Task-2.14 guard: the ADR-0062 single-pool invariant, enforced statically over the repo layer.
//
// ## What this guard prevents
//
// ADR-0062 ("Postgres connection-pool lifecycle") makes ONE `pg.Pool` per DSN process-wide, owned by
// the single seam `libs/platform/src/db/database.ts` (`getPool` / `tenantKysely`). Before that fix,
// every repo memoized its OWN `pg.Pool` (plus a per-DSN `Map<string, Pool>` / `Map<string, Kysely>`),
// so a worker with N repo types fanned out to `N × max` connections against the same DSN and exhausted
// Postgres on a rolling deploy (the `TooManyConnectionsError` 500s the ADR exists to kill).
//
// This is a STRUCTURAL guard (eliminate-over-detect): it fails the build the moment ANY repo under
// `apps/backend/src/domain/repos/` regresses by (a) constructing its own `new Pool(...)`,
// (b) constructing its own `new Kysely(...)` instance, or (c) holding its own per-DSN pool/kysely
// `Map` (the memoization cache the central seam now owns). Repos MUST instead import the pool/kysely
// from `#platform/db/database.js` (`tenantKysely` / `getPool`). The shared DbContext file is the ONLY
// sanctioned `new Pool(` site in the codebase — and it is NOT under the repos directory, so it is out
// of this guard's scan scope by construction.
//
// AST-based via ts-morph (not regex): a banned token inside a comment or a string literal (the repo
// headers are FULL of "the repo NO LONGER owns a `pg.Pool`" prose, and `{@link tenantKysely}` JSDoc
// mentions) does NOT false-match — only real `new Pool(...)` / `new Kysely(...)` NewExpression nodes
// and real `new Map<...>()` caches whose type arguments name Pool/Kysely.
//
// Mode: ERROR (a failing assertion fails `npm run test` / validate-fast). No EXEMPTED escape hatch:
// every repo over a given DSN must share the one pool; there is no by-design reason for a repo to own
// a pool, so an exemption list would only be a regression's hiding place.

import { readdirSync } from "node:fs";
import * as path from "node:path";

import { Node, type NewExpression, Project, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

/** Absolute path to the repo layer this guard scans. */
const REPOS_DIR = path.resolve(
  __dirname,
  "../../apps/backend/src/domain/repos",
);

/** A single static violation: which repo file, which line, and a human-readable reason. */
type PoolViolation = {
  readonly file: string;
  readonly line: number;
  readonly kind: "new Pool" | "new Kysely" | "per-DSN cache Map";
  readonly snippet: string;
};

/** The repo `.ts` files (excludes `*.test.ts`, which do not live here anyway). */
function repoSourcePaths(): ReadonlyArray<string> {
  return readdirSync(REPOS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(REPOS_DIR, f))
    .sort();
}

/**
 * True when `expr` is `new <Identifier>(...)` where the constructor identifier is exactly `name`.
 * Matches `new Pool(...)` / `new Kysely(...)`; does not match member-access constructors like
 * `new foo.Pool(...)` (none exist here — repos import `Pool` / `Kysely` as bare identifiers).
 */
function isNewOf(expr: NewExpression, name: string): boolean {
  const callee = expr.getExpression();
  return Node.isIdentifier(callee) && callee.getText() === name;
}

/**
 * True when `expr` is a `new Map<...>(...)` whose type arguments mention `Pool` or `Kysely` — the
 * per-DSN memoization cache the central seam now owns. Catches `new Map<string, Pool>()`,
 * `new Map<string, Kysely<DB>>()`, and `new Map<string, { pool: Pool; db: Kysely<unknown> }>()`.
 */
function isPerDsnCacheMap(expr: NewExpression): boolean {
  const callee = expr.getExpression();
  if (!(Node.isIdentifier(callee) && callee.getText() === "Map")) {
    return false;
  }
  const typeArgsText = expr.getTypeArguments().map((t) => t.getText());
  return typeArgsText.some((t) => /\bPool\b/.test(t) || /\bKysely\b/.test(t));
}

/** Walk one repo source file and collect every ADR-0062 pool-ownership violation in it. */
function violationsIn(sf: SourceFile): ReadonlyArray<PoolViolation> {
  const out: Array<PoolViolation> = [];
  const rel = path.basename(sf.getFilePath());
  sf.forEachDescendant((node) => {
    if (!Node.isNewExpression(node)) {
      return;
    }
    const line = node.getStartLineNumber();
    const snippet = node.getText().slice(0, 80);
    if (isNewOf(node, "Pool")) {
      out.push({ file: rel, line, kind: "new Pool", snippet });
    } else if (isNewOf(node, "Kysely")) {
      out.push({ file: rel, line, kind: "new Kysely", snippet });
    } else if (isPerDsnCacheMap(node)) {
      out.push({ file: rel, line, kind: "per-DSN cache Map", snippet });
    }
  });
  return out;
}

/** Run the guard over the real repo directory and return every violation across all repo files. */
function scanRepos(): ReadonlyArray<PoolViolation> {
  const project = new Project({
    useInMemoryFileSystem: false,
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false },
  });
  const out: Array<PoolViolation> = [];
  for (const p of repoSourcePaths()) {
    const sf = project.addSourceFileAtPath(p);
    out.push(...violationsIn(sf));
  }
  return out;
}

/** W4.6 [OM4]: the activities layer regressed the same invariant once — the run_id retire sweep
 *  opened a fresh non-memoized `new PgPool` per run (`kyselyOver`), a second connection source
 *  against the same DSN during the 03:00 sweep. Activities MUST route through `getPool`/
 *  `tenantKysely` like everything else; scan the whole activities directory for owned pools
 *  (`Pool` AND the `Pool as PgPool` alias). */
const ACTIVITIES_DIR = path.resolve(__dirname, "../../apps/backend/src/activities");

function activitySourcePaths(): ReadonlyArray<string> {
  return readdirSync(ACTIVITIES_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(ACTIVITIES_DIR, f))
    .sort();
}

function ownedPoolViolationsIn(sf: SourceFile): ReadonlyArray<PoolViolation> {
  const out: Array<PoolViolation> = [];
  const rel = path.basename(sf.getFilePath());
  sf.forEachDescendant((node) => {
    if (!Node.isNewExpression(node)) {
      return;
    }
    if (isNewOf(node, "Pool") || isNewOf(node, "PgPool")) {
      out.push({ file: rel, line: node.getStartLineNumber(), kind: "new Pool", snippet: node.getText().slice(0, 80) });
    }
  });
  return out;
}

describe("ADR-0062 pool-memoization guard (Task-2.14)", () => {
  it("no activity under activities/ constructs its own pg Pool (OM4 — route through getPool/tenantKysely)", () => {
    const project = new Project({
      useInMemoryFileSystem: false,
      skipFileDependencyResolution: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: false },
    });
    const violations: Array<PoolViolation> = [];
    for (const p of activitySourcePaths()) {
      violations.push(...ownedPoolViolationsIn(project.addSourceFileAtPath(p)));
    }
    expect(activitySourcePaths().length).toBeGreaterThan(0); // not vacuously green
    const report = violations.map((v) => `  ${v.file}:${v.line} — ${v.kind}: ${v.snippet}`).join("\n");
    expect(
      violations,
      violations.length === 0 ? "" : `OM4 regression — activities must use getPool/tenantKysely:\n${report}`,
    ).toHaveLength(0);
  });

  it("no repo under domain/repos constructs its own Pool / Kysely / per-DSN cache", () => {
    const violations = scanRepos();
    const report = violations
      .map((v) => `  ${v.file}:${v.line} — ${v.kind}: ${v.snippet}`)
      .join("\n");
    expect(
      violations,
      violations.length === 0
        ? ""
        : `ADR-0062 regression — repos must import the pool/kysely from #platform/db/database.js, ` +
            `never own one. Offending sites:\n${report}`,
    ).toHaveLength(0);
  });

  it("scans a non-empty set of repo source files (guard is not vacuously green)", () => {
    // Defends against the guard silently passing because the scan glob broke and matched nothing.
    expect(repoSourcePaths().length).toBeGreaterThan(0);
  });

  it("the AST scanner flags a synthetic repo that constructs its own Pool / Kysely / cache Map", () => {
    // Proves the scanner actually fires (not a false-green) AND that it ignores tokens that only
    // appear in comments / strings — exactly the JSDoc-prose case the real repos exhibit.
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile(
      "synthetic_repo.ts",
      [
        "// This repo NO LONGER owns a `new Pool(` — prose mention must NOT match.",
        'const doc = "new Kysely(should-not-match-in-a-string)";',
        "const pool = new Pool({ connectionString: dsn });",
        "const db = new Kysely({ dialect });",
        "const POOL_BY_DSN = new Map<string, Pool>();",
        "const DB_BY_DSN = new Map<string, Kysely<unknown>>();",
        "const ok = new Map<string, number>();",
      ].join("\n"),
    );
    const v = violationsIn(sf);
    const kinds = v.map((x) => x.kind).sort();
    expect(kinds).toEqual([
      "new Kysely",
      "new Pool",
      "per-DSN cache Map",
      "per-DSN cache Map",
    ]);
  });
});
