// Clock/Random seam gate (ts-morph port of the frozen Python gate vendor/codemaster-py/scripts/
// no_wall_clock.py).
//
// Per CLAUDE.md "Clock and Random Protocols": production code MUST use the injected Clock / Random
// seams (libs/platform/src/clock.ts + libs/platform/src/randomness.ts), never the raw platform
// equivalents. A raw `Date.now()` / `Math.random()` defeats deterministic replay (workflow sandbox)
// and seeded test reproducibility — the very property the seam exists to guarantee.
//
// Banned families + their sanctioned seams: clock reads (Date.now/new Date()/performance.now/
// process.hrtime) -> clock.ts; randomness (Math.random banned everywhere; node:crypto random) ->
// randomness.ts; wall-clock TIMERS (setTimeout/setInterval/AbortSignal.timeout) -> clock.ts (sleep)
// or transport_timeout.ts (HTTP abort). Timers were previously un-scanned despite the docstring
// claiming enforcement — that policy-vs-gate gap is now closed.
//
// AST-based (not regex): we walk CallExpression / NewExpression nodes, so a banned token appearing
// inside a comment or string literal does NOT false-match — the structural improvement over the
// Python regex gate this ports.
//
// Scope: PRODUCTION source only — `libs/*/src/**/*.ts` and `apps/*/src/**/*.ts` excluding
// `*.test.ts`. scripts/, test/, tools/, migrations/, vendor/ are NOT scanned: those legitimately use
// Date.now/crypto (e.g. check_exempted_rotation_age.ts uses Date.now for git-blame age computation).
//
// Mode: ERROR. Any banned construct outside the two sanctioned seam files returns 1.
import * as path from "node:path";

import { type CallExpression, Node, Project, type SourceFile, SyntaxKind } from "ts-morph";

/** Empty at landing — nothing legitimately needs a raw clock/random call outside the seams. Shape
 *  matches the sibling gates (check_tenant_scoped_raw_sql.ts) so the meta-gates
 *  (check_exempted_lists_pointed / check_exempted_rotation_age) walk it. New entries require a
 *  follow_up_story per S23.AR.17 P-2 rotation. */
export const EXEMPTED: Record<string, { follow_up_story: string }> = {};

/** Member-access clock calls (`Date.now()`, `performance.now()`) keyed by receiver -> method set. */
const CLOCK_MEMBER_CALLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Date", new Set(["now"])],
  ["performance", new Set(["now"])],
]);

/** Member-access random calls on `crypto` (the node:crypto namespace receiver). */
const CRYPTO_RANDOM_METHODS: ReadonlySet<string> = new Set([
  "randomBytes",
  "randomInt",
  "randomFillSync",
  "randomUUID",
  "getRandomValues",
]);

/** Bare-identifier random calls (`randomBytes(16)` after a named import from node:crypto). */
const CRYPTO_RANDOM_IDENTIFIERS: ReadonlySet<string> = CRYPTO_RANDOM_METHODS;

/** Timer primitives (`setTimeout`/`setInterval`/`AbortSignal.timeout`) defeat deterministic replay
 *  the same way a raw clock read does — banned outside the sanctioned timer seams. They are legitimate
 *  in the clock seam (`WallClock.sleep`) and the transport-timeout seam (HTTP abort timers). */
const TIMER_IDENTIFIERS: ReadonlySet<string> = new Set(["setTimeout", "setInterval"]);

/** The sanctioned seam files, by repo-relative POSIX path. */
const CLOCK_SEAM = "libs/platform/src/clock.ts";
const RANDOMNESS_SEAM = "libs/platform/src/randomness.ts";
const TRANSPORT_TIMEOUT_SEAM = "libs/platform/src/transport_timeout.ts";

/** Which family of constructs a file is allowed to use raw. */
type SeamKind = "clock" | "randomness" | "transport" | "none";

/** Timer primitives are allowed in the clock seam (sleep) and the transport-timeout seam (abort). */
function timersAllowed(seam: SeamKind): boolean {
  return seam === "clock" || seam === "transport";
}

/** A single banned-construct finding. */
export type Violation = {
  /** Repo-relative POSIX path of the offending file. */
  file: string;
  /** 1-based line number of the offending call. */
  line: number;
  /** Short construct label (e.g. "Date.now()", "Math.random()"). */
  construct: string;
};

/** Production source files the gate walks: {libs,apps}/&#42;/src/&#42;&#42;/&#42;.ts excluding *.test.ts. */
export function productionSourceFiles(project: Project): Array<SourceFile> {
  return project.getSourceFiles().filter((sf) => isProductionSource(sf.getFilePath()));
}

/** True iff `absPath` is a production source file under a libs/ or apps/ src tree (not a test). */
function isProductionSource(absPath: string): boolean {
  const rel = toRepoRelPosix(absPath);
  if (rel.endsWith(".test.ts")) return false;
  if (!rel.endsWith(".ts")) return false;
  // libs/<lib>/src/... or apps/<app>/src/... — at least one segment before `/src/`.
  return /^(?:libs|apps)\/[^/]+\/src\//.test(rel);
}

/**
 * Repo-relative POSIX path. Anchored on the `libs/` or `apps/` segment so the predicate is identical
 * for the real tree (absolute `/Users/.../apps/backend/src/...`), the ts-morph in-memory FS
 * (`/libs/foo/...`), and already-relative inputs — `process.cwd()` differs across those, the anchor
 * doesn't. Paths with neither segment fall back to cwd-relative; those are filtered out anyway.
 */
