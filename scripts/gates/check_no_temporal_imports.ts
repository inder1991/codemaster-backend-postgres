// No-Temporal-imports gate — the PERMANENT LOCK on the de-Temporal teardown.
//
// Temporal was torn out entirely (the @temporalio worker / workflows / client / deps are gone). This
// gate keeps it that way: it scans the source tree for actual `@temporalio` MODULE references —
// import / require / dynamic-import statements, and package.json dependency entries — and fails CI if
// any reappear. Prose mentions of "@temporalio" in comments (historical notes) are NOT flagged; only
// real module references are, so the codebase can still describe what was removed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Roots scanned for `.ts` references. */
const SCAN_DIRS = ["apps", "libs", "scripts", "test"] as const;

/** Files excluded from the scan: this gate + its test legitimately contain the patterns as detection
 *  logic / test fixtures (they reference "@temporalio" as DATA, not as a live import). */
const EXCLUDED = new Set<string>([
  "scripts/gates/check_no_temporal_imports.ts",
  "test/gates/check_no_temporal_imports.test.ts",
]);

// A real import/require/dynamic-import of an @temporalio module: `from "@temporalio/…"`,
// `import("@temporalio/…")`, `require("@temporalio/…")`. The quote immediately preceding @temporalio
// is what distinguishes a module reference from prose ("…with @temporalio/common…" has no quote).
const IMPORT_RE = /\b(?:from|import|require)\b\s*\(?\s*["']@temporalio\//;
// A package.json dependency entry: a quoted "@temporalio/…" KEY followed by a colon.
const PKG_DEP_RE = /^\s*"@temporalio\/[^"]+"\s*:/;

/** True iff the line is a real @temporalio module reference (import/require/dep), not prose. */
export function isTemporalModuleReference(line: string): boolean {
  return IMPORT_RE.test(line) || PKG_DEP_RE.test(line);
}

function walkTsFiles(dir: string, out: Array<string>): void {
  let entries: Array<string>;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // a missing scan dir is fine (e.g. libs absent in a slim checkout)
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
}

/** Scan the source tree + package.json for @temporalio module references. Returns `path:line: text`
 *  for each hit (empty array when clean — the post-teardown invariant). */
export function scanRepoForTemporalReferences(): Array<string> {
  const hits: Array<string> = [];

  const files: Array<string> = [];
  for (const d of SCAN_DIRS) {
    walkTsFiles(join(REPO_ROOT, d), files);
  }
  files.push(join(REPO_ROOT, "package.json"));

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (EXCLUDED.has(rel)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded numeric index
      const line = lines[i]!;
      if (isTemporalModuleReference(line)) {
        hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return hits;
}

/** Gate entrypoint (the run_all.ts contract): 0 = clean, 1 = a reference reappeared. */
export function main(): number {
  const hits = scanRepoForTemporalReferences();
  if (hits.length === 0) {
    console.info("[INFO] no-temporal-imports: 0 @temporalio module references (the teardown holds)");
    return 0;
  }
  console.error(
    `[ERROR] no-temporal-imports: ${hits.length} @temporalio module reference(s) reappeared — ` +
      `Temporal was removed in the teardown and must not return:\n${hits.map((h) => `  ${h}`).join("\n")}`,
  );
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