function toRepoRelPosix(absPath: string): string {
  const posix = absPath.split(path.sep).join("/");
  const match = /(?:^|\/)((?:libs|apps)\/.*)$/.exec(posix);
  if (match) return match[1]!;
  const rel = path.isAbsolute(absPath) ? path.relative(process.cwd(), absPath) : absPath;
  return rel.split(path.sep).join("/").replace(/^\.\//, "");
}

/** Map a file to the seam family whose raw constructs it is permitted to use. */
function seamKindFor(relPosix: string): SeamKind {
  if (relPosix === CLOCK_SEAM) return "clock";
  if (relPosix === RANDOMNESS_SEAM) return "randomness";
  if (relPosix === TRANSPORT_TIMEOUT_SEAM) return "transport";
  return "none";
}

/** Pure finder: every banned clock/random construct in production source outside its seam. */
export function findClockRandomViolations(project: Project): Array<Violation> {
  const out: Array<Violation> = [];
  for (const sf of productionSourceFiles(project)) {
    const rel = toRepoRelPosix(sf.getFilePath());
    const seam = seamKindFor(rel);
    collectFileViolations(sf, rel, seam, out);
  }
  return out;
}

function collectFileViolations(
  sf: SourceFile,
  rel: string,
  seam: SeamKind,
  out: Array<Violation>,
): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const construct = bannedCallConstruct(call, seam);
    if (construct !== null) out.push({ file: rel, line: call.getStartLineNumber(), construct });
  }
  for (const expr of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    // `new Date()` with ZERO args reads the wall clock; `new Date(arg)` parses a known instant (fine).
    if (
      Node.isIdentifier(expr.getExpression()) &&
      expr.getExpression().getText() === "Date" &&
      expr.getArguments().length === 0 &&
      seam !== "clock"
    ) {
      out.push({ file: rel, line: expr.getStartLineNumber(), construct: "new Date()" });
    }
  }
}

/**
 * Classify a CallExpression: return the banned-construct label if it reads a raw clock or random
 * source disallowed for this file's seam, else `null`.
 */
function bannedCallConstruct(call: CallExpression, seam: SeamKind): string | null {
  const expr = call.getExpression();

  // Member-access calls: <receiver>.<method>(...).
  if (Node.isPropertyAccessExpression(expr)) {
    const method = expr.getName();
    const receiver = expr.getExpression().getText();

    // process.hrtime(...) and process.hrtime.bigint() — both wall-clock reads.
    if (receiver === "process" && method === "hrtime") {
      return seam === "clock" ? null : "process.hrtime()";
    }
    if (receiver === "process.hrtime" && method === "bigint") {
      return seam === "clock" ? null : "process.hrtime.bigint()";
    }

    // Date.now() / performance.now() — wall-clock reads, allowed only in the clock seam.
    if (CLOCK_MEMBER_CALLS.get(receiver)?.has(method)) {
      return seam === "clock" ? null : `${receiver}.${method}()`;
    }

    // Math.random() — banned EVERYWHERE (no seam may use it; SystemRandom uses node:crypto and
    // SeededRandom is deterministic, so nothing legitimately needs Math.random).
    if (receiver === "Math" && method === "random") {
      return "Math.random()";
    }

    // crypto.<randomFn>() — node:crypto namespaced random, allowed only in the randomness seam.
    if (receiver === "crypto" && CRYPTO_RANDOM_METHODS.has(method)) {
      return seam === "randomness" ? null : `crypto.${method}()`;
    }

    // AbortSignal.timeout(ms) — a wall-clock timer, allowed only in the timer seams.
    if (receiver === "AbortSignal" && method === "timeout") {
      return timersAllowed(seam) ? null : "AbortSignal.timeout()";
    }
    return null;
  }

  // Bare-identifier calls: randomBytes(...) / setTimeout(...) etc.
  if (Node.isIdentifier(expr)) {
    const name = expr.getText();
    if (CRYPTO_RANDOM_IDENTIFIERS.has(name)) {
      return seam === "randomness" ? null : `${name}()`;
    }
    // setTimeout / setInterval — raw timer scheduling, allowed only in the timer seams.
    if (TIMER_IDENTIFIERS.has(name)) {
      return timersAllowed(seam) ? null : `${name}()`;
    }
  }
  return null;
}

/** CLI entry: emit H-16-format ERROR lines; return 1 on any violation (ERROR-mode). */
export function main(): number {
  const project = new Project({ tsConfigFilePath: "tsconfig.json" });
  const violations = findClockRandomViolations(project);

  if (violations.length === 0) {
    process.stdout.write("[INFO] no-wall-clock(ts): 0 violations\n");
    return 0;
  }

  for (const v of violations) {
    process.stderr.write(
      `[ERROR] file=${v.file}:${v.line} rule=clock_random ` +
        `message="${v.construct}: use injected Clock/Random from libs/platform" ` +
        'suggestion="import { WallClock } from libs/platform/src/clock.js / ' +
        'SystemRandom from randomness.js"\n',
    );
  }
  process.stderr.write(`[ERROR] no-wall-clock(ts): ${violations.length} violation(s)\n`);
  return 1; // ERROR-mode: block on any raw clock/random outside the seams.
}

// CLI shim: run main() when invoked directly (`npx tsx scripts/gates/check_clock_random.ts`).
// The aggregate runner (run_all.ts) imports main() instead, so this branch is dormant there.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
